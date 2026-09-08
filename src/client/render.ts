import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

import { GROUND_EPS, MAX_HP, SHELL_HEIGHT, TANK_HEIGHT } from '../shared/constants.js';
import { wrapAngle } from '../shared/sim.js';
import { FLAT, heightAt, slopeAt, TERRAIN_STEP, type Terrain } from '../shared/terrain.js';
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
  COLOR_GROUND,
  COLOR_LOW_BOX,
  COLOR_METAL,
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
  PALETTE,
  SUN_INTENSITY,
} from './look.js';
import {
  buildTankGeometry,
  MUZZLE_TIP_Z,
  type TankGeometry,
  TURRET_Y,
} from './tank.js';
import { armorTexture, concreteTexture, groundTexture, scaleBoxUv } from './textures.js';
import { TOP_HEIGHT, TOP_ZOOM_SCALE, topFrustum, topParticleFov } from './topview.js';
import {
  BOOM_GROUND,
  BOOM_HIT,
  BOOM_KILL,
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
 * Насколько блок утоплен в свою площадку на карте с рельефом. Землю под блоком
 * выравнивают, но по краю площадка сходит на нет за пару клеток, и у самой грани
 * грунт уже чуть ниже. Полметра запаса — и щели под стеной не видно.
 * Столкновениям это ничего не меняет: верх блока остаётся там же, где был.
 */
const SINK = 0.5;

const CAMERA_DISTANCE = 15;
const CAMERA_BASE_HEIGHT = 3.4;
/** Минимальный просвет между камерой и землёй под ней: на рельефе она за холмом. */
const CAMERA_CLEARANCE = 2;

/**
 * Насколько далеко от линии выстрела танк ещё считается тем, во что целятся, м.
 * Метке нужна дальность цели, а не попадание в неё: допуск щедрый намеренно —
 * промахнувшись на корпус, дальность мы всё равно получаем правильную, а вот
 * потеряв цель, метка уехала бы на запасную дальность посреди прицеливания.
 */
const AIM_SNAP_RADIUS = 5;

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
};

