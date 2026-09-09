import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { MAX_HP, SHELL_HEIGHT } from '../shared/constants.js';
import { isBush } from '../shared/map.js';
import { wrapAngle } from '../shared/sim.js';
import {
  bodyKick,
  bodyLean,
  DEBRIS_FIELD,
  DUST_FIELD,
  KICK_DECAY,
  ParticleField,
  trackAnchor,
  TrackMarks,
  WRECK_S,
  wreckSink,
} from './ground.js';
import {
  AMBIENT_INTENSITY,
  BLOOM_RADIUS,
  BLOOM_STRENGTH,
  BLOOM_THRESHOLD,
  BONUS_COLORS,
  COLOR_BOX,
  COLOR_CRATE,
  COLOR_GROUND,
  COLOR_HOUSE_WALL,
  COLOR_METAL,
  COLOR_ROOF,
  COLOR_TRACK,
  COLOR_WALL,
  EXPOSURE,
  FILL_INTENSITY,
  GLOW_BONUS,
  GLOW_BOOM,
  GLOW_KILL,
  GLOW_MUZZLE,
  GLOW_RICOCHET,
  GLOW_SHELL,
  GLOW_TRACER,
  LEAF_COLORS,
  PALETTE,
  SUN_INTENSITY,
} from './look.js';
import {
  buildTankGeometry,
  MUZZLE_TIP_Z,
  MUZZLE_Y,
  placeTrackLink,
  TRACK_LINK_COUNT,
  TRACK_SIDE,
  type TankGeometry,
  TURRET_Y,
} from './tank.js';
import {
  armorTexture,
  concreteTexture,
  crateTexture,
  groundTexture,
  houseWallTexture,
  scaleBoxUv,
} from './textures.js';
import { TOP_HEIGHT, TOP_ZOOM_SCALE, topFrustum, topParticleFov } from './topview.js';
import {
  BOOM_GROUND,
  BOOM_HIT,
  BOOM_KILL,
  BOOM_NEAR,
  BOOM_RICOCHET,
  type Box,
  type BoomKind,
  type SnapshotBonus,
} from '../shared/types.js';

// Палитра живёт в look.ts вместе со светом: стенд сверяет её с порогом свечения.
export { BONUS_COLORS } from './look.js';

/** На какой высоте висит ящик над землёй. */
const BONUS_HOVER = 1.7;

/**
 * Сколько метров занимает одна клетка текстуры. У земли крупнее: она видна
 * с высоты и почти в профиль, и мелкий рисунок на ней превращается в рябь.
 */
const GROUND_TILE = 9;
const BLOCK_TILE = 4;

/**
 * Разбивка «полных» укрытий по силуэту — чисто декоративная, идёт по форме
 * блока карты, а не по её смыслу: играть на решение это не влияет никак, оно
 * уже целиком закрыто высотой блока (`h >= SHELL_HEIGHT`).
 */
const HOUSE_FOOTPRINT = 10; // м; квадратный блок от этого размера — домик
const WALL_ASPECT = 2.2; // вытянутый блок остаётся стеной, а не домиком/ящиком
/** Один сегмент фаски: силуэт остаётся low-poly, но уходит ощущение «кубов». */
const OBSTACLE_BEVEL_SEGMENTS = 1;

/**
 * Куст — кластер мелких кубиков, а не плоская крашеная коробка (см. buildBush).
 * Высота чисто декоративная: физику низкого укрытия решает Box.h (в кустах,
 * где танк проезжает целиком, она даже не участвует в столкновении — см.
 * passableObstacles в map.ts), а кластер всегда поднимается заметно выше танка.
 */
const LEAF_CUBE = 1.4; // м, ребро кубика
const BUSH_HEIGHT = 3.2; // м, высота кластера
const BUSH_LAYERS = 3;
const LEAF_PALETTE = LEAF_COLORS.map((c) => new THREE.Color(c));

type BoxLook =
  | 'wall'
  | 'house'
  | 'warehouse'
  | 'tower'
  | 'guardhouse'
  | 'crate'
  | 'container'
  | 'barricade'
  | 'berm'
  | 'rock'
  | 'bush';

function boxLook(box: Box, mapId = 0): BoxLook {
  // Кусты определяются не вкусом рендера, а тем же правилом, что у сервера:
  // в них можно въехать, они прячут ботов и имеют свой кластер листвы.
  // Никакая карта и никакой визуальный архетип не должны это переопределять.
  if (isBush(box)) return 'bush';
  const aspect = Math.max(box.w, box.d) / Math.max(0.1, Math.min(box.w, box.d));
  const shortest = Math.min(box.w, box.d);
  const area = box.w * box.d;
  // На «Дюнах» и «Холмах» те же самые данные Box — это рельеф, а не дома.
  // Контекст карты даёт им каменный силуэт и не превращает скалы в сараи.
  if (mapId === 6 || mapId === 7) return box.h < SHELL_HEIGHT ? 'berm' : 'rock';
  if (box.h < SHELL_HEIGHT) {
    if (mapId === 4) return 'barricade';
    if (mapId === 5 || mapId === 9) return 'container';
    if (aspect >= 4) return 'barricade';
    if (shortest <= 5 && Math.max(box.w, box.d) >= 8) return 'container';
    if (area >= 70) return 'berm';
    return 'bush';
  }
  if (box.h >= 7 && aspect < 1.35) return 'tower';
  if (aspect >= WALL_ASPECT) return 'wall';
  if (aspect >= 1.45 || area >= 190) return 'warehouse';
  if (shortest >= HOUSE_FOOTPRINT) return 'house';
  return shortest >= 6 ? 'guardhouse' : 'crate';
}

/**
 * Декоративная форма препятствия. Коллизии по-прежнему считают исходный Box,
 * поэтому фаски не меняют проезды и прострелы — это только более живой силуэт.
 */
function obstacleGeometry(box: Box, look: BoxLook): THREE.BufferGeometry {
  const shortest = Math.min(box.w, box.h, box.d);
  const bevel = Math.min(shortest * 0.16, look === 'wall' || look === 'barricade' ? 0.38 : 0.3);
  return new RoundedBoxGeometry(
    box.w,
    box.h,
    box.d,
    OBSTACLE_BEVEL_SEGMENTS,
    Math.max(0.08, bevel),
  );
}

/** Группа деталей, которые сливаются в несколько мешей на всю карту. */
interface DecorBatch {
  roof: THREE.BufferGeometry[];
  trim: THREE.BufferGeometry[];
  windows: THREE.BufferGeometry[];
  doors: THREE.BufferGeometry[];
  rocks: THREE.BufferGeometry[];
}

function createDecorBatch(): DecorBatch {
  return { roof: [], trim: [], windows: [], doors: [], rocks: [] };
}

function worldBox(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BoxGeometry {
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.translate(x, y, z);
  return geometry;
}

/** Двускатная крыша — настоящая призма с коньком, а не пирамидальная крышка. */
function gableRoof(width: number, depth: number, height: number): THREE.BufferGeometry {
  const hw = width / 2;
  const hd = depth / 2;
  const hh = height / 2;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([
      -hw, -hh, -hd, hw, -hh, -hd, 0, hh, -hd,
      -hw, -hh, hd, hw, -hh, hd, 0, hh, hd,
    ], 3),
  );
  geometry.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute([
      0, 0, 1, 0, 0.5, 1,
      0, 0, 1, 0, 0.5, 1,
    ], 2),
  );
  geometry.setIndex([
    // Торцы и оба наружных ската. Дна здесь намеренно нет: оно лежало бы
    // в точности на верхней грани корпуса дома (y = box.h) и давало бы
    // z-fighting — мерцание/рваные пятна на крыше при движении камеры.
    0, 2, 1, 3, 4, 5,
    0, 3, 5, 0, 5, 2,
    1, 5, 4, 1, 2, 5,
  ]);
  geometry.computeVertexNormals();
  return geometry;
}

function addGable(
  batch: DecorBatch,
  box: Box,
  roofHeight: number,
  ridgeAlongX: boolean,
): void {
  const geometry = gableRoof(
    ridgeAlongX ? box.d * 1.12 : box.w * 1.12,
    ridgeAlongX ? box.w * 1.12 : box.d * 1.12,
    roofHeight,
  );
  if (ridgeAlongX) geometry.rotateY(Math.PI / 2);
  geometry.translate(box.x, box.h + roofHeight / 2, box.z);
  batch.roof.push(geometry);
}

/** Повторяемый, но стабильный вариант объекта — без прыжков картинки между заходами. */
function boxVariant(box: Box): number {
  return (Math.abs(Math.round(box.x * 17 + box.z * 31 + box.w * 7 + box.d * 13)) >>> 0) % 4;
}

const CAMERA_DISTANCE = 15;
const CAMERA_BASE_HEIGHT = 3.4;

/**
 * Вынос камеры от первого лица вперёд по стволу, м. Совсем небольшой — камера
 * сидит на башне, а не едет по стволу вперёд: слишком большой вынос на
 * высоте ствола утыкал камеру прямо в казённик/маску пушки.
 */
const FPV_FORWARD = 0.4;
/**
 * Высота камеры от первого лица: заметно выше оси ствола — как будто сидишь
 * в открытом люке командирской башенки, а не лежишь щекой на казённике.
 */
const FPV_HEIGHT = TURRET_Y + 1.3;
/** Насколько далеко вынесена точка, куда смотрит камера от первого лица — далеко за горизонт, важно только направление. */
const FPV_LOOK = 60;

/** Высота, на которой висит ник над центром танка. */
const LABEL_HEIGHT = 3.7;
/** Дальше этого ники не рисуем — всё равно нечитаемо, а DOM грузится. */
const LABEL_MAX_DISTANCE = 160;

/**
 * Как выглядит вспышка: radius — размер шара, life — сколько живёт, ring — кольцо
 * по земле, cone — длина направленного языка пламени, rise — с какой скоростью
 * всплывает (для дыма), grow — насколько разрастается, alpha — стартовая плотность.
 */
interface EffectPreset {
  radius: number;
  life: number;
  color: number;
  ring?: boolean;
  cone?: number;
  rise?: number;
  grow?: number;
  alpha?: number;
  /**
   * Во сколько раз цвет поднят над обычным диапазоном. Всё, что больше единицы,
   * перешагивает порог свечения; единица — «не светится», для дыма.
   */
  glow?: number;
}

const BOOM_PRESETS: Record<BoomKind, EffectPreset> = {
  [BOOM_GROUND]: { radius: 1.6, life: 0.34, color: 0xffb257, glow: GLOW_BOOM },
  [BOOM_HIT]: { radius: 2.2, life: 0.4, color: 0xffd27a, glow: GLOW_BOOM },
  [BOOM_KILL]: { radius: 4.2, life: 0.75, color: 0xff8a3c, ring: true, glow: GLOW_KILL },
  // Рикошет — короткая белая искра: снаряд жив и полетел дальше, взрыва не было.
  [BOOM_RICOCHET]: { radius: 0.9, life: 0.16, color: 0xfff4c8, glow: GLOW_RICOCHET },
  // Близкий разрыв: не огонь, а холодная короткая вспышка воздуха рядом с бортом.
  [BOOM_NEAR]: { radius: 1.1, life: 0.18, color: 0xd8e6ff, glow: GLOW_RICOCHET },
};

