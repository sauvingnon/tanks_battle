import * as THREE from 'three';

import { MAX_HP, SHELL_HEIGHT } from '../shared/constants.js';
import { wrapAngle } from '../shared/sim.js';
import {
  bodyLean,
  DEBRIS_FIELD,
  DUST_FIELD,
  ParticleField,
  TRACK_SIDE,
  trackAnchor,
  TrackMarks,
  WRECK_S,
  wreckSink,
} from './ground.js';
import {
  BOOM_GROUND,
  BOOM_HIT,
  BOOM_KILL,
  BOOM_RICOCHET,
  type Box,
  type BoomKind,
  type SnapshotBonus,
} from '../shared/types.js';

/** Цвета корпусов; сервер присылает индекс в этой палитре. */
const PALETTE = [0x4f7d5a, 0x7a5f9c, 0xa8632f, 0x3f6f96, 0x8a8f3a, 0x9c4a52, 0x3f8f88, 0x8a6a44];

/** Цвета ящиков: ремонт, урон, заряжание, ход, маскировка. */
export const BONUS_COLORS = [0x6ad46a, 0xff7a4d, 0xffd24d, 0x4db8ff, 0xb388ff];

/** На какой высоте висит ящик над землёй. */
const BONUS_HOVER = 1.7;

const CAMERA_DISTANCE = 15;
const CAMERA_BASE_HEIGHT = 3.4;

/**
 * Яркость сцены. Крутить эти четыре числа, если картинка кажется тёмной или
 * пересвеченной; оттенки света задаются отдельно и их менять не нужно.
 */
const EXPOSURE = 1.18; // общая экспозиция поверх тонмаппинга
const SUN_INTENSITY = 2.7; // прямой свет: даёт блики и тени
const AMBIENT_INTENSITY = 2.0; // заполняющий свет: определяет, насколько черны тени
const FILL_INTENSITY = 0.5; // подсветка с теневой стороны, чтобы корпуса не проваливались

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
}