/** На какой высоте рвануло: у земли, по корпусу танка или на высоте полёта снаряда. */
const BOOM_HEIGHT: Record<BoomKind, number> = {
  [BOOM_GROUND]: 0.6,
  [BOOM_HIT]: 1.4,
  [BOOM_KILL]: 1.4,
  [BOOM_RICOCHET]: SHELL_HEIGHT,
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
const TRACER_LENGTH = 6;

// --- Отдача ствола ---

/** На сколько метров ствол уходит назад в момент выстрела. */
const RECOIL_BACK = 0.62;
/** Скорость возврата: ствол откатывается рывком, а выходит обратно плавно. */
const RECOIL_RETURN = 8;

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

/**
 * Скорость, с которой корпус ложится на склон, 1/с. Заметно меньше LEAN_RATE, и
 * в этом весь смысл: подвеска отрабатывает землю не мгновенно.
 *
 * Танк стоит ровно на высоте поля, поэтому наклон — единственное, чем корпус
 * может показать, что у него есть вес. Когда он повторял уклон точка в точку,
 * машина читалась наклейкой на грунте: перевалил гребень — и корпус переломился
 * в тот же кадр. С запаздыванием нос на вершине ещё смотрит вверх и опускается
 * уже за ней, то есть ровно так, как это делает настоящая подвеска.
 *
 * Выше 6 запаздывание перестаёт читаться, ниже 4 — углы корпуса начинают
 * черпать грунт на резких перегибах.
 */
const TILT_RATE = 5;

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
   * Корпус с башней. Отдельный узел внутри root нужен, чтобы крен и клевок
   * жили в осях самого танка: root уже повёрнут по курсу, и наклон в его
   * системе координат смешивал бы поворот с креном.
   */
  body: THREE.Group;
  turret: THREE.Group;
  /** Ствол ходит отдельно от башни: по нему играется откат. */
  barrel: THREE.Mesh;
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
  /** Наклон по склону, к которому корпус идёт с запаздыванием. */
  tiltRoll: number;
  tiltPitch: number;
  /** Пройденный путь с прошлого отпечатка и с прошлой пылинки, м. */
  trackDistance: number;
  dustDistance: number;
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
  /**
   * Танк уже вышел из комнаты и держится на сцене только ради остова: как
   * догорит — убираем совсем. Так подбитый бот, которого сервер удаляет тем же
   * тиком, всё-таки успевает сгореть на глазах.
   */
  retire: boolean;
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

  /** Геометрия танка: общая на всех, разница между танками только в цвете. */
  private readonly tankGeo: TankGeometry = buildTankGeometry();

  /** Земля карты. FLAT на аркадных семи; ставится setTerrain перед buildWorld. */
  private terrain: Terrain = FLAT;

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
  });
  private readonly metalMaterial = new THREE.MeshStandardMaterial({
    color: COLOR_METAL,
    roughness: 0.6,
    metalness: 0.25,
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

  /** Рабочие векторы для дульной вспышки: считается она несколько раз в секунду. */
  private readonly muzzlePoint = new THREE.Vector3();

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
   * Земля карты. Ставится до buildWorld: по ней строится сам меш земли, по ней
   * же садятся на грунт танки, следы, взрывы и ящики. Плоская карта — FLAT, и
   * тогда все выборки стоят одно сравнение.
   */
  setTerrain(terrain: Terrain): void {
    this.terrain = terrain;
  }

  /** Высота земли под точкой. Один вызов на месте десятка нулей в аркаде. */
  private groundY(x: number, z: number): number {
    return heightAt(this.terrain, x, z);
  }

  /** Та же выборка функцией: её просят те, кто про рельеф ничего не знает. */
  private readonly groundSampler = (x: number, z: number): number => this.groundY(x, z);

  /**
   * Наклон корпуса на склоне в осях самого корпуса. Положительный rotation.x
   * опускает нос, положительный rotation.z поднимает левый борт — отсюда знаки.
   */
  private groundTilt(
    x: number,
    z: number,
    forwardX: number,
    forwardZ: number,
  ): { pitch: number; roll: number } {
    if (this.terrain.flat) return { pitch: 0, roll: 0 };
    const slope = slopeAt(this.terrain, x, z);
    return {
      pitch: -Math.atan(slope.dx * forwardX + slope.dz * forwardZ),
      roll: Math.atan(slope.dx * forwardZ - slope.dz * forwardX),
    };
  }

  /**
   * Строит землю, стены по периметру и препятствия, присланные сервером.
   * Вызывается заново при смене карты, поэтому вся геометрия мира живёт в одной
   * группе: старую снимаем целиком и освобождаем её буферы, иначе смена карты
   * оставляла бы прошлые блоки и в сцене, и в видеопамяти.
   */
  buildWorld(half: number, obstacles: Box[]): void {
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
      this.groundGeometry(groundSize),
      new THREE.MeshStandardMaterial({
        color: COLOR_GROUND,
        roughness: 1,
        map: this.groundMap,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.world.add(ground);

    // Сетка лежит в одной плоскости и на рельефе висела бы над низинами.
    if (this.terrain.flat) {
      const grid = new THREE.GridHelper(half * 2, half / 2.5, 0x5c6b52, 0x475040);
      grid.position.y = 0.02;
      (grid.material as THREE.Material).transparent = true;
      (grid.material as THREE.Material).opacity = 0.35;
      this.world.add(grid);
    }

    const wallMaterial = new THREE.MeshStandardMaterial({
      color: COLOR_WALL,
      roughness: 0.9,
      map: this.concreteMap,
    });
    // Стена должна перекрывать край карты на любой высоте, поэтому на рельефе она
    // начинается ниже самой глубокой низины и кончается выше самого высокого холма.
    const range = this.terrainRange();
    const wallHeight = 4 + (range.max - range.min);
    const thickness = 2;
    const span = half * 2 + thickness * 2;
    const walls: Array<[number, number, number, number]> = [
      [0, half + thickness / 2, span, thickness],
      [0, -half - thickness / 2, span, thickness],
      [half + thickness / 2, 0, thickness, span],
      [-half - thickness / 2, 0, thickness, span],
    ];
    for (const [x, z, w, d] of walls) {
      const geometry = new THREE.BoxGeometry(w, wallHeight, d);
      scaleBoxUv(geometry, w, wallHeight, d, BLOCK_TILE);
      const wall = new THREE.Mesh(geometry, wallMaterial);
      wall.position.set(x, range.min + wallHeight / 2, z);
      wall.castShadow = true;
      wall.receiveShadow = true;
      this.world.add(wall);
    }

    const boxMaterial = new THREE.MeshStandardMaterial({
      color: COLOR_BOX,
      roughness: 0.85,
      map: this.concreteMap,
    });
    // Низкое укрытие простреливается насквозь, поэтому его надо отличать с одного
    // взгляда: другой цвет и заметно теплее — «за этим не спрячешься».
    const lowMaterial = new THREE.MeshStandardMaterial({
      color: COLOR_LOW_BOX,
      roughness: 1,
      map: this.concreteMap,
    });
    for (const box of obstacles) {
      const material = box.h >= SHELL_HEIGHT ? boxMaterial : lowMaterial;
      // На рельефе блок уходит основанием в свою площадку: землю под ним
      // выровняли, но по краю она сходит на нет, и зазора под гранью быть не должно.
      const sink = this.terrain.flat ? 0 : SINK;
      const height = box.h + sink;
      const geometry = new THREE.BoxGeometry(box.w, height, box.d);
      // Развёртка правится на геометрии, а не отдельным материалом на блок:
      // блоков на карте под сотню, и сотня материалов — это сотня шейдеров.
      scaleBoxUv(geometry, box.w, height, box.d, BLOCK_TILE);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(box.x, (box.y ?? 0) + box.h / 2 - sink / 2, box.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.world.add(mesh);
    }
  }

  /**
   * Земля. На плоской карте это по-прежнему одна плоскость в два треугольника;
   * на рельефе — сетка с шагом поля, растянутая далеко за карту: за стенами
   * видно продолжение той же земли, а не обрыв. Высоты берутся выборкой, и за
   * краем поля она держит высоту ближайшего его края — горизонт получается
   * ровным продолжением карты.
   */
  private groundGeometry(size: number): THREE.PlaneGeometry {
    if (this.terrain.flat) return new THREE.PlaneGeometry(size, size);

    const segments = Math.round(size / TERRAIN_STEP);
    const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
    const position = geometry.attributes.position as THREE.BufferAttribute;
    // Плоскость лежит в XY и разворачивается в мир поворотом на -90° вокруг X,
    // поэтому её Y — это мировой Z с обратным знаком, а высота идёт в Z.
    for (let i = 0; i < position.count; i++) {
      position.setZ(i, this.groundY(position.getX(i), -position.getY(i)));
    }
    geometry.computeVertexNormals();
    return geometry;
  }

  /** Самая глубокая низина и самый высокий холм карты, м. */
  private terrainRange(): { min: number; max: number } {
    if (this.terrain.flat) return { min: 0, max: 0 };
    let min = Infinity;
    let max = -Infinity;
    for (const d of this.terrain.d) {
      if (d < min) min = d;
      if (d > max) max = d;
    }
    return { min: min * 0.1, max: max * 0.1 };
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
    const body = new THREE.Group();
    root.add(body);

    const paintColor = PALETTE[colorIndex % PALETTE.length];
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: paintColor,
      roughness: 0.72,
      metalness: 0.15,
      // Текстура серая и светлая: она умножается на краску, поэтому цвет танка
      // остаётся тем же, а броня перестаёт быть ровной заливкой.
      map: this.armorMap,
    });

    // Геометрия уже слита по материалам и стоит на своих местах: пять мешей
    // на танк вместо двух десятков, и каждый из них — один вызов отрисовки.
    const hull = new THREE.Mesh(this.tankGeo.hull, bodyMaterial);
    hull.castShadow = true;
    hull.receiveShadow = true;
    body.add(hull);

    const running = new THREE.Mesh(this.tankGeo.running, this.trackMaterial);
    running.castShadow = true;
    running.receiveShadow = true;
    body.add(running);

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

    body.add(turret);

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
      turret,
      barrel,
      recoil: 0,
      lastX: 0,
      lastZ: 0,
      lastYaw: 0,
      speed: 0,
      roll: 0,
      pitch: 0,
      kickRoll: 0,
      kickPitch: 0,
      tiltRoll: 0,
      tiltPitch: 0,
      trackDistance: 0,
      dustDistance: 0,
      paint: bodyMaterial,
      paintColor,
      dying: -1,
      smokeAt: 0,
      retire: false,
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

  /** Танк подбит: копоть, перекос, разлёт обломков и горящий остов на WRECK_S. */
  private killTank(handle: TankHandle): void {
    // Танк, которого мы живым не застали, просто не рисуем: взрыв ему устроили
    // до нашего появления, и показывать его сейчас — врать о том, что случилось.
    if (!handle.everSeen) {
      handle.dying = -1;
      handle.root.visible = false;
      return;
    }

    handle.dying = 0;
    handle.smokeAt = 0;
    handle.root.visible = !handle.cloaked;

    handle.paint.color.setHex(handle.paintColor).multiplyScalar(WRECK_DARKEN);
    handle.body.rotation.set(WRECK_PITCH, 0, WRECK_ROLL);
    handle.roll = WRECK_ROLL;
    handle.pitch = WRECK_PITCH;

    // Остов уходит под землю, а тень рисуется отдельным проходом сверху: земля
    // в карту теней не пишет, поэтому провалившийся танк продолжал бы бросать
    // на неё тень — на пустом месте лежало бы тёмное пятно.
    handle.body.traverse((node) => {
      node.castShadow = false;
    });

    // Обломки летят от самого танка, а не от земли под ним: подбитый в прыжке
    // разлетается там, где его застало, иначе куски били бы из-под холма.
    const { x, y, z } = handle.root.position;
    for (let i = 0; i < WRECK_DEBRIS; i++) {
      const course = Math.random() * Math.PI * 2;
      const outward = 3 + Math.random() * 7;
      this.debris.emit(
        x + (Math.random() - 0.5) * 2,
        y + 1.4,
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
    handle.body.position.y = 0;
    handle.body.rotation.set(0, 0, 0);
    handle.roll = 0;
    handle.pitch = 0;
    handle.body.traverse((node) => {
      node.castShadow = true;
    });
    handle.root.visible = !handle.cloaked;
  }

  /** Горящий остов: оседает, дымит и в конце убирается со сцены. */
  private updateWrecks(dt: number): void {
    for (const [id, handle] of this.tanks) {
      if (handle.dying < 0) continue;
      handle.dying += dt;

      if (handle.dying >= WRECK_S) {
        handle.dying = -1;
        handle.root.visible = false;
        if (handle.retire) this.dropTank(id, handle);
        continue;
      }

      handle.body.position.y = wreckSink(handle.dying);
      if (handle.dying < handle.smokeAt) continue;
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
   * Танк ушёл из комнаты. killed — его подбили: тогда сцена оставляет остов
   * догореть и убирает его сама, когда гибель доиграет.
   *
   * Различать обязательно: бота сервер удаляет из комнаты тем же тиком, в
   * котором тот погиб, и «вышел» с «подбит» приходят одним сообщением. Без
   * пометки бот исчезал бы с карты мгновенно — ровно как отключившийся игрок.
   */
  removeTank(id: number, killed = false): void {
    const handle = this.tanks.get(id);
    if (!handle) return;

    if (killed && handle.everSeen && handle.alive) {
      handle.alive = false;
      handle.retire = true;
      this.killTank(handle);
      // Подпись гасит updateLabels: она смотрит на alive и снимет её сама.
      return;
    }
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

  /**
   * y — высота танка. Не задана — берётся из поля: так рисуются аркадные карты,
   * где земля плоская и слать высоту было бы платой ни за что. На рельефе её
   * присылает сервер, потому что танк умеет отрываться от земли, и выборка поля
   * прижимала бы его к грунту ровно в тот момент, ради которого всё затевалось.
   */
  updateTank(
    id: number,
    x: number,
    z: number,
    angle: number,
    turret: number,
    y?: number,
  ): void {
    const handle = this.tanks.get(id);
    if (!handle) return;
    if (handle.alive) handle.everSeen = true;
    handle.root.position.set(x, y ?? this.groundY(x, z), z);
    handle.root.rotation.y = angle;
    // Башня хранится в мировых углах, а её узел — потомок корпуса.
    handle.turret.rotation.y = turret - angle;
  }

  /** Возвышение своего ствола: на рельефе игрок целится и по высоте тоже. */
  setGunPitch(id: number, pitch: number): void {
    const handle = this.tanks.get(id);
    // Ствол — потомок башни и ходит вокруг её оси X; вверх это отрицательный угол.
    if (handle) handle.barrel.rotation.x = -pitch;
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
    const base = this.groundY(x, z);
    const height = base + CAMERA_BASE_HEIGHT + Math.sin(pitch) * zoom;

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
    // На рельефе камера не ныряет в холм за спиной: если земля под ней выше
    // расчётной высоты, поднимаемся над этой землёй.
    const floor = this.groundY(desiredX, desiredZ) + CAMERA_CLEARANCE;
    this.camera.position.set(desiredX, Math.max(this.cameraHeight, floor), desiredZ);

    // Цель взгляда не трясётся вместе с камерой: смещаем только точку съёмки,
    // и толчок выходит поворотом кадра, а не сползанием прицела с танка.
    this.cameraTarget.set(x, base + 2.2, z);
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

    // Камера висит над своим танком, а не над нулевой отметкой: на рельефе он
    // сам ездит по высоте, и кадр обязан ездить вместе с ним.
    const base = this.groundY(x, z);
    this.topCamera.position.set(x, base + TOP_HEIGHT, z);
    // Разворот считаем до тряски: у ортокамеры наклон не качает кадр, а сдвигает
    // всю картинку вбок целиком, и толчок читался бы как рывок карты.
    this.topCamera.lookAt(x, base, z);
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

  /**
   * Дальность до ближайшей живой цели у линии выстрела, м. Никого нет — null.
   *
   * Это нужно метке прицела, и вот зачем. Линия выстрела на экране — линия, а не
   * точка, и метка обязана выбрать на ней место. Камера стоит не на дульном срезе,
   * а примерно в двух метрах в стороне от этой линии, поэтому её точки с разной
   * дальности проецируются в разные места экрана: метка, взятая на тридцати метрах,
   * стоит на экране совсем не там, где та же линия проходит на ста двадцати.
   * Единственная дальность, на которой «метка накрыла танк» значит «попал», —
   * дальность самого танка. Её и берём.
   *
   * Прицеливаться за игрока это не начинает: наводка не двигается, двигается
   * только место метки на уже наведённой линии.
   *
   * Замаскированных пропускаем: цель, которую не видно, не должна выдавать себя
   * тем, что метка встала на её дальность.
   */
  aimTargetRange(
    exclude: number,
    fromX: number,
    fromY: number,
    fromZ: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    maxRange: number,
  ): number | null {
    let best: number | null = null;
    for (const [id, handle] of this.tanks) {
      if (id === exclude || !handle.alive || handle.cloaked) continue;
      const at = handle.root.position;
      const toX = at.x - fromX;
      const toY = at.y + TANK_HEIGHT / 2 - fromY;
      const toZ = at.z - fromZ;

      const along = toX * dirX + toY * dirY + toZ * dirZ;
      if (along <= 0 || along > maxRange) continue;
      if (best !== null && along >= best) continue; // ближний закрывает дальнего

      const offX = toX - dirX * along;
      const offY = toY - dirY * along;
      const offZ = toZ - dirZ * along;
      if (offX * offX + offY * offY + offZ * offZ > AIM_SNAP_RADIUS * AIM_SNAP_RADIUS) continue;
      best = along;
    }
    return best;
  }

  // --- Снаряды ---

  /**
   * Ставит меши по списку из снапшота. Снаряды живут по id: те, кого в списке нет,
   * уже взорвались — их меш уходит в пул, а взрыв прилетает отдельным событием.
   */
  syncShells(
    list: Array<{ id: number; x: number; z: number; y?: number; angle: number; pitch?: number }>,
  ): void {
    for (const handle of this.shells.values()) handle.seen = false;

    for (const shell of list) {
      let handle = this.shells.get(shell.id);
      if (!handle) {
        const group = this.shellPool.pop() ?? this.createShell();
        this.scene.add(group);
        handle = { group, seen: true };
        this.shells.set(shell.id, handle);
      }
      handle.seen = true;
      handle.group.position.set(shell.x, shell.y ?? SHELL_HEIGHT, shell.z);
      // Группа собрана вдоль своего +Z, а угол 0 в игре смотрит в мировой +Z.
      handle.group.rotation.y = shell.angle;
      // Наклон траектории: без него трассер на рельефе лежит горизонтально, а
      // снаряд уходит вверх, и хвост торчит из него вбок.
      handle.group.rotation.x = -(shell.pitch ?? 0);
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
    // Сначала разворот по курсу, потом наклон вокруг уже развёрнутой оси:
    // при обычном XYZ наклон шёл бы вокруг мировой оси X и на курсах, отличных
    // от нуля, заваливал бы трассер набок.
    group.rotation.order = 'YXZ';

    const core = new THREE.Mesh(this.geo.shell, this.shellMaterial);
    core.rotation.x = Math.PI / 2; // капсула стоит вдоль Y — кладём её вдоль полёта
    group.add(core);

    // Конус растёт вдоль своего +Y, поворот на -90° уводит остриё назад, в -Z:
    // хвост сходит на нет позади снаряда, а широким концом сидит на нём.
    const tracer = new THREE.Mesh(this.geo.tracer, this.tracerMaterial);
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
      handle.mesh.position.set(bonus.x, this.groundY(bonus.x, bonus.z) + BONUS_HOVER, bonus.z);
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
      const { x, z } = handle.mesh.position;
      handle.mesh.position.y = this.groundY(x, z) + BONUS_HOVER + bob;
    }
  }

  // --- Взрывы ---

  /**
   * y — высота, на которой снаряд остановился; её присылает сервер только с
   * рельефом. Нет её — взрыв садится на землю под собой, а на плоскости это
   * тот же ноль, что и был.
   */
  boom(x: number, z: number, kind: BoomKind, y?: number): void {
    // Попадание в танк рисуем по его корпусу, то есть от земли под ним. Разрыв о
    // стену — там, где снаряд встал: на рельефе это может быть и высоко на склоне.
    const byTank = kind === BOOM_HIT || kind === BOOM_KILL;
    const at = byTank || y === undefined ? this.groundY(x, z) + BOOM_HEIGHT[kind] : y;
    this.spawnEffect(x, at, z, BOOM_PRESETS[kind]);
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
    const point = handle.turret.localToWorld(this.muzzlePoint.set(0, 0.36, MUZZLE_TIP_Z));
    // Ствол смотрит вдоль +Z башни, а башня крутится только вокруг вертикали.
    const angle = handle.root.rotation.y + handle.turret.rotation.y;

    this.spawnEffect(point.x, point.y, point.z, MUZZLE_PRESET, angle);
    this.spawnEffect(point.x, point.y, point.z, MUZZLE_SMOKE, angle);
    return true;
  }

  /** Запасная вспышка по координатам: танк ещё не доехал до клиента сообщением. */
  muzzleFlash(x: number, z: number, angle: number): void {
    this.spawnEffect(x, this.groundY(x, z) + SHELL_HEIGHT, z, MUZZLE_PRESET, angle);
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
    fx.ring.position.y = this.groundY(x, z) + 0.15 - y;

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
    const kTilt = 1 - Math.exp(-dt * TILT_RATE);

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
        // Танк возродился в другом месте: старый склон к новой земле отношения
        // не имеет, и доводить корпус от него значило бы въехать боком.
        handle.tiltRoll = 0;
        handle.tiltPitch = 0;
        handle.trackDistance = 0;
        handle.dustDistance = 0;
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

      const lean = bodyLean(yawDelta / dt, speed, accel);
      handle.roll += (lean.roll - handle.roll) * k;
      handle.pitch += (lean.pitch - handle.pitch) * k;

      // Наклон по склону кладётся поверх ходового крена: крен — это положение
      // корпуса на подвеске, склон — положение самой подвески на земле. Уклон
      // раскладывается по осям корпуса: вдоль курса он задирает нос, поперёк —
      // кренит на борт.
      //
      // К склону корпус идёт с запаздыванием, а не садится на него сразу: свою
      // высоту танк берёт из поля точка в точку, и наклон — единственное, чем он
      // может показать вес. Без этой задержки он переламывался на гребне в один
      // кадр и читался наклейкой на грунте.
      // В воздухе корпус землю не повторяет: гусеницы её не касаются, и
      // подстраиваться не подо что. Наклон просто застывает тем, каким был на
      // отрыве, и доворачивается уже после касания.
      const airborne = handle.root.position.y > this.groundY(x, z) + GROUND_EPS;
      if (!airborne) {
        const tilt = this.groundTilt(x, z, forwardX, forwardZ);
        handle.tiltRoll += (tilt.roll - handle.tiltRoll) * kTilt;
        handle.tiltPitch += (tilt.pitch - handle.tiltPitch) * kTilt;
      }
      handle.body.rotation.z = handle.roll + handle.kickRoll + handle.tiltRoll;
      handle.body.rotation.x = handle.pitch + handle.kickPitch + handle.tiltPitch;

      // Замаскированный не должен выдавать себя ни следом, ни облаком пыли.
      //
      // В воздухе их не оставляет никто. И след, и пыль родятся от трения траков
      // о грунт, а под летящим танком грунта нет: без этой проверки пыль била
      // из земли метром-другим ниже машины и выдавала прыжок за езду по склону.
      if (handle.cloaked || airborne || step === 0) continue;

      handle.trackDistance += step;
      handle.dustDistance += step;
      const laysTrack = handle.trackDistance >= TRACK_STEP;
      const raisesDust = handle.dustDistance >= DUST_STEP && Math.abs(speed) >= DUST_MIN_SPEED;
      if (!laysTrack && !raisesDust) continue;
      if (laysTrack) handle.trackDistance %= TRACK_STEP;
      if (raisesDust) handle.dustDistance %= DUST_STEP;

      for (const side of [-1, 1]) {
        const at = trackAnchor(x, z, yaw, side);
        // Отпечаток кладётся по земле: на склоне его углы стоят на разной высоте,
        // иначе квадрат следа торчал бы из грунта одним краем.
        if (laysTrack) this.tracks.emit(at.x, at.z, yaw, this.clock, this.groundSampler);
        if (!raisesDust) continue;
        // Пыль выбрасывает назад из-под трака и подбрасывает вверх. Высота —
        // земля под самим траком, а не под серединой танка: на склоне борта
        // стоят на разных уровнях, и сюда мы попадаем только пока они её касаются.
        this.dust.emit(
          at.x,
          this.groundY(at.x, at.z) + 0.25,
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