/** На какой высоте рвануло: у земли, по корпусу танка или на высоте полёта снаряда. */
const BOOM_HEIGHT: Record<BoomKind, number> = {
  [BOOM_GROUND]: 0.6,
  [BOOM_HIT]: 1.4,
  [BOOM_KILL]: 1.4,
  [BOOM_RICOCHET]: SHELL_HEIGHT,
  [BOOM_NEAR]: SHELL_HEIGHT,
};

/**
 * Вспышка у дульного среза. Она короче любого взрыва — её задача не «гореть»,
 * а отметить кадр выстрела: длинный факел смазывается в кашу и читается как взрыв.
 */
const MUZZLE_PRESET: EffectPreset = {
  radius: 0.85,
  life: 0.085,
  color: 0xfff3d0,
  cone: 4,
  glow: GLOW_MUZZLE,
};

/**
 * Дым от выстрела: всплывает и расплывается. Держим его редким и небольшим —
 * своя пушка стоит прямо на линии взгляда, и плотное облако закрывало бы цель
 * ровно на перезарядку.
 */
const MUZZLE_SMOKE: EffectPreset = {
  radius: 0.85,
  life: 0.7,
  color: 0x7d7568,
  rise: 1.3,
  grow: 2,
  alpha: 0.26,
};

/** Длина трассера за снарядом, м. */
export const TRACER_LENGTH = 6;

// --- Отдача ствола ---

/** На сколько метров ствол уходит назад в момент выстрела. */
const RECOIL_BACK = 0.62;
/** Скорость возврата: ствол откатывается рывком, а выходит обратно плавно. */
const RECOIL_RETURN = 8;

/**
 * Высота центра, вокруг которого верх танка качается на подвеске. Корпус не
 * вращается вокруг самой земли: так при крене он выглядит опёртым на ходовую,
 * а не воткнутым в асфальт носом или бортом.
 */
const SUSPENSION_PIVOT_Y = 0.78;

// --- Тряска камеры ---

/**
 * Тряска живёт одним числом «встряски» 0..1, которое затухает. Сила берётся как
 * его квадрат: близкие мелкие толчки тогда почти не мешают целиться, а прилетевший
 * в упор фугас встряхивает по-настоящему.
 */
const SHAKE_DECAY = 2.6;
const SHAKE_AMPLITUDE = 0.95;
const SHAKE_FREQ = 21;

// --- Ходовая: крен, следы, пыль ---

/** Скорость подхода к целевому наклону корпуса. */
const LEAN_RATE = 9;
/** Держит зазор между качающимся корпусом и неподвижной ходовой. */
const SUSPENSION_AMPLITUDE = 0.78;

/**
 * Толчок корпуса, рад: от своего выстрела и от прилетевшего снаряда. Оба заметно
 * меньше LEAN_MAX (~6°): это удар, а не поза, и он должен читаться как вздрагивание,
 * а не как отдельное положение танка.
 */
const SHOT_KICK = 0.045;
const HIT_KICK = 0.06;
/**
 * Дальше этого взрыв ни с каким танком не связывается. Снаряд рвётся на границе
 * круга цели — в 2.7 м от центра, — так что порог только отсекает взрывы о землю
 * и стены рядом с танком, а не ищет цель по-настоящему.
 */
const HIT_KICK_RANGE = 4;

/** Через сколько метров пути кладётся новый отпечаток. */
const TRACK_STEP = 0.85;
/** Через сколько метров вылетает пылинка и с какой скорости начинается пыль. */
const DUST_STEP = 2;
const DUST_MIN_SPEED = 5;

/**
 * Скачок больше этого за кадр — это респавн или смена карты, а не езда.
 * Без отсечки телепорт через полкарты давал бы «скорость» в сотни м/с,
 * танк складывался бы пополам, а по всей карте протягивался бы след.
 */
const TELEPORT_STEP = 4;

// --- Гибель танка ---

/** Дым горящего остова: тёмный, крупный, медленно всплывает. */
const WRECK_SMOKE: EffectPreset = {
  radius: 1.9,
  life: 1.5,
  color: 0x36322c,
  rise: 2.1,
  grow: 2.4,
  alpha: 0.5,
};

/** Как часто остов выбрасывает клуб дыма, с. */
const WRECK_SMOKE_EVERY = 0.26;
/** Сколько обломков разлетается в момент гибели. */
const WRECK_DEBRIS = 16;
/** Во сколько раз темнеет краска корпуса на подбитом танке. */
const WRECK_DARKEN = 0.22;
/** Крен и клевок, в которых остов замирает: подбитый танк стоит криво. */
const WRECK_ROLL = 0.13;
const WRECK_PITCH = -0.07;

export interface TankHandle {
  root: THREE.Group;
  /**
   * Верхняя масса: корпус, броня и башня. Отдельный узел внутри root нужен,
   * чтобы крен и клевок жили в осях самого танка, не передаваясь гусеницам.
   * root уже повёрнут по курсу, поэтому наклон в его системе не смешивается
   * с поворотом по курсу.
   */
  body: THREE.Group;
  /** Ходовая сидит прямо на root: при живом танке она всегда остаётся на земле. */
  runningGear: THREE.Group;
  turret: THREE.Group;
  /** Ствол ходит отдельно от башни: по нему играется откат. */
  barrel: THREE.Mesh;
  /** Два InstancedMesh настоящих звеньев: левый и правый трак. */
  trackLinks: readonly THREE.InstancedMesh[];
  /** Остаток отката, 1 в момент выстрела и 0 в покое. */
  recoil: number;
  /** Прошлое положение: по нему считаются скорость и поворот за кадр. */
  lastX: number;
  lastZ: number;
  lastYaw: number;
  speed: number;
  roll: number;
  pitch: number;
  /**
   * Толчок от выстрела или попадания. Живёт отдельно от ходового крена и
   * складывается с ним: крен — это положение корпуса на подвеске, толчок —
   * удар поверх него, со своим затуханием.
   */
  kickRoll: number;
  kickPitch: number;
  /** Пройденный путь с прошлого отпечатка и с прошлой пылинки, м. */
  trackDistance: number;
  dustDistance: number;
  /** Пробег правой и левой ленты: на развороте они едут в разные стороны. */
  treadPhase: [number, number];
  /** Краска корпуса этого танка: на время гибели темнеет до копоти. */
  paint: THREE.MeshStandardMaterial;
  /** Исходный цвет краски, чтобы вернуть его при возрождении. */
  paintColor: number;
  /** Сколько секунд идёт гибель; -1 — танк не подбит. */
  dying: number;
  /**
   * Рисовали ли мы этот танк хоть раз. В режиме волн павшие ждут конца волны,
   * поэтому зашедший в середине волны получает их первым же снапшотом уже
   * подбитыми — без этой отметки на него разом посыпались бы чужие взрывы.
   */
  everSeen: boolean;
  /** Когда остов выбросит следующий клуб дыма, в секундах от начала гибели. */
  smokeAt: number;
  label: HTMLElement;
  hpFill: HTMLElement;
  /** Размеры подписи в пикселях, замеряются один раз — текст не меняется. */
  labelHalfWidth: number;
  labelHeight: number;
  labelVisible: boolean;
  /**
   * Разрешает ли подпись сам режим боя. В аркаде подписаны все, в реалистичных
   * правилах — только товарищи. Флаг ставит main.ts, потому что «товарищ» —
   * это про команды и режим комнаты, а рендер про них ничего не знает.
   */
  plated: boolean;
  /** Подбитый танк не рисуется и не подписывается. */
  alive: boolean;
  /** Под «Маскировкой» и достаточно далеко: корпус и подпись не рисуются. */
  cloaked: boolean;
  hp: number;
}

interface ShellHandle {
  /** Снаряд и его трассер ездят вместе, поэтому это группа, а не меш. */
  group: THREE.Group;
  /** Хвост меняет длину у самого дула, чтобы не проходить сквозь ствол. */
  tracer: THREE.Mesh;
  /** Помечается каждый кадр: непомеченные снаряды сервер больше не присылает. */
  seen: boolean;
}

interface Effect {
  group: THREE.Group;
  flash: THREE.Mesh;
  ring: THREE.Mesh;
  /** Направленный язык пламени; у взрывов выключен. */
  cone: THREE.Mesh;
  life: number;
  duration: number;
  radius: number;
  rise: number;
  grow: number;
  alpha: number;
}

export class Scene3D {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  /**
   * Камера вида сверху. Проекция именно ортографическая, а не «перспектива с
   * большой высоты»: у края экрана танк тогда виден строго так же, как в центре,
   * и по картинке можно судить о расстояниях — а на телефоне только по ней и судят.
   */
  private readonly topCamera: THREE.OrthographicCamera;

  /** Через какую камеру сейчас смотрим: с неё же считаются ники и метка прицела. */
  private active: THREE.PerspectiveCamera | THREE.OrthographicCamera;

  /** Сколько метров видно вокруг танка по короткой стороне экрана. */
  private topRadius = CAMERA_DISTANCE * TOP_ZOOM_SCALE;

  /** Земля, стены и блоки текущей карты: при смене карты группа собирается заново. */
  private readonly world = new THREE.Group();

  /** Следы гусениц, пыль и обломки: живут отдельно от карты, но чистятся с ней. */
  private readonly tracks = new TrackMarks();
  private readonly dust = new ParticleField(DUST_FIELD);
  private readonly debris = new ParticleField(DEBRIS_FIELD);
  /** Часы сцены в секундах: по ним шейдеры считают возраст следов и пылинок. */
  private clock = 0;

  /**
   * Текстуры рисуются один раз на всю игру, а не на карту: при смене карты
   * материалы пересоздаются, и текстура на каждую карту утекала бы в видеопамять.
   */
  private readonly groundMap: THREE.CanvasTexture;
  private readonly concreteMap: THREE.CanvasTexture;
  private readonly armorMap: THREE.CanvasTexture;
  private readonly houseWallMap: THREE.CanvasTexture;
  private readonly crateMap: THREE.CanvasTexture;

  /** Геометрия танка: общая на всех, разница между танками только в цвете. */
  private readonly tankGeo: TankGeometry = buildTankGeometry();

  private readonly renderer: THREE.WebGLRenderer;
  private readonly tanks = new Map<number, TankHandle>();
  private readonly shells = new Map<number, ShellHandle>();
  private readonly shellPool: THREE.Group[] = [];
  private readonly effects: Effect[] = [];
  private readonly effectPool: Effect[] = [];

  /** Переиспользуемые буферы — чтобы не мусорить в куче каждый кадр. */
  private readonly projected = new THREE.Vector3();
  private viewWidth = 1;
  private viewHeight = 1;