const BOOM_PRESETS: Record<BoomKind, EffectPreset> = {
  [BOOM_GROUND]: { radius: 1.6, life: 0.34, color: 0xffb257 },
  [BOOM_HIT]: { radius: 2.2, life: 0.4, color: 0xffd27a },
  [BOOM_KILL]: { radius: 4.2, life: 0.75, color: 0xff8a3c, ring: true },
  // Рикошет — короткая белая искра: снаряд жив и полетел дальше, взрыва не было.
  [BOOM_RICOCHET]: { radius: 0.9, life: 0.16, color: 0xfff4c8 },
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
const MUZZLE_PRESET: EffectPreset = { radius: 0.85, life: 0.085, color: 0xfff3d0, cone: 4 };

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

/** Штатное положение ствола внутри башни по оси Z. */
const BARREL_Z = 2.3;
/** Дульный срез в координатах башни: ствол длиной 3 стоит центром на BARREL_Z. */
const MUZZLE_TIP_Z = BARREL_Z + 1.5;
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
const SHAKE_AMPLITUDE = 0.6;
const SHAKE_FREQ = 21;

// --- Ходовая: крен, следы, пыль ---

/** Скорость подхода к целевому наклону корпуса. */
const LEAN_RATE = 9;

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
  label: HTMLElement;
  hpFill: HTMLElement;
  /** Размеры подписи в пикселях, замеряются один раз — текст не меняется. */
  labelHalfWidth: number;
  labelHeight: number;
  labelVisible: boolean;
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

  /** Земля, стены и блоки текущей карты: при смене карты группа собирается заново. */
  private readonly world = new THREE.Group();

  /** Следы гусениц, пыль и обломки: живут отдельно от карты, но чистятся с ней. */
  private readonly tracks = new TrackMarks();
  private readonly dust = new ParticleField(DUST_FIELD);
  private readonly debris = new ParticleField(DEBRIS_FIELD);
  /** Часы сцены в секундах: по ним шейдеры считают возраст следов и пылинок. */
  private clock = 0;

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
    hull: new THREE.BoxGeometry(3, 1, 4.4),
    track: new THREE.BoxGeometry(0.78, 0.85, 4.9),
    turret: new THREE.BoxGeometry(2, 0.75, 2.3),
    barrel: new THREE.CylinderGeometry(0.14, 0.16, 3, 12),
    cupola: new THREE.CylinderGeometry(0.34, 0.34, 0.3, 12),
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
        emissiveIntensity: 0.5,
        roughness: 0.4,
        metalness: 0.1,
      }),
  );

  private readonly bonuses = new Map<number, { mesh: THREE.Mesh; seen: boolean }>();
  /** Общая фаза вращения ящиков — чтобы они крутились в такт, а не вразнобой. */
  private bonusSpin = 0;

  /** Снаряд светится сам: он мелкий и должен читаться на любом фоне. */
  private readonly shellMaterial = new THREE.MeshBasicMaterial({ color: 0xffd27a });

  /**
   * Трассер складывается со светом сцены, а не перекрывает его, и не пишет в
   * буфер глубины: иначе полупрозрачный хвост вырезал бы дыру в том, что за ним.
   */
  private readonly tracerMaterial = new THREE.MeshBasicMaterial({
    color: 0xff9d3a,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  private readonly trackMaterial = new THREE.MeshStandardMaterial({
    color: 0x23262b,
    roughness: 0.95,
  });
  private readonly metalMaterial = new THREE.MeshStandardMaterial({
    color: 0x3a3f47,
    roughness: 0.6,
    metalness: 0.25,
  });

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

    this.scene.background = new THREE.Color(0x121822);
    // Ближняя граница вынесена за игровую зону (карта 140 м в поперечнике), чтобы туман
    // не съедал поле, но дальняя стена через всю карту уже заметно подёрнута дымкой.
    this.scene.fog = new THREE.Fog(0x121822, 110, 300);

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
  buildWorld(half: number, obstacles: Box[]): void {
    this.clearWorld();
    // Следы, пыль и обломки от прошлой карты к новой отношения не имеют.
    this.tracks.clear();
    this.dust.clear();
    this.debris.clear();

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(half * 6, half * 6),
      new THREE.MeshStandardMaterial({ color: 0x39412f, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.world.add(ground);

    const grid = new THREE.GridHelper(half * 2, half / 2.5, 0x5c6b52, 0x475040);
    grid.position.y = 0.02;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    this.world.add(grid);

    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x4a5160, roughness: 0.9 });
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
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, wallHeight, d), wallMaterial);
      wall.position.set(x, wallHeight / 2, z);
      wall.castShadow = true;
      wall.receiveShadow = true;
      this.world.add(wall);
    }

    const boxMaterial = new THREE.MeshStandardMaterial({ color: 0x6d6357, roughness: 0.85 });
    // Низкое укрытие простреливается насквозь, поэтому его надо отличать с одного
    // взгляда: другой цвет и заметно теплее — «за этим не спрячешься».
    const lowMaterial = new THREE.MeshStandardMaterial({ color: 0x8a6a3f, roughness: 1 });
    for (const box of obstacles) {
      const material = box.h >= SHELL_HEIGHT ? boxMaterial : lowMaterial;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(box.w, box.h, box.d), material);
      mesh.position.set(box.x, box.h / 2, box.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.world.add(mesh);
    }
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
    });

    const hull = new THREE.Mesh(this.geo.hull, bodyMaterial);
    hull.position.y = 1.15;
    hull.castShadow = true;
    hull.receiveShadow = true;
    body.add(hull);

    for (const side of [-1, 1]) {
      const track = new THREE.Mesh(this.geo.track, this.trackMaterial);
      track.position.set(side * TRACK_SIDE, 0.5, 0);
      track.castShadow = true;
      track.receiveShadow = true;
      body.add(track);
    }

    const turret = new THREE.Group();
    turret.position.y = 1.78;

    const turretBody = new THREE.Mesh(this.geo.turret, bodyMaterial);
    turretBody.position.y = 0.32;
    turretBody.castShadow = true;
    turret.add(turretBody);

    const cupola = new THREE.Mesh(this.geo.cupola, this.metalMaterial);
    cupola.position.set(0.55, 0.82, -0.3);
    cupola.castShadow = true;
    turret.add(cupola);

    const barrel = new THREE.Mesh(this.geo.barrel, this.metalMaterial);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.36, BARREL_Z);
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
      trackDistance: 0,
      dustDistance: 0,
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
    for (const handle of this.tanks.values()) {
      if (handle.dying < 0) continue;
      handle.dying += dt;

      if (handle.dying >= WRECK_S) {
        handle.dying = -1;
        handle.root.visible = false;
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

  removeTank(id: number): void {
    const handle = this.tanks.get(id);
    if (!handle) return;
    handle.label.remove();
    this.scene.remove(handle.root);
    this.tanks.delete(id);
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
    this.camera.position.x += Math.sin(t * 1.7) * power;
    this.camera.position.y += Math.sin(t * 2.3 + 1.1) * power;
    this.camera.position.z += Math.sin(t * 1.3 + 2.7) * power;
  }

  /**
   * Точка мира в координатах экрана, в тех же пикселях, что и ники.
   * null — точка за камерой, рисовать нечего.
   */
  project(x: number, y: number, z: number): { x: number; y: number } | null {
    this.projected.set(x, y, z).project(this.camera);
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
  syncShells(list: Array<{ id: number; x: number; z: number; angle: number }>): void {
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
      handle.group.position.set(shell.x, SHELL_HEIGHT, shell.z);
      // Группа собрана вдоль своего +Z, а угол 0 в игре смотрит в мировой +Z.
      handle.group.rotation.y = shell.angle;
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

    for (const mesh of [fx.flash, fx.ring, fx.cone]) {
      (mesh.material as THREE.MeshBasicMaterial).color.setHex(preset.color);
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

    for (const handle of this.tanks.values()) {
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
      handle.body.rotation.z = handle.roll;
      handle.body.rotation.x = handle.pitch;

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
      handle.barrel.position.z = BARREL_Z - handle.recoil * RECOIL_BACK;
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
    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
  }

  /**
   * Ники позиционируем сами, а не через CSS2DRenderer: тот ставит дробные
   * пиксели, из-за чего текст на ходу становится мыльным и дрожит.
   */
  private updateLabels(): void {
    this.camera.updateMatrixWorld();

    for (const handle of this.tanks.values()) {
      this.projected.set(
        handle.root.position.x,
        LABEL_HEIGHT,
        handle.root.position.z,
      );
      const distance = this.projected.distanceTo(this.camera.position);
      this.projected.project(this.camera);

      // z вне [-1, 1] значит «за камерой или за дальней плоскостью».
      const visible =
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
    this.renderer.setSize(width, height, false);
    // Размер частицы задан в метрах, а шейдер выдаёт пиксели устройства.
    const heightPx = height * this.renderer.getPixelRatio();
    this.dust.setViewport(heightPx, this.camera.fov);
    this.debris.setViewport(heightPx, this.camera.fov);
  };
}