  /** Геометрии переиспользуются всеми танками — их много, а форма одна. */
  private readonly geo = {
    shell: new THREE.CapsuleGeometry(0.16, 0.7, 4, 8),
    flash: new THREE.SphereGeometry(1, 12, 10),
    ring: new THREE.RingGeometry(0.72, 1, 28),
    bonus: new THREE.BoxGeometry(1.7, 1.7, 1.7),
    // Оба конуса единичной высоты и без донышка: длину задаёт масштаб, а крышка
    // светящегося конуса выглядела бы как приклеенный к снаряду диск.
    cone: new THREE.ConeGeometry(0.5, 1, 10, 1, true),
    tracer: new THREE.ConeGeometry(0.32, 1, 8, 1, true),
  };

  /** Цвет ящика по виду бонуса: тот же порядок, что и в BONUS_NAMES. */
  private readonly bonusMaterials = BONUS_COLORS.map(
    (color) =>
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        // Выше единицы вместе с собственным цветом ящика: ящик должен светиться
        // и находиться взглядом на пёстрой карте, а не просто быть ярким.
        emissiveIntensity: GLOW_BONUS,
        roughness: 0.4,
        metalness: 0.1,
      }),
  );

  private readonly bonuses = new Map<number, { mesh: THREE.Mesh; seen: boolean }>();
  /** Общая фаза вращения ящиков — чтобы они крутились в такт, а не вразнобой. */
  private bonusSpin = 0;

  /**
   * Снаряд светится сам: он мелкий и должен читаться на любом фоне. Цвет поднят
   * за единицу — это и делает его светящимся, а не просто ярко-жёлтым.
   */
  private readonly shellMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0xffd27a).multiplyScalar(GLOW_SHELL),
  });

  /**
   * Трассер складывается со светом сцены, а не перекрывает его, и не пишет в
   * буфер глубины: иначе полупрозрачный хвост вырезал бы дыру в том, что за ним.
   */
  private readonly tracerMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0xff9d3a).multiplyScalar(GLOW_TRACER),
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  private readonly trackMaterial = new THREE.MeshStandardMaterial({
    color: COLOR_TRACK,
    roughness: 0.95,
    flatShading: true,
  });
  /** Катки светлее ленты: иначе на тёмной ходовой они теряют форму. */
  private readonly wheelMaterial = new THREE.MeshStandardMaterial({
    color: 0x68707a,
    roughness: 0.72,
    metalness: 0.32,
    flatShading: true,
  });
  private readonly metalMaterial = new THREE.MeshStandardMaterial({
    color: COLOR_METAL,
    roughness: 0.6,
    metalness: 0.25,
    flatShading: true,
  });

  /**
   * Цепочка постобработки для свечения. Держится собранной всегда, но при
   * выключенном свечении не используется: сборка её на лету означала бы
   * перекомпиляцию шейдеров и заметный рывок прямо в бою.
   */
  private readonly composer: EffectComposer;
  /** Держим отдельно: при смене вида проходу надо подсунуть другую камеру. */
  private readonly renderPass: RenderPass;
  private readonly bloomPass: UnrealBloomPass;
  private bloomOn = true;

  private readonly cameraTarget = new THREE.Vector3();
  private cameraReady = false;
  /**
   * Сглаженная высота камеры держится отдельно от camera.position.y: тряска пишет
   * в позицию, и если бы догонялка читала её же, камера гонялась бы за собственным
   * дрожанием и всплывала вверх на каждом залпе.
   */
  private cameraHeight = 0;
  private trauma = 0;
  private shakeTime = 0;

  /**
   * По одному InstancedMesh на куст, в том же порядке, что и bushBoxes() —
   * см. setActiveBush: прятать нужно не листву вообще, а ровно тот куст,
   * внутри которого сейчас камера. Полупрозрачность тут не годится: изнутри
   * густого куста луч взгляда проходит через десяток кубиков подряд, и даже
   * лёгкая полупрозрачность каждого в сумме всё равно даёт почти сплошную
   * стену — работает только полное скрытие одного, самого мешающего куста.
   */
  private bushMeshes: THREE.InstancedMesh[] = [];
  private activeBush = -1;

  /** Рабочие векторы для дульной вспышки: считается она несколько раз в секунду. */
  private readonly muzzlePoint = new THREE.Vector3();
  /** Общая болванка матрицы: ей расставляем звенья без аллокаций каждый кадр. */
  private readonly trackLinkDummy = new THREE.Object3D();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly labelContainer: HTMLElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.5, 600);
    this.camera.position.set(0, 20, -30);

    // Границы кадра задаст resize; дальняя плоскость с запасом на всю высоту.
    this.topCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, TOP_HEIGHT * 2);
    // Верх экрана — север карты (-Z), право — +X. Именно этот up развернёт кадр
    // так, чтобы движение вправо по экрану было движением в +X, а не зеркалом.
    this.topCamera.up.set(0, 0, -1);
    this.active = this.camera;

    this.scene.background = new THREE.Color(0x121822);
    // Ближняя граница вынесена за игровую зону (карта 140 м в поперечнике), чтобы туман
    // не съедал поле, но дальняя стена через всю карту уже заметно подёрнута дымкой.
    this.scene.fog = new THREE.Fog(0x121822, 110, 300);

    this.groundMap = groundTexture(this.renderer);
    this.concreteMap = concreteTexture(this.renderer);
    this.armorMap = armorTexture(this.renderer);
    this.houseWallMap = houseWallTexture(this.renderer);
    this.crateMap = crateTexture(this.renderer);

    // Цвет копится в полуплавающей точке: свечению нужны значения ярче единицы,
    // а в обычные 8 бит на канал они бы срезались ещё до размытия.
    this.composer = new EffectComposer(
      this.renderer,
      new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }),
    );
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    this.composer.addPass(this.bloomPass);
    // Тонмаппинг и перевод в sRGB делает последний проход: при рендере в буфер
    // three их пропускает, и без OutputPass картинка вышла бы пересвеченной.
    this.composer.addPass(new OutputPass());

    this.scene.add(this.world);
    this.scene.add(this.tracks.mesh);
    this.scene.add(this.dust.points);
    this.scene.add(this.debris.points);
    this.setupLights();
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  private setupLights(): void {
    // Небо сверху, отражённый от земли свет снизу: именно он вытягивает тени из черноты.
    this.scene.add(new THREE.HemisphereLight(0x9fb8d8, 0x4a4f3e, AMBIENT_INTENSITY));

    // Слабый контровой свет с противоположной стороны — без него теневой борт танка
    // сливается в один тёмный силуэт.
    const fill = new THREE.DirectionalLight(0xbfd4ea, FILL_INTENSITY);
    fill.position.set(-70, 45, -55);
    this.scene.add(fill);

    const sun = new THREE.DirectionalLight(0xffe6bd, SUN_INTENSITY);
    sun.position.set(60, 95, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -110;
    sun.shadow.camera.right = 110;
    sun.shadow.camera.top = 110;
    sun.shadow.camera.bottom = -110;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 260;
    sun.shadow.bias = -0.0006;
    this.scene.add(sun);
  }

  /**
   * Строит землю, стены по периметру и препятствия, присланные сервером.
   * Вызывается заново при смене карты, поэтому вся геометрия мира живёт в одной
   * группе: старую снимаем целиком и освобождаем её буферы, иначе смена карты
   * оставляла бы прошлые блоки и в сцене, и в видеопамяти.
   */
  buildWorld(half: number, obstacles: Box[], mapId = 0): void {
    this.clearWorld();
    // Следы, пыль и обломки от прошлой карты к новой отношения не имеют.
    this.tracks.clear();
    this.dust.clear();
    this.debris.clear();

    const groundSize = half * 6;
    // Текстура повторяется клеткой в GROUND_TILE метров: у плоскости развёртка
    // одна на всю ширину, и без повтора крупа растянулась бы на 840 м в пятно.
    this.groundMap.repeat.set(groundSize / GROUND_TILE, groundSize / GROUND_TILE);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(groundSize, groundSize),
      new THREE.MeshStandardMaterial({
        color: COLOR_GROUND,
        roughness: 1,
        map: this.groundMap,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.world.add(ground);

    const grid = new THREE.GridHelper(half * 2, half / 2.5, 0x5c6b52, 0x475040);
    grid.position.y = 0.02;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    this.world.add(grid);

    const wallMaterial = new THREE.MeshStandardMaterial({
      color: COLOR_WALL,
      roughness: 0.9,
      map: this.concreteMap,
      flatShading: true,
    });
    const wallHeight = 4;
    const thickness = 2;
    const span = half * 2 + thickness * 2;
    const walls: Array<[number, number, number, number]> = [
      [0, half + thickness / 2, span, thickness],
      [0, -half - thickness / 2, span, thickness],
      [half + thickness / 2, 0, thickness, span],
      [-half - thickness / 2, 0, thickness, span],
    ];
    for (const [x, z, w, d] of walls) {
      const geometry = obstacleGeometry({ x: 0, z: 0, w, d, h: wallHeight }, 'wall');
      scaleBoxUv(geometry, w, wallHeight, d, BLOCK_TILE);
      const wall = new THREE.Mesh(geometry, wallMaterial);
      wall.position.set(x, wallHeight / 2, z);
      wall.castShadow = true;
      wall.receiveShadow = true;
      this.world.add(wall);
    }

    const wallBoxMaterial = new THREE.MeshStandardMaterial({
      color: COLOR_BOX,
      roughness: 0.85,
      map: this.concreteMap,
      flatShading: true,
    });
    const houseMaterial = new THREE.MeshStandardMaterial({
      color: COLOR_HOUSE_WALL,
      roughness: 0.8,
      map: this.houseWallMap,
      flatShading: true,
    });
    const crateMaterial = new THREE.MeshStandardMaterial({
      color: COLOR_CRATE,
      roughness: 0.9,
      map: this.crateMap,
      flatShading: true,
    });
    const roofMaterial = new THREE.MeshStandardMaterial({
      color: COLOR_ROOF,
      roughness: 0.95,
      flatShading: true,
    });
    const trimMaterial = new THREE.MeshStandardMaterial({
      color: COLOR_METAL,
      roughness: 0.82,
      metalness: 0.18,
      flatShading: true,
    });
    const windowMaterial = new THREE.MeshStandardMaterial({
      color: 0x1d2934,
      emissive: 0x071018,
      emissiveIntensity: 0.35,
      roughness: 0.35,
      metalness: 0.35,
      flatShading: true,
    });
    const doorMaterial = new THREE.MeshStandardMaterial({
      color: 0x302d29,
      roughness: 0.9,
      flatShading: true,
    });
    const rockMaterial = new THREE.MeshStandardMaterial({
      color: COLOR_BOX,
      roughness: 1,
      flatShading: true,
    });
    // Куст — кластер мелких кубиков (см. buildBush), не крашеная коробка: своя
    // геометрия и материал на кубик, отдельно от «полных» укрытий ниже.
    const leafGeometry = new THREE.BoxGeometry(LEAF_CUBE, LEAF_CUBE, LEAF_CUBE);
    const leafMaterial = new THREE.MeshStandardMaterial({ roughness: 1 });
    this.bushMeshes = [];
    this.activeBush = -1;
    const decor = createDecorBatch();
    for (const box of obstacles) {
      const look = boxLook(box, mapId);
      if (look === 'bush') {
        this.buildBush(box, leafGeometry, leafMaterial);
        continue;
      }

      // Градирня и каменные гряды получают собственный силуэт, а не очередной
      // скруглённый куб. Остальные типы держат физический Box как основу и
      // обрастают фасадом/крышей/обвязкой через общий пакет деталей ниже.
      if (look === 'tower') {
        this.buildTower(box, wallBoxMaterial, roofMaterial, trimMaterial);
        continue;
      }
      if (look === 'berm' || look === 'rock') {
        this.buildBerm(box, decor);
        continue;
      }

      const material =
        look === 'house' || look === 'guardhouse'
          ? houseMaterial
          : look === 'crate' || look === 'container'
            ? crateMaterial
            : wallBoxMaterial;
      const geometry = obstacleGeometry(box, look);
      // Развёртка правится на геометрии, а не отдельным материалом на блок:
      // блоков на карте под сотню, и сотня материалов — это сотня шейдеров.
      scaleBoxUv(geometry, box.w, box.h, box.d, BLOCK_TILE);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(box.x, box.h / 2, box.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.world.add(mesh);
      this.decorateObstacle(box, look, decor);
    }
    this.flushDecor(decor, roofMaterial, trimMaterial, windowMaterial, doorMaterial, rockMaterial);
  }

  /**
   * Небольшая библиотека фасадов. Все элементы добавляются в общий batch и
   * сливаются ниже: детализации стало больше, но карта не получает сотни
   * отдельных draw call.
   */
  private decorateObstacle(box: Box, look: Exclude<BoxLook, 'bush' | 'tower' | 'berm' | 'rock'>, batch: DecorBatch): void {
    const frontZ = box.z + box.d / 2 + 0.055;
    const backZ = box.z - box.d / 2 - 0.055;
    const rightX = box.x + box.w / 2 + 0.055;
    const variant = boxVariant(box);

    if (look === 'house' || look === 'guardhouse') {
      const roofHeight = Math.min(3.4, Math.max(1.25, Math.min(box.w, box.d) * 0.22));
      const ridgeAlongX = box.w >= box.d;
      addGable(batch, box, roofHeight, ridgeAlongX);

      // Конёк, труба и угловые планки: сверху дом читается не плоским пятном.
      batch.trim.push(
        worldBox(
          ridgeAlongX ? box.w * 0.96 : 0.16,
          0.13,
          ridgeAlongX ? 0.16 : box.d * 0.96,
          box.x,
          box.h + roofHeight + 0.02,
          box.z,
        ),
        worldBox(0.32, 0.85, 0.32, box.x + (variant < 2 ? -1 : 1) * box.w * 0.24, box.h + roofHeight + 0.36, box.z - box.d * 0.18),
      );
      for (const sx of [-1, 1]) {
        batch.trim.push(worldBox(0.13, Math.min(box.h * 0.8, 3), 0.13, box.x + sx * (box.w / 2 - 0.18), Math.min(box.h * 0.4, 1.5), frontZ));
      }

      // Обычная входная дверь, не ворота склада: фасад дома должен читаться
      // в одном масштабе с одиночными геометрическими окнами.
      const doorW = Math.min(1.35, box.w * 0.18);
      const doorH = Math.min(2.15, box.h * 0.52);
      batch.doors.push(worldBox(doorW, doorH, 0.08, box.x, doorH / 2, frontZ));
      const windowW = Math.min(1.5, box.w * 0.18);
      const windowH = Math.min(1.25, box.h * 0.3);
      for (const sx of [-1, 1]) {
        batch.windows.push(worldBox(windowW, windowH, 0.06, box.x + sx * box.w * 0.3, box.h * 0.58, frontZ));
        batch.windows.push(worldBox(windowW, windowH, 0.06, box.x + sx * box.w * 0.25, box.h * 0.58, backZ));
      }
      return;
    }

    if (look === 'warehouse') {
      const roofHeight = Math.min(3.1, Math.max(1.1, Math.min(box.w, box.d) * 0.16));
      const ridgeAlongX = box.w >= box.d;
      addGable(batch, box, roofHeight, ridgeAlongX);
      // Вентиляционные фонари на крыше и рёбра: это уже цех/склад, не домик.
      const vents = Math.max(2, Math.floor(Math.max(box.w, box.d) / 10));
      for (let i = 0; i < vents; i++) {
        const t = vents === 1 ? 0 : i / (vents - 1) - 0.5;
        const x = ridgeAlongX ? box.x + t * box.w * 0.55 : box.x;
        const z = ridgeAlongX ? box.z : box.z + t * box.d * 0.55;
        batch.trim.push(worldBox(ridgeAlongX ? 0.7 : 1.3, 0.35, ridgeAlongX ? 1.3 : 0.7, x, box.h + roofHeight + 0.17, z));
      }
      if (ridgeAlongX) {
        const gateW = Math.min(box.w * 0.42, 6);
        const gateH = Math.min(box.h * 0.72, 4);
        batch.doors.push(worldBox(gateW, gateH, 0.1, box.x, gateH / 2, frontZ));
        for (let x = box.x - box.w * 0.42; x <= box.x + box.w * 0.42; x += 3.5) {
          batch.trim.push(worldBox(0.15, box.h * 0.9, 0.12, x, box.h * 0.45, frontZ + 0.025));
        }
      } else {
        const gateD = Math.min(box.d * 0.42, 6);
        const gateH = Math.min(box.h * 0.72, 4);
        batch.doors.push(worldBox(0.1, gateH, gateD, rightX, gateH / 2, box.z));
        for (let z = box.z - box.d * 0.42; z <= box.z + box.d * 0.42; z += 3.5) {
          batch.trim.push(worldBox(0.12, box.h * 0.9, 0.15, rightX + 0.025, box.h * 0.45, z));
        }
      }
      return;
    }

    if (look === 'wall' || look === 'barricade') {
      const longX = box.w >= box.d;
      const length = Math.max(box.w, box.d);
      const posts = Math.max(2, Math.ceil(length / 7));
      batch.trim.push(worldBox(box.w + 0.18, 0.16, box.d + 0.18, box.x, box.h + 0.08, box.z));
      for (let i = 0; i <= posts; i++) {
        const t = i / posts - 0.5;
        const x = longX ? box.x + t * box.w : box.x;
        const z = longX ? box.z : box.z + t * box.d;
        batch.trim.push(worldBox(longX ? 0.24 : box.w + 0.12, box.h + 0.18, longX ? box.d + 0.12 : 0.24, x, box.h / 2, z));
      }
      return;
    }

    if (look === 'container') {
      const longX = box.w >= box.d;
      const length = Math.max(box.w, box.d);
      const ribs = Math.max(3, Math.floor(length / 1.6));
      for (let i = 0; i <= ribs; i++) {
        const t = i / ribs - 0.5;
        const x = longX ? box.x + t * box.w : box.x;
        const z = longX ? box.z : box.z + t * box.d;
        batch.trim.push(worldBox(longX ? 0.08 : box.w + 0.1, box.h * 0.88, longX ? box.d + 0.1 : 0.08, x, box.h * 0.48, z));
      }
      // Двустворчатая дверь на торце контейнера.
      if (longX) {
        batch.doors.push(worldBox(0.07, box.h * 0.78, box.d * 0.37, rightX, box.h * 0.43, box.z - box.d * 0.22));
        batch.doors.push(worldBox(0.07, box.h * 0.78, box.d * 0.37, rightX, box.h * 0.43, box.z + box.d * 0.22));
      } else {
        batch.doors.push(worldBox(box.w * 0.37, box.h * 0.78, 0.07, box.x - box.w * 0.22, box.h * 0.43, frontZ));
        batch.doors.push(worldBox(box.w * 0.37, box.h * 0.78, 0.07, box.x + box.w * 0.22, box.h * 0.43, frontZ));
      }
      return;
    }

    // Ящик/тумба: уголки и перекрёстные ремни ломают идеальную плоскость граней.
    const strapY = box.h * 0.58;
    batch.trim.push(
      worldBox(box.w + 0.12, 0.12, 0.12, box.x, strapY, frontZ),
      worldBox(0.12, 0.12, box.d + 0.12, rightX, strapY, box.z),
      worldBox(box.w * 0.7, 0.1, box.d * 0.7, box.x, box.h + 0.06, box.z),
    );
  }

  /**
   * Высокий блок — квадратная башня строго по своему игровому Box.
   *
   * Здесь намеренно нет цилиндра: снаряды и движение считают карту набором
   * прямоугольников. Круглая градирня оставляла видимые пустые углы, в которых
   * выстрел попадал в невидимую квадратную коллизию. Архитектурные детали могут
   * выходить на пару сантиметров, но несущий объём совпадает с физикой точно.
   */
  private buildTower(
    box: Box,
    bodyMaterial: THREE.MeshStandardMaterial,
    roofMaterial: THREE.MeshStandardMaterial,
    trimMaterial: THREE.MeshStandardMaterial,
  ): void {
    const body = new THREE.Mesh(new THREE.BoxGeometry(box.w, box.h, box.d), bodyMaterial);
    body.position.set(box.x, box.h / 2, box.z);
    body.castShadow = true;
    body.receiveShadow = true;
    this.world.add(body);

    const rim = new THREE.Mesh(new THREE.BoxGeometry(box.w + 0.16, 0.3, box.d + 0.16), trimMaterial);
    rim.position.set(box.x, box.h - 0.05, box.z);
    rim.castShadow = true;
    this.world.add(rim);

    const capHeight = Math.min(0.7, Math.max(0.35, box.h * 0.08));
    const cap = new THREE.Mesh(new THREE.BoxGeometry(box.w * 0.82, capHeight, box.d * 0.82), roofMaterial);
    cap.position.set(box.x, box.h + capHeight / 2, box.z);
    cap.castShadow = true;
    this.world.add(cap);
  }

  /** Низкие дюны и каменные гряды: несколько многогранников вместо одного блока. */
  private buildBerm(box: Box, batch: DecorBatch): void {
    const variant = boxVariant(box);
    const offsets: Array<[number, number, number]> = [
      [-0.22, -0.08, 0.62],
      [0.2, 0.12, 0.54],
      [0.02, -0.24, 0.46],
    ];
    for (let i = 0; i < offsets.length; i++) {
      const [ox, oz, scale] = offsets[i];
      const rock = new THREE.DodecahedronGeometry(1, 0);
      rock.scale(box.w * scale * 0.5, Math.max(0.45, box.h * (0.55 + i * 0.08)), box.d * scale * 0.5);
      rock.rotateY((variant + i) * 0.65);
      rock.translate(box.x + ox * box.w, Math.max(0.25, box.h * 0.4), box.z + oz * box.d);
      batch.rocks.push(rock);
    }
  }

  private flushDecor(
    batch: DecorBatch,
    roofMaterial: THREE.MeshStandardMaterial,
    trimMaterial: THREE.MeshStandardMaterial,
    windowMaterial: THREE.MeshStandardMaterial,
    doorMaterial: THREE.MeshStandardMaterial,
    rockMaterial: THREE.MeshStandardMaterial,
  ): void {
    const add = (geometries: THREE.BufferGeometry[], material: THREE.MeshStandardMaterial) => {
      if (geometries.length === 0) return;
      const geometry = mergeGeometries(geometries);
      if (!geometry) return;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.world.add(mesh);
    };
    add(batch.roof, roofMaterial);
    add(batch.trim, trimMaterial);
    add(batch.windows, windowMaterial);
    add(batch.doors, doorMaterial);
    add(batch.rocks, rockMaterial);
  }

  /**
   * Куст: кластер мелких кубиков вместо одной плоской коробки — читается как
   * листва, а не крашеный бетон. Высота фиксирована и заметно выше танка
   * (BUSH_HEIGHT) — box.h в этом не участвует, он у куста чисто про физику
   * (держит снаряд или нет, мешает ехать или нет — см. isBush в map.ts).
   * Один InstancedMesh на куст: кубиков в кластере может быть несколько
   * десятков, обычный Mesh на каждый обошёлся бы куда дороже по кадру.
   */
  private buildBush(box: Box, geometry: THREE.BoxGeometry, material: THREE.MeshStandardMaterial): void {
    const cols = Math.max(2, Math.round(box.w / LEAF_CUBE));
    const rows = Math.max(2, Math.round(box.d / LEAF_CUBE));
    const stepX = box.w / cols;
    const stepZ = box.d / rows;
    const stepY = BUSH_HEIGHT / BUSH_LAYERS;

    const mesh = new THREE.InstancedMesh(geometry, material, cols * rows * BUSH_LAYERS);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const dummy = new THREE.Object3D();
    let i = 0;
    for (let layer = 0; layer < BUSH_LAYERS; layer++) {
      for (let cx = 0; cx < cols; cx++) {
        for (let cz = 0; cz < rows; cz++) {
          const x = box.x - box.w / 2 + stepX * (cx + 0.5) + (Math.random() - 0.5) * stepX * 0.4;
          const z = box.z - box.d / 2 + stepZ * (cz + 0.5) + (Math.random() - 0.5) * stepZ * 0.4;
          const y = stepY * (layer + 0.5) + (Math.random() - 0.5) * stepY * 0.5;
          dummy.position.set(x, y, z);
          dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
          dummy.scale.setScalar(0.85 + Math.random() * 0.3);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
          mesh.setColorAt(i, LEAF_PALETTE[(Math.random() * LEAF_PALETTE.length) | 0]);
          i++;
        }
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.world.add(mesh);
    // Порядок совпадает с bushBoxes() — обе функции идут по одному и тому же
    // отфильтрованному списку obstacles, так что индекс тут и есть тот самый
    // индекс, который main.ts получает от bushIndexAt (см. setActiveBush).
    this.bushMeshes.push(mesh);
  }

  /** Снимает прошлую карту вместе с её буферами. */
  private clearWorld(): void {
    for (const child of this.world.children) {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) for (const m of material) m.dispose();
      else material?.dispose();
    }
    this.world.clear();
    this.bushMeshes = [];
    this.activeBush = -1;
  }

  addTank(
    id: number,
    name: string,
    colorIndex: number,
    isSelf: boolean,
    isBot = false,
  ): TankHandle {
    const existing = this.tanks.get(id);
    if (existing) return existing;

    const root = new THREE.Group();
    // Ходовая не наследует раскачку корпуса: пока танк жив, она сохраняет
    // плоскость земли, а верхняя масса работает как на рессорах.
    const runningGear = new THREE.Group();
    const body = new THREE.Group();
    body.position.y = SUSPENSION_PIVOT_Y;
    // Геометрия остаётся в прежних координатах, но поворот body теперь идёт
    // вокруг высоты подвески, а не вокруг нуля у земли.
    const upperHull = new THREE.Group();
    upperHull.position.y = -SUSPENSION_PIVOT_Y;
    body.add(upperHull);
    root.add(runningGear, body);

    const paintColor = PALETTE[colorIndex % PALETTE.length];
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: paintColor,
      roughness: 0.72,
      metalness: 0.15,
      flatShading: true,
      // Текстура серая и светлая: она умножается на краску, поэтому цвет танка
      // остаётся тем же, а броня перестаёт быть ровной заливкой.
      map: this.armorMap,
    });

    // Геометрия уже слита по материалам и стоит на своих местах: несколько
    // крупных мешей на танк вместо двух десятков, и каждый — один draw call.
    const hull = new THREE.Mesh(this.tankGeo.hull, bodyMaterial);
    hull.castShadow = true;
    hull.receiveShadow = true;
    upperHull.add(hull);

    const running = new THREE.Mesh(this.tankGeo.running, this.trackMaterial);
    running.castShadow = true;
    running.receiveShadow = true;
    runningGear.add(running);

    const wheels = new THREE.Mesh(this.tankGeo.wheels, this.wheelMaterial);
    wheels.castShadow = true;
    wheels.receiveShadow = true;
    runningGear.add(wheels);

    // По одному InstancedMesh на сторону: у гусеницы видны реальные звенья,
    // но двадцать две детали не превращаются в двадцать два draw call.
    const trackLinks = [-1, 1].map((side) => this.createTrackLinks(side));
    for (const links of trackLinks) runningGear.add(links);

    const hullMetal = new THREE.Mesh(this.tankGeo.hullMetal, this.metalMaterial);
    hullMetal.castShadow = true;
    hullMetal.receiveShadow = true;
    upperHull.add(hullMetal);

    const turret = new THREE.Group();
    turret.position.y = TURRET_Y;

    const turretBody = new THREE.Mesh(this.tankGeo.turret, bodyMaterial);
    turretBody.castShadow = true;
    turret.add(turretBody);

    const turretMetal = new THREE.Mesh(this.tankGeo.turretMetal, this.metalMaterial);
    turretMetal.castShadow = true;
    turret.add(turretMetal);

    // Ствол отдельным мешем: он единственный ездит внутри башни.
    const barrel = new THREE.Mesh(this.tankGeo.barrel, this.metalMaterial);
    barrel.castShadow = true;
    turret.add(barrel);

    upperHull.add(turret);

    this.scene.add(root);

    const label = document.createElement('div');
    label.className = isSelf ? 'nameplate is-self' : isBot ? 'nameplate is-bot' : 'nameplate';

    const text = document.createElement('span');
    text.textContent = name;
    label.appendChild(text);

    // Полоска здоровья фиксированной ширины: меняется только заливка, поэтому
    // размеры подписи остаются постоянными и их можно замерить один раз.
    const bar = document.createElement('i');
    bar.className = 'np-hp';
    const hpFill = document.createElement('b');
    bar.appendChild(hpFill);
    label.appendChild(bar);

    this.labelContainer.appendChild(label);

    const handle: TankHandle = {
      root,
      body,
      runningGear,
      turret,
      barrel,
      trackLinks,
      recoil: 0,
      lastX: 0,
      lastZ: 0,
      lastYaw: 0,
      speed: 0,
      roll: 0,
      pitch: 0,
      kickRoll: 0,
      kickPitch: 0,
      trackDistance: 0,
      dustDistance: 0,
      treadPhase: [0, 0],
      paint: bodyMaterial,
      paintColor,
      dying: -1,
      smokeAt: 0,
      everSeen: false,
      label,
      hpFill,
      // Читаем размеры один раз: offsetWidth каждый кадр заставлял бы браузер
      // пересчитывать раскладку на все подписи сразу.
      labelHalfWidth: Math.round(label.offsetWidth / 2),
      labelHeight: label.offsetHeight,
      labelVisible: true,
      plated: true,
      alive: true,
      cloaked: false,
      hp: MAX_HP,
    };
    this.tanks.set(id, handle);
    return handle;
  }

  /** Создаёт одну сторону гусеницы и ставит звенья в исходную фазу. */
  private createTrackLinks(side: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.tankGeo.trackLink, this.trackMaterial, TRACK_LINK_COUNT);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    for (let index = 0; index < TRACK_LINK_COUNT; index++) {
      placeTrackLink(this.trackLinkDummy, index, 0, side);
      this.trackLinkDummy.updateMatrix();
      mesh.setMatrixAt(index, this.trackLinkDummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  /** Передвигает оба пояса звеньев по их замкнутому контуру. */
  private updateTrackLinks(handle: TankHandle): void {
    for (let sideIndex = 0; sideIndex < handle.trackLinks.length; sideIndex++) {
      const side = sideIndex === 0 ? -1 : 1;
      const mesh = handle.trackLinks[sideIndex];
      for (let index = 0; index < TRACK_LINK_COUNT; index++) {
        placeTrackLink(this.trackLinkDummy, index, handle.treadPhase[sideIndex], side);
        this.trackLinkDummy.updateMatrix();
        mesh.setMatrixAt(index, this.trackLinkDummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Здоровье и «жив ли»: подбитый корпус убираем со сцены до респавна.
   * Максимум передаётся снаружи — у ботов он свой, и без него полный бот
   * показывал бы полоску, залитую на три четверти.
   */
  setTankHealth(id: number, hp: number, alive: boolean, max = MAX_HP): void {
    const handle = this.tanks.get(id);
    if (!handle) return;

    if (hp !== handle.hp) {
      handle.hp = hp;
      const fraction = Math.max(0, Math.min(1, hp / max));
      handle.hpFill.style.width = `${(fraction * 100).toFixed(0)}%`;
      // Зелёный -> жёлтый -> красный по мере потери брони.
      handle.hpFill.style.background = `hsl(${Math.round(fraction * 105)} 70% 48%)`;
    }

    if (alive !== handle.alive) {
      handle.alive = alive;
      if (alive) this.reviveTank(handle);
      else this.killTank(handle);
      // Подпись погасит updateLabels(): она и так каждый кадр решает, видно ли её.
    }
  }

  /** Танк подбит: копоть, перекос, разлёт обломков и осевший остов, который остаётся на карте. */
  private killTank(handle: TankHandle): void {
    // Танк, которого мы живым не застали (зашли посреди волны, а он уже
    // труп), не получает вспышку и обломки — взрыв ему устроили до нашего
    // появления, и разыгрывать его сейчас — врать о том, что случилось. Но
    // сам остов теперь физическое препятствие карты, поэтому он всё равно
    // должен быть виден — просто сразу в уже осевшей позе, без анимации.
    if (!handle.everSeen) {
      handle.dying = WRECK_S;
      handle.smokeAt = Infinity;
      handle.root.visible = !handle.cloaked;
      handle.paint.color.setHex(handle.paintColor).multiplyScalar(WRECK_DARKEN);
      handle.body.rotation.set(WRECK_PITCH, 0, WRECK_ROLL);
      this.setWreckPose(handle, wreckSink(WRECK_S));
      handle.roll = WRECK_ROLL;
      handle.pitch = WRECK_PITCH;
      this.setTankShadow(handle, false);
      return;
    }

    handle.dying = 0;
    handle.smokeAt = 0;
    handle.root.visible = !handle.cloaked;

    handle.paint.color.setHex(handle.paintColor).multiplyScalar(WRECK_DARKEN);
    handle.body.rotation.set(WRECK_PITCH, 0, WRECK_ROLL);
    this.setWreckPose(handle, 0);
    handle.roll = WRECK_ROLL;
    handle.pitch = WRECK_PITCH;

    // Остов уходит под землю, а тень рисуется отдельным проходом сверху: земля
    // в карту теней не пишет, поэтому провалившийся танк продолжал бы бросать
    // на неё тень — на пустом месте лежало бы тёмное пятно.
    this.setTankShadow(handle, false);

    const { x, z } = handle.root.position;
    for (let i = 0; i < WRECK_DEBRIS; i++) {
      const course = Math.random() * Math.PI * 2;
      const outward = 3 + Math.random() * 7;
      this.debris.emit(
        x + (Math.random() - 0.5) * 2,
        1.4,
        z + (Math.random() - 0.5) * 2,
        Math.sin(course) * outward,
        5 + Math.random() * 6,
        Math.cos(course) * outward,
        0.7 + Math.random() * 0.6,
        this.clock,
      );
    }
  }

  /** Возрождение: краска, тени и осанка возвращаются к исходным. */
  private reviveTank(handle: TankHandle): void {
    handle.dying = -1;
    handle.paint.color.setHex(handle.paintColor);
    handle.body.position.y = SUSPENSION_PIVOT_Y;
    handle.body.rotation.set(0, 0, 0);
    handle.runningGear.position.set(0, 0, 0);
    handle.runningGear.rotation.set(0, 0, 0);
    handle.roll = 0;
    handle.pitch = 0;
    this.setTankShadow(handle, true);
    handle.root.visible = !handle.cloaked;
  }

  /** На смерти ходовая снова следует за корпусом, чтобы остов не распался на части. */
  private setWreckPose(handle: TankHandle, sink: number): void {
    handle.body.position.y = SUSPENSION_PIVOT_Y + sink;
    handle.runningGear.position.y = sink;
    handle.runningGear.rotation.copy(handle.body.rotation);
  }

  /** И верх, и ходовая участвуют в одном состоянии теней — живом либо остове. */
  private setTankShadow(handle: TankHandle, castShadow: boolean): void {
    handle.body.traverse((node) => {
      node.castShadow = castShadow;
    });
    handle.runningGear.traverse((node) => {
      node.castShadow = castShadow;
    });
  }

  /**
   * Горящий остов: оседает и дымит первые WRECK_S секунд, дальше просто лежит
   * осевшим препятствием — сервер держит его на карте до возрождения, и
   * убирать со сцены раньше нельзя, иначе танки будут врезаться в пустоту.
   */
  private updateWrecks(dt: number): void {
    for (const [, handle] of this.tanks) {
      if (handle.dying < 0 || handle.dying >= WRECK_S) continue;
      handle.dying += dt;

      this.setWreckPose(handle, wreckSink(Math.min(handle.dying, WRECK_S)));
      if (handle.dying >= WRECK_S || handle.dying < handle.smokeAt) continue;
      handle.smokeAt += WRECK_SMOKE_EVERY;
      this.spawnEffect(
        handle.root.position.x + (Math.random() - 0.5) * 1.6,
        1.5,
        handle.root.position.z + (Math.random() - 0.5) * 1.6,
        WRECK_SMOKE,
      );
    }
  }

  /**
   * «Маскировка»: издали танк не рисуется и не подписан. Вплотную он виден —
   * иначе бонус превращался бы в неуязвимость. Порог считает вызывающая сторона,
   * ровно тот же, по которому его перестают видеть боты на сервере.
   */
  setTankStealth(id: number, cloaked: boolean): void {
    const handle = this.tanks.get(id);
    if (!handle || handle.cloaked === cloaked) return;
    handle.cloaked = cloaked;
    // Горящий остов ещё не «жив», но виден: без этой оговорки любое обновление
    // маскировки в кадре гибели гасило бы его на полуслове.
    handle.root.visible = (handle.alive || handle.dying >= 0) && !cloaked;
  }

  /**
   * Разрешена ли танку подпись. В аркаде подписаны все, в реалистичных правилах
   * — только товарищи, поэтому решение принимает main.ts: рендер не знает ни про
   * команды, ни про режим комнаты.
   *
   * Гасить подпись руками не нужно — updateLabels каждый кадр решает это заново
   * и снимет её сам, ровно как делает «Маскировка».
   */
  setNameplate(id: number, on: boolean): void {
    const handle = this.tanks.get(id);
    if (handle) handle.plated = on;
  }

  /**
   * Танк насовсем ушёл из комнаты (отключился человек, или волна зачистила
   * труп бота). Сама гибель сюда не попадает — она приходит dead-флагом
   * снапшота и уже отыграна killTank раньше; здесь только уборка со сцены.
   */
  removeTank(id: number): void {
    const handle = this.tanks.get(id);
    if (!handle) return;
    this.dropTank(id, handle);
  }

  /** Убрать танк со сцены совсем. */
  private dropTank(id: number, handle: TankHandle): void {
    handle.label.remove();
    this.scene.remove(handle.root);
    this.tanks.delete(id);
  }

  /** Снести всех разом: переподключение начинает мир с чистого листа. */
  clearTanks(): void {
    for (const [id, handle] of this.tanks) this.dropTank(id, handle);
  }

  updateTank(id: number, x: number, z: number, angle: number, turret: number): void {
    const handle = this.tanks.get(id);
    if (!handle) return;
    if (handle.alive) handle.everSeen = true;
    handle.root.position.set(x, 0, z);
    handle.root.rotation.y = angle;
    // Башня хранится в мировых углах, а её узел — потомок корпуса.
    handle.turret.rotation.y = turret - angle;
  }

  /** Камера летит за танком: позиция задаётся углами обзора, а не поворотом корпуса. */
  updateCamera(
    x: number,
    z: number,
    yaw: number,
    pitch: number,
    dt: number,
    zoom = CAMERA_DISTANCE,
  ): void {
    const distance = zoom * Math.cos(pitch) + 2;
    const height = CAMERA_BASE_HEIGHT + Math.sin(pitch) * zoom;

    const desiredX = x - Math.sin(yaw) * distance;
    const desiredZ = z - Math.cos(yaw) * distance;

    if (!this.cameraReady) {
      this.cameraHeight = height;
      this.cameraReady = true;
    } else {
      // Высоту сглаживаем: её меняет только колесо обзора, рывков от движения нет.
      this.cameraHeight += (height - this.cameraHeight) * (1 - Math.exp(-dt * 14));
    }
    // По горизонтали камера жёстко привязана к танку: позиция танка уже
    // интерполирована и сглажена, а второй слой догонялки поверх первого давал
    // качание влево-вправо на скорости.
    this.camera.position.set(desiredX, this.cameraHeight, desiredZ);

    // Цель взгляда не трясётся вместе с камерой: смещаем только точку съёмки,
    // и толчок выходит поворотом кадра, а не сползанием прицела с танка.
    this.cameraTarget.set(x, 2.2, z);
    this.applyShake(dt);
    this.camera.lookAt(this.cameraTarget);
  }

  /**
   * Кусты непрозрачны по умолчанию — так они читаются как заросли снаружи, в
   * третьем лице и с чужих экранов. index — тот куст (см. bushIndexAt в
   * main.ts), внутри которого сейчас физически камера от первого лица: его
   * целиком прячем (не притушиваем!), иначе взгляд изнутри густого куста идёт
   * сквозь десяток кубиков подряд и лёгкая полупрозрачность каждого в сумме
   * всё равно даёт сплошную стену. -1 — камера не в кусте, всё видно как есть.
   */
  setActiveBush(index: number): void {
    if (index === this.activeBush) return;
    this.activeBush = index;
    for (let i = 0; i < this.bushMeshes.length; i++) this.bushMeshes[i].visible = i !== index;
  }

  /**
   * Вид от первого лица: камера стоит у башни и сама смотрит туда, куда наводит
   * игрок — те же yaw/pitch, что крутят камеру от третьего лица, только здесь
   * это направление взгляда, а не угол обзора вокруг цели. zoom (дистанция)
   * тут не участвует вовсе: смотровая точка одна и та же.
   */
  updateFirstPersonCamera(x: number, z: number, yaw: number, pitch: number, dt: number): void {
    const camX = x + Math.sin(yaw) * FPV_FORWARD;
    const camZ = z + Math.cos(yaw) * FPV_FORWARD;

    if (!this.cameraReady) {
      this.cameraHeight = FPV_HEIGHT;
      this.cameraReady = true;
    } else {
      this.cameraHeight += (FPV_HEIGHT - this.cameraHeight) * (1 - Math.exp(-dt * 14));
    }
    this.camera.position.set(camX, this.cameraHeight, camZ);

    // Та же спереди-вверх математика, что и у pitch в третьем лице (там он же
    // крутит камеру над целью): положительный pitch — взгляд вниз.
    const dirX = Math.sin(yaw) * Math.cos(pitch);
    const dirY = -Math.sin(pitch);
    const dirZ = Math.cos(yaw) * Math.cos(pitch);
    this.cameraTarget.set(camX + dirX * FPV_LOOK, this.cameraHeight + dirY * FPV_LOOK, camZ + dirZ * FPV_LOOK);
    this.applyShake(dt);
    this.camera.lookAt(this.cameraTarget);
  }

  /**
   * Вид сверху: камера висит прямо над танком и не поворачивается вместе с ним.
   *
   * Карта держится севером вверх намеренно. Разворачивать её по курсу — значит
   * крутить весь экран на каждом повороте гусениц; читать в такой картинке, где
   * стены и где противник, невозможно, а на телефоне это единственный источник
   * сведений о мире: обзора вокруг себя, как в виде от третьего лица, тут нет.
   */
  updateTopCamera(x: number, z: number, zoom: number, dt: number): void {
    const radius = zoom * TOP_ZOOM_SCALE;
    if (radius !== this.topRadius) {
      this.topRadius = radius;
      this.applyTopFrustum();
      this.syncParticleScale();
    }

    this.topCamera.position.set(x, TOP_HEIGHT, z);
    // Разворот считаем до тряски: у ортокамеры наклон не качает кадр, а сдвигает
    // всю картинку вбок целиком, и толчок читался бы как рывок карты.
    this.topCamera.lookAt(x, 0, z);
    this.applyShake(dt);
  }

  /**
   * Переключение вида. Пересобирать проходы постобработки не нужно — достаточно
   * подсунуть RenderPass другую камеру, шейдеры при этом не перекомпилируются.
   */
  setTopView(on: boolean): void {
    const next = on ? this.topCamera : this.camera;
    if (next === this.active) return;
    this.active = next;
    this.renderPass.camera = next;
    // Вернувшись к виду от третьего лица, камера не должна плавно съезжать
    // с девяноста метров: высоту берём сразу, без догонялки.
    this.cameraReady = false;
    this.trauma = 0;
    this.resize();
  }

  private applyTopFrustum(): void {
    const { halfWidth, halfHeight } = topFrustum(this.topRadius, this.viewWidth / this.viewHeight);
    this.topCamera.left = -halfWidth;
    this.topCamera.right = halfWidth;
    this.topCamera.top = halfHeight;
    this.topCamera.bottom = -halfHeight;
    this.topCamera.updateProjectionMatrix();
  }

  /** Размер частиц: он задан в метрах, а шейдер выдаёт пиксели устройства. */
  private syncParticleScale(): void {
    const heightPx = this.viewHeight * this.renderer.getPixelRatio();
    const fov =
      this.active === this.camera ? this.camera.fov : topParticleFov(this.topCamera.top);
    this.dust.setViewport(heightPx, fov);
    this.debris.setViewport(heightPx, fov);
  }

  /**
   * Толчок камеры. Копится «встряской» 0..1 — сложить два события можно, но выше
   * единицы она не уйдёт, поэтому залп в упор не выбивает кадр за пределы экрана.
   */
  addShake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  private applyShake(dt: number): void {
    if (this.trauma <= 0) return;
    this.trauma = Math.max(0, this.trauma - dt * SHAKE_DECAY);
    this.shakeTime += dt;

    // Три несоизмеримые частоты вместо случайных чисел: покадровый шум на 144 Гц
    // читается как рябь картинки, а не как удар.
    const t = this.shakeTime * SHAKE_FREQ;
    const power = this.trauma * this.trauma * SHAKE_AMPLITUDE;
    // Вертикаль в виде сверху — это ось взгляда: у ортокамеры она ничего не
    // двигает, и толчок остаётся честным сдвигом карты по двум осям.
    this.active.position.x += Math.sin(t * 1.7) * power;
    this.active.position.y += Math.sin(t * 2.3 + 1.1) * power;
    this.active.position.z += Math.sin(t * 1.3 + 2.7) * power;
  }

  /**
   * Точка мира в координатах экрана, в тех же пикселях, что и ники.
   * null — точка за камерой, рисовать нечего.
   */
  project(x: number, y: number, z: number): { x: number; y: number } | null {
    this.projected.set(x, y, z).project(this.active);
    if (this.projected.z < -1 || this.projected.z > 1) return null;
    return {
      x: (this.projected.x * 0.5 + 0.5) * this.viewWidth,
      y: (-this.projected.y * 0.5 + 0.5) * this.viewHeight,
    };
  }

  // --- Снаряды ---

  /**
   * Ставит меши по списку из снапшота. Снаряды живут по id: те, кого в списке нет,
   * уже взорвались — их меш уходит в пул, а взрыв прилетает отдельным событием.
   */
  syncShells(list: Array<{ id: number; x: number; z: number; angle: number; trail?: number }>): void {
    for (const handle of this.shells.values()) handle.seen = false;

    for (const shell of list) {
      let handle = this.shells.get(shell.id);
      if (!handle) {
        const group = this.shellPool.pop() ?? this.createShell();
        this.scene.add(group);
        handle = { group, tracer: group.getObjectByName('shell-tracer') as THREE.Mesh, seen: true };
        this.shells.set(shell.id, handle);
      }
      handle.seen = true;
      handle.group.position.set(shell.x, SHELL_HEIGHT, shell.z);
      // Группа собрана вдоль своего +Z, а угол 0 в игре смотрит в мировой +Z.
      handle.group.rotation.y = shell.angle;
      const trail = Math.max(0, Math.min(TRACER_LENGTH, shell.trail ?? TRACER_LENGTH));
      handle.tracer.visible = trail > 0.02;
      handle.tracer.scale.set(1, trail, 1);
      handle.tracer.position.z = -trail / 2;
    }

    for (const [id, handle] of this.shells) {
      if (handle.seen) continue;
      this.scene.remove(handle.group);
      this.shellPool.push(handle.group);
      this.shells.delete(id);
    }
  }

  /** Снаряд: светящееся тело и трассер, вытянутый назад по ходу полёта. */
  private createShell(): THREE.Group {
    const group = new THREE.Group();

    const core = new THREE.Mesh(this.geo.shell, this.shellMaterial);
    core.rotation.x = Math.PI / 2; // капсула стоит вдоль Y — кладём её вдоль полёта
    group.add(core);

    // Конус растёт вдоль своего +Y, поворот на -90° уводит остриё назад, в -Z:
    // хвост сходит на нет позади снаряда, а широким концом сидит на нём.
    const tracer = new THREE.Mesh(this.geo.tracer, this.tracerMaterial);
    tracer.name = 'shell-tracer';
    tracer.rotation.x = -Math.PI / 2;
    tracer.scale.set(1, TRACER_LENGTH, 1);
    tracer.position.z = -TRACER_LENGTH / 2;
    group.add(tracer);

    return group;
  }

  clearShells(): void {
    this.syncShells([]);
  }

  // --- Ящики с бонусами ---

  /** Ставит ящики по списку из снапшота: пропавшие подобрали или они истекли. */
  syncBonuses(list: SnapshotBonus[]): void {
    for (const handle of this.bonuses.values()) handle.seen = false;

    for (const bonus of list) {
      let handle = this.bonuses.get(bonus.i);
      if (!handle) {
        const mesh = new THREE.Mesh(
          this.geo.bonus,
          this.bonusMaterials[bonus.k % this.bonusMaterials.length],
        );
        mesh.castShadow = true;
        this.scene.add(mesh);
        handle = { mesh, seen: true };
        this.bonuses.set(bonus.i, handle);
      }
      handle.seen = true;
      handle.mesh.position.set(bonus.x, BONUS_HOVER, bonus.z);
    }

    for (const [id, handle] of this.bonuses) {
      if (handle.seen) continue;
      this.scene.remove(handle.mesh);
      this.bonuses.delete(id);
    }
  }

  clearBonuses(): void {
    this.syncBonuses([]);
  }

  /** Ящик крутится и покачивается — так его видно издали на пёстром фоне. */
  private updateBonuses(dt: number): void {
    if (this.bonuses.size === 0) return;
    this.bonusSpin += dt;
    const bob = Math.sin(this.bonusSpin * 2.2) * 0.28;
    for (const handle of this.bonuses.values()) {
      handle.mesh.rotation.y = this.bonusSpin * 1.1;
      handle.mesh.rotation.x = this.bonusSpin * 0.5;
      handle.mesh.position.y = BONUS_HOVER + bob;
    }
  }

  // --- Взрывы ---

  boom(x: number, z: number, kind: BoomKind): void {
    this.spawnEffect(x, BOOM_HEIGHT[kind], z, BOOM_PRESETS[kind]);
    if (kind === BOOM_HIT) this.tankHit(x, z);
  }

  /**
   * Качнуть танк, в который прилетело. Кого именно задело, снапшот не сообщает —
   * и не нужно: снаряд взрывается ровно на границе круга цели, то есть в 2.7 м
   * от её центра, поэтому ближайший танк и есть тот самый. Заодно из места
   * взрыва берётся направление удара, а его в сообщении не было бы.
   *
   * Только BOOM_HIT: взрыв гибели сервер ставит в центр танка, направления из
   * него не вычесть, да и осанку остову всё равно задаёт сама гибель.
   */
  private tankHit(x: number, z: number): void {
    let victim: TankHandle | null = null;
    let best = HIT_KICK_RANGE;
    for (const handle of this.tanks.values()) {
      if (!handle.alive) continue;
      const gap = Math.hypot(handle.root.position.x - x, handle.root.position.z - z);
      if (gap < best) {
        best = gap;
        victim = handle;
      }
    }
    if (!victim || best < 1e-3) return;

    // Сила смотрит от места попадания внутрь танка — с той стороны он и вздёрнется.
    const fx = (victim.root.position.x - x) / best;
    const fz = (victim.root.position.z - z) / best;
    const yaw = victim.root.rotation.y;
    const kick = bodyKick(
      fx * Math.sin(yaw) + fz * Math.cos(yaw),
      fx * Math.cos(yaw) - fz * Math.sin(yaw),
      HIT_KICK,
    );
    victim.kickRoll += kick.roll;
    victim.kickPitch += kick.pitch;
  }

  /**
   * Танк выстрелил: откат ствола, вспышка и дым у самого дульного среза.
   * Точку берём из матрицы башни, а не из места, где снаряд оказался к первому
   * снапшоту: тот к этому моменту улетел на пару метров, и вспышка висела в воздухе.
   *
   * Возвращает false, если танка на сцене нет, — вызывающему остаётся рисовать
   * вспышку по координатам снаряда.
   */
  tankFired(id: number): boolean {
    const handle = this.tanks.get(id);
    if (!handle) return false;
    handle.recoil = 1;

    // Корпус качает отдачей: сила приходит с той стороны, куда смотрит ствол,
    // и та сторона задирается. Считаем в осях корпуса, поэтому берём угол башни
    // относительно него, а не мировой.
    const gun = handle.turret.rotation.y;
    const kick = bodyKick(-Math.cos(gun), -Math.sin(gun), SHOT_KICK);
    handle.kickRoll += kick.roll;
    handle.kickPitch += kick.pitch;

    // Замаскированный танк себя выстрелом не выдаёт: иначе бонус переставал бы
    // работать ровно в тот момент, ради которого его и брали.
    if (!handle.alive || handle.cloaked) return true;

    // Матрицу считает рендер, то есть в ней прошлый кадр; обновляем вручную,
    // иначе вспышка отстаёт от башни на кадр при быстром довороте.
    handle.turret.updateWorldMatrix(true, false);
    const point = handle.turret.localToWorld(this.muzzlePoint.set(0, MUZZLE_Y, MUZZLE_TIP_Z));
    // Ствол смотрит вдоль +Z башни, а башня крутится только вокруг вертикали.
    const angle = handle.root.rotation.y + handle.turret.rotation.y;

    this.spawnEffect(point.x, point.y, point.z, MUZZLE_PRESET, angle);
    this.spawnEffect(point.x, point.y, point.z, MUZZLE_SMOKE, angle);
    return true;
  }

  /** Запасная вспышка по координатам: танк ещё не доехал до клиента сообщением. */
  muzzleFlash(x: number, z: number, angle: number): void {
    this.spawnEffect(x, SHELL_HEIGHT, z, MUZZLE_PRESET, angle);
  }

  private spawnEffect(x: number, y: number, z: number, preset: EffectPreset, angle = 0): void {
    const fx = this.effectPool.pop() ?? this.createEffect();
    fx.group.position.set(x, y, z);
    fx.group.rotation.y = angle;
    fx.group.visible = true;
    fx.life = preset.life;
    fx.duration = preset.life;
    fx.radius = preset.radius;
    fx.rise = preset.rise ?? 0;
    fx.grow = preset.grow ?? 0.85;
    fx.alpha = preset.alpha ?? 0.9;

    // Цвет уходит за единицу намеренно: там его подхватывает порог свечения,
    // а при выключенном свечении тонмаппинг сам сводит перебор в тёплый белый.
    const glow = preset.glow ?? 1;
    for (const mesh of [fx.flash, fx.ring, fx.cone]) {
      (mesh.material as THREE.MeshBasicMaterial).color.setHex(preset.color).multiplyScalar(glow);
    }
    fx.ring.visible = preset.ring === true;
    // Кольцо стелется по земле независимо от того, на какой высоте рвануло.
    fx.ring.position.y = 0.15 - y;

    fx.cone.visible = preset.cone !== undefined;
    if (preset.cone !== undefined) {
      fx.cone.scale.set(1, preset.cone, 1);
      fx.cone.position.z = preset.cone / 2;
    }

    this.effects.push(fx);
  }

  private createEffect(): Effect {
    const group = new THREE.Group();
    group.visible = false;

    const flash = new THREE.Mesh(
      this.geo.flash,
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }),
    );
    group.add(flash);

    const ring = new THREE.Mesh(
      this.geo.ring,
      new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);

    // Язык пламени бьёт вдоль +Z группы, то есть туда же, куда ушёл снаряд.
    // Поворот на -90° ставит остриё конуса в сторону -Z: вместе со сдвигом на
    // половину длины остриё садится ровно на дульный срез, а раструб уходит вперёд.
    const cone = new THREE.Mesh(
      this.geo.cone,
      new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    cone.rotation.x = -Math.PI / 2;
    group.add(cone);

    this.scene.add(group);
    return { group, flash, ring, cone, life: 0, duration: 1, radius: 1, rise: 0, grow: 0.85, alpha: 0.9 };
  }

  private updateEffects(dt: number): void {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      fx.life -= dt;
      if (fx.life <= 0) {
        fx.group.visible = false;
        this.effects.splice(i, 1);
        this.effectPool.push(fx);
        continue;
      }

      const t = 1 - fx.life / fx.duration; // 0 в момент взрыва, 1 в конце
      const fade = (1 - t) * (1 - t);
      if (fx.rise !== 0) fx.group.position.y += fx.rise * dt;

      const scale = fx.radius * (0.35 + t * fx.grow);
      fx.flash.scale.setScalar(scale);
      (fx.flash.material as THREE.MeshBasicMaterial).opacity = fade * fx.alpha;

      if (fx.cone.visible) {
        // Язык пламени только гаснет: растягивать его вслед за вспышкой нельзя —
        // он тут же дотянулся бы до стены, в которую стреляют в упор.
        (fx.cone.material as THREE.MeshBasicMaterial).opacity = fade * 0.8;
      }

      if (!fx.ring.visible) continue;
      fx.ring.scale.setScalar(fx.radius * (0.4 + t * 2.4));
      (fx.ring.material as THREE.MeshBasicMaterial).opacity = fade * 0.55;
    }
  }

  /**
   * Ходовая часть: крен на повороте, клевок на разгоне и торможении, следы
   * и пыль из-под траков. Всё считается из перемещения за кадр — своё,
   * предсказанное, и чужое, интерполированное, приходят сюда одинаково.
   */
  private updateChassis(dt: number): void {
    if (dt <= 0) return;
    const k = 1 - Math.exp(-dt * LEAN_RATE);

    // Толчок гаснет у всех и всегда: он поставлен в момент удара, и ветки
    // «подбит» или «телепорт» ниже до него бы не дошли.
    const kickLeft = Math.exp(-dt * KICK_DECAY);

    for (const handle of this.tanks.values()) {
      handle.kickRoll *= kickLeft;
      handle.kickPitch *= kickLeft;

      const x = handle.root.position.x;
      const z = handle.root.position.z;
      const yaw = handle.root.rotation.y;

      const dx = x - handle.lastX;
      const dz = z - handle.lastZ;
      const yawDelta = wrapAngle(yaw - handle.lastYaw);
      const step = Math.hypot(dx, dz);
      handle.lastX = x;
      handle.lastZ = z;
      handle.lastYaw = yaw;

      if (step > TELEPORT_STEP) {
        handle.speed = 0;
        handle.roll = 0;
        handle.pitch = 0;
        handle.kickRoll = 0;
        handle.kickPitch = 0;
        handle.trackDistance = 0;
        handle.dustDistance = 0;
        handle.treadPhase[0] = 0;
        handle.treadPhase[1] = 0;
        this.updateTrackLinks(handle);
        handle.body.rotation.set(0, 0, 0);
        continue;
      }

      // Подбитый танк не кренится и не месит землю: осанку ему задала гибель,
      // и пересчёт крена тут же выпрямил бы остов обратно.
      if (!handle.alive) {
        handle.speed = 0;
        continue;
      }

      const forwardX = Math.sin(yaw);
      const forwardZ = Math.cos(yaw);
      // Знаковая скорость: проекция шага на курс. Задний ход выходит отрицательным,
      // и танк на нём клюёт в другую сторону — как и должен.
      const speed = (dx * forwardX + dz * forwardZ) / dt;
      const accel = (speed - handle.speed) / dt;
      handle.speed = speed;

      // Две ленты получают разный пробег на развороте. Поэтому даже танк,
      // который крутится на месте, не стоит на неподвижных гусеницах.
      const rightTravel = speed * dt + yawDelta * TRACK_SIDE;
      const leftTravel = speed * dt - yawDelta * TRACK_SIDE;
      if (Math.abs(rightTravel) > 0.001 || Math.abs(leftTravel) > 0.001) {
        handle.treadPhase[0] += rightTravel;
        handle.treadPhase[1] += leftTravel;
        this.updateTrackLinks(handle);
      }

      const lean = bodyLean(yawDelta / dt, speed, accel);
      handle.roll += (lean.roll - handle.roll) * k;
      handle.pitch += (lean.pitch - handle.pitch) * k;
      handle.body.rotation.z = (handle.roll + handle.kickRoll) * SUSPENSION_AMPLITUDE;
      handle.body.rotation.x = (handle.pitch + handle.kickPitch) * SUSPENSION_AMPLITUDE;

      // Замаскированный не должен выдавать себя ни следом, ни облаком пыли.
      if (handle.cloaked || step === 0) continue;

      handle.trackDistance += step;
      handle.dustDistance += step;
      const laysTrack = handle.trackDistance >= TRACK_STEP;
      const raisesDust = handle.dustDistance >= DUST_STEP && Math.abs(speed) >= DUST_MIN_SPEED;
      if (!laysTrack && !raisesDust) continue;
      if (laysTrack) handle.trackDistance %= TRACK_STEP;
      if (raisesDust) handle.dustDistance %= DUST_STEP;

      for (const side of [-1, 1]) {
        const at = trackAnchor(x, z, yaw, side);
        if (laysTrack) this.tracks.emit(at.x, at.z, yaw, this.clock);
        if (!raisesDust) continue;
        // Пыль выбрасывает назад из-под трака и подбрасывает вверх.
        this.dust.emit(
          at.x,
          0.25,
          at.z,
          -forwardX * 1.3 + (Math.random() - 0.5) * 1.4,
          0.9 + Math.random() * 0.9,
          -forwardZ * 1.3 + (Math.random() - 0.5) * 1.4,
          // Метры, а не пиксели: шейдер сам растит клуб до 1.9 м к концу жизни.
          0.55 + Math.random() * 0.45,
          this.clock,
        );
      }
    }
  }

  /** Ствол уходит назад рывком и выходит обратно экспонентой — как накатник. */
  private updateRecoil(dt: number): void {
    const k = Math.exp(-dt * RECOIL_RETURN);
    for (const handle of this.tanks.values()) {
      if (handle.recoil <= 0) continue;
      handle.recoil = handle.recoil * k < 0.01 ? 0 : handle.recoil * k;
      handle.barrel.position.z = -handle.recoil * RECOIL_BACK;
    }
  }

  render(dt: number): void {
    this.clock += dt;
    this.updateEffects(dt);
    this.updateRecoil(dt);
    this.updateChassis(dt);
    this.updateWrecks(dt);
    this.updateBonuses(dt);
    this.tracks.update(this.clock);
    this.dust.update(this.clock);
    this.debris.update(this.clock);
    if (this.bloomOn) this.composer.render();
    else this.renderer.render(this.scene, this.active);
    this.updateLabels();
  }

  /**
   * Свечение — личная настройка: три прохода размытия по полному кадру стоят
   * заметно, и на слабой машине их лучше снять. На бой это не влияет никак.
   */
  setBloom(on: boolean): void {
    this.bloomOn = on;
  }

  /**
   * Ники позиционируем сами, а не через CSS2DRenderer: тот ставит дробные
   * пиксели, из-за чего текст на ходу становится мыльным и дрожит.
   */
  private updateLabels(): void {
    this.active.updateMatrixWorld();

    for (const handle of this.tanks.values()) {
      this.projected.set(
        handle.root.position.x,
        LABEL_HEIGHT,
        handle.root.position.z,
      );
      const distance = this.projected.distanceTo(this.active.position);
      this.projected.project(this.active);

      // z вне [-1, 1] значит «за камерой или за дальней плоскостью».
      const visible =
        handle.plated &&
        handle.alive &&
        !handle.cloaked &&
        distance < LABEL_MAX_DISTANCE &&
        this.projected.z > -1 &&
        this.projected.z < 1;

      if (visible !== handle.labelVisible) {
        handle.label.style.display = visible ? '' : 'none';
        handle.labelVisible = visible;
      }
      if (!visible) continue;

      const x = Math.round((this.projected.x * 0.5 + 0.5) * this.viewWidth) - handle.labelHalfWidth;
      const y =
        Math.round((-this.projected.y * 0.5 + 0.5) * this.viewHeight) - handle.labelHeight;
      handle.label.style.transform = `translate(${x}px, ${y}px)`;
    }
  }

  private resize = () => {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.viewWidth = width;
    this.viewHeight = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.applyTopFrustum();
    this.renderer.setSize(width, height, false);
    // Композитор тянет пиксельную плотность из рендерера сам, поэтому размер
    // ему отдаётся в тех же условных пикселях, что и рендереру.
    this.composer.setSize(width, height);
    this.bloomPass.setSize(width, height);
    // Размер частицы задан в метрах, а шейдер выдаёт пиксели устройства.
    this.syncParticleScale();
  };
}
