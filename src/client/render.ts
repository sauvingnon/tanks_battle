import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { MAX_HP, MODULE_SLOT_ARMOR, MODULE_SLOT_CAMO, MODULE_SLOT_ENGINE, MODULE_SLOT_GUN, MODULE_SLOT_LOADER, ROYALE_MODULE_TIER_COLORS, royaleModule, SHELL_HEIGHT } from '../shared/constants.js';
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
  COLOR_CAR,
  COLOR_ROAD,
  COLOR_SIDEWALK,
  COLOR_ROOF,
  COLOR_TRACK,
  COLOR_TREE_TRUNK,
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
  TREE_LEAF_COLORS,
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
const LEAF_CUBE = 1.55; // м, шаг посадки листовых комков
const BUSH_LAYERS = 3;
const LEAF_PALETTE = LEAF_COLORS.map((c) => new THREE.Color(c));
/** Радиус визуального толчка листвы вокруг корпуса танка. */
const BUSH_PUSH_RADIUS = 4.8;
/** Максимальный сдвиг отдельного комка от корпуса, м. */
const BUSH_PUSH_DISTANCE = 1.35;
/** Куст быстро расходится от танка, но заметно мягче собирается обратно. */
const BUSH_PUSH_RESPONSE = 14;
const BUSH_RETURN_RESPONSE = 4.5;

/** Визуальные профили не меняют физику куста — только его силуэт. */
const BUSH_PROFILES = [
  // Широкий округлый куст: плотный низ и мягкая редкая верхушка.
  { height: 3.05, width: 1.12, depth: 1.04, topDrop: 0.1, topSparse: 0.16 },
  // Высокий куст: лучше читается как укрытие и ломает горизонтальную линию.
  { height: 4.0, width: 0.94, depth: 0.96, topDrop: 0.24, topSparse: 0.34 },
  // Низкий раскидистый куст: остаётся заметным, но не выглядит стеной.
  { height: 2.7, width: 1.24, depth: 1.16, topDrop: 0.04, topSparse: 0.08 },
] as const;

function bushSeed(box: Box): number {
  return Math.abs(Math.sin(box.x * 12.9898 + box.z * 78.233 + box.w * 37.719 + box.d * 19.193) * 43758.5453) % 1;
}

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
  | 'bush'
  | 'roof'
  | 'gate'
  | 'road'
  | 'sidewalk'
  | 'pole'
  | 'car'
  | 'tree'
  | 'barrel'
  | 'pipe'
  | 'wreck';

function boxLook(box: Box, mapId = 0): BoxLook {
  if (box.style === 'tree') return 'tree';
  if (box.style === 'barrel') return 'barrel';
  if (box.style === 'pipe') return 'pipe';
  if (box.style === 'wreck') return 'wreck';
  if (box.solid === false) {
    if (box.style === 'gate') return 'gate';
    if (box.style === 'road') return 'road';
    if (box.style === 'sidewalk') return 'sidewalk';
    if (box.style === 'pole') return 'pole';
    if (box.style === 'car') return 'car';
    return 'roof';
  }
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
    // Раньше здесь стояло 'bush' — тот же зелёный силуэт, что и у настоящего
    // куста, но isBush() выше уже сказал «нет» (не дотянул до BUSH_MIN_SIZE
    // хотя бы по одной стороне). Танк в такой силуэт не заезжает, вид звал
    // заехать — ровно тот баг с «мелкими кустами». Мелкий низкий объект,
    // который не куст, должен выглядеть предметом, а не растением.
    return 'crate';
  }
  if (box.h >= 7 && aspect < 1.35) return 'tower';
  if (aspect >= WALL_ASPECT) return 'wall';
  if (aspect >= 1.45 || area >= 190) return 'warehouse';
  if (shortest >= HOUSE_FOOTPRINT) return 'house';
  return shortest >= 6 ? 'guardhouse' : 'crate';
}

/** Лёгкий оттенок грунта для атмосферы карты; физика у всех вариантов одна. */
const GROUND_COLORS = [
  0x39412f, // Кремль — базовый оливковый грунт
  0x414832, // Форт — сухая трава
  0x3b403c, // Город — холодный городской прах
  0x493f32, // Овраг — тёмная земля
  0x514a32, // Окопы — выжженная почва
  0x41443b, // Автопарк — бетонно-грунтовая смесь
  0x67543a, // Дюны — тёплый песок
  0x46503a, // Холмы — зелёно-серый склон
  0x414d36, // Долина — влажная трава
  0x3d4441, // Промзона — холодный техногенный грунт
  0x4b4d3b, // Рубеж — выцветшая полевая трава
  0x35383a, // Мегаполис — холодный асфальт сплошной застройки
  0x5b5038, // Перевал — сухой каменистый грунт
  0x4a4840, // Руины — пыль и старый бетон
  0x62523b, // Карьер — охристая порода
];

function groundColor(mapId: number): number {
  return GROUND_COLORS[mapId] ?? COLOR_GROUND;
}

/** Крупные варианты почвы: карта получает ритм районов, а не случайный камуфляж. */
const GROUND_PATCH_PALETTES: number[][] = [
  [0x4b5437, 0x6b5b3c, 0x303b2d],
  [0x5d5d3e, 0x76623d, 0x3c4935],
  [0x4d5050, 0x6b6251, 0x343b3b],
  [0x5b4a35, 0x704c32, 0x38352d],
  [0x665538, 0x4e4932, 0x7b633b],
  [0x53534a, 0x75654b, 0x383e3b],
  [0x8a6d43, 0x6d5937, 0x9b7d4a],
  [0x53603c, 0x756243, 0x3c4c36],
  [0x4f603b, 0x6f7045, 0x3b4b34],
  [0x4d5550, 0x76604a, 0x35403d],
  [0x566044, 0x756547, 0x3a4636],
  [0x76613c, 0x4e4634, 0x8a6c43],
  [0x625b4d, 0x413f39, 0x7b6b55],
  [0x785f3e, 0x4b4132, 0x956f42],
];

/** Дробная часть синусоидального хеша — стабильное число от 0 до 1. */
function patchNoise(value: number): number {
  const noise = Math.sin(value) * 43758.5453;
  return noise - Math.floor(noise);
}

/**
 * Трава — один инстансированный low-poly пучок, без физики и теней. Раньше
 * пучок был тремя одинаковыми спицами строго через 120° — с земли это
 * читалось как торчки, а не трава. Теперь у пучка пять разновысоких лезвий
 * со своим наклоном и разбросом углов (запечено в геометрию один раз, у
 * каждого инстанса вдобавок свой поворот/масштаб — одинаковых кустиков не
 * видно), плюс вершинный градиент тёмный-у-земли/светлый-на-кончике даёт
 * объём без лишних инстансов и без шейдеров.
 */
const GRASS_COLORS = [0x6d8f45, 0x87a355, 0x577a3c, 0x9aa15c, 0x4f6e39];
const GRASS_PAD = 1.8;
const GRASS_TIP_TINT: [number, number, number] = [1.22, 1.24, 0.92];
const GRASS_BASE_TINT: [number, number, number] = [0.6, 0.62, 0.58];

function grassTuftGeometry(): THREE.BufferGeometry {
  const vertices: number[] = [];
  const colors: number[] = [];
  const bladeCount = 5;
  for (let i = 0; i < bladeCount; i++) {
    // Не идеальный веер: у каждого лезвия свой угол, длина, наклон и ширина —
    // запечённая асимметрия, которая при случайном повороте инстанса не
    // повторяется на глаз.
    const jitter = Math.sin((i + 1) * 12.9898) * 43758.5453;
    const angleJitter = (jitter - Math.floor(jitter) - 0.5) * 0.9;
    const angle = (i / bladeCount) * Math.PI * 2 + angleJitter;
    const lengthJitter = Math.abs(Math.sin((i + 1) * 7.233));
    const height = 0.68 + lengthJitter * 0.5;
    const lean = 0.16 + lengthJitter * 0.22; // общий наклон в сторону X — «ветер»
    const width = 0.1 + Math.abs(Math.cos((i + 1) * 5.117)) * 0.07;
    const dirX = Math.cos(angle) * (0.22 + lengthJitter * 0.16) + lean;
    const dirZ = Math.sin(angle) * (0.22 + lengthJitter * 0.16);
    const sideX = -Math.sin(angle) * width;
    const sideZ = Math.cos(angle) * width;
    vertices.push(
      -sideX, 0, -sideZ,
      sideX, 0, sideZ,
      dirX, height, dirZ,
    );
    colors.push(...GRASS_BASE_TINT, ...GRASS_BASE_TINT, ...GRASS_TIP_TINT);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Индекс цвета из палитры по позиции, не по порядковому номеру попытки —
 * низкочастотный шум даёт пятна одного оттенка (клочки суше/зеленее), а не
 * равномерную рябь по всей карте, как было с круговым перебором.
 */
function grassPatchColor(x: number, z: number, mapId: number): number {
  const n = Math.sin(x * 0.045 + mapId * 5.7) * Math.cos(z * 0.037 - mapId * 3.1);
  const idx = Math.floor(((n + 1) / 2) * GRASS_COLORS.length) % GRASS_COLORS.length;
  return GRASS_COLORS[idx];
}

const GRASS_WIND_STRENGTH = 0.16;
const GRASS_WIND_SPEED = 1.7;
// Локальные единицы геометрии пучка (не метры карты) — радиус и сила толчка
// подобраны под масштаб самого лезвия, см. комментарий у localPlayer ниже.
const GRASS_PUSH_RADIUS = 5.4;
const GRASS_PUSH_STRENGTH = 1.45;
/** Далеко за картой — толчок гасится smoothstep'ом сам, без доп. флага «нет танка». */
const GRASS_PUSH_IDLE = 100000;

interface GrassShaderHandles {
  material: THREE.MeshStandardMaterial;
  wind: { value: number };
  /** Мировые x,z своего танка; когда его нет — GRASS_PUSH_IDLE, толчка не видно. */
  playerPos: THREE.Vector2;
}

/**
 * Покачивание травы и её смятие под своим танком — оба эффекта на GPU в
 * вершинном шейдере, а не CPU-циклом по инстансам (тем более после урока с
 * толчком кустов от танка — тот же подход на десятках тысяч пучков посадил
 * бы кадр так же). Обновляются два uniform'а раз в кадр (O(1) по CPU),
 * дальше видеокарта сама параллелит сдвиг по всем вершинам и инстансам
 * разом — instance-матрицы вообще не трогаются, в отличие от кустов.
 *
 * Толчок — только для своего танка (один uniform вместо массива на 40 душ в
 * BR, и один и тот же приём для любого числа игроков не стоит дороже).
 * Наклоняется только кончик — у геометрии пучка ровно два уровня высоты
 * (0 у земли, > 0 на остриё), этого достаточно, чтобы отличить базу от
 * кончика без отдельного атрибута.
 */
function createGrassMaterial(): GrassShaderHandles {
  const wind = { value: 0 };
  const playerPos = new THREE.Vector2(GRASS_PUSH_IDLE, GRASS_PUSH_IDLE);
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.92,
    flatShading: true,
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWind = wind;
    shader.uniforms.uPlayerPos = { value: playerPos };
    shader.vertexShader = `uniform float uWind;\nuniform vec2 uPlayerPos;\n${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        float tip = position.y > 0.01 ? 1.0 : 0.0;
        vec3 tuftPos = instanceMatrix[3].xyz;

        // Ветер: наклон кончика, фаза от мировой позиции пучка — соседние
        // тufts качаются синхронно, читается как порыв, идущий по полю.
        float gust = sin(uWind * 0.55 + (tuftPos.x + tuftPos.z) * 0.07) * 0.5 + 0.5;
        float phase = uWind * ${GRASS_WIND_SPEED.toFixed(2)} + tuftPos.x * 0.35 + tuftPos.z * 0.35;
        float sway = ${GRASS_WIND_STRENGTH.toFixed(2)} * tip * (0.35 + gust * 0.85);
        transformed.x += sin(phase) * sway;
        transformed.z += cos(phase * 0.82) * sway * 0.7;

        // Толчок от своего танка: сначала считаем расстояние в мировых
        // координатах, затем переводим только направление в локальные оси
        // инстанса. Обратная матрица здесь не нужна: она дорогая и на части
        // WebGL-драйверов ломает компиляцию шейдера травы.
        vec3 worldVertex = (instanceMatrix * vec4(transformed, 1.0)).xyz;
        vec2 fromPlayer = worldVertex.xz - uPlayerPos;
        float pushDist = length(fromPlayer);
        float pressure = tip * (1.0 - smoothstep(0.0, ${GRASS_PUSH_RADIUS.toFixed(2)}, pushDist));
        float push = pressure * ${GRASS_PUSH_STRENGTH.toFixed(2)};
        vec2 worldPushDir = pushDist > 0.001 ? fromPlayer / pushDist : vec2(0.0, 1.0);
        float instanceScale = max(length(instanceMatrix[0].xz), 0.001);
        vec2 pushDir = vec2(
          dot(worldPushDir, instanceMatrix[0].xz),
          dot(worldPushDir, instanceMatrix[2].xz)
        ) / instanceScale;
        // Под гусеницей трава не только расходится, но и пригибается к земле.
        transformed.y *= 1.0 - pressure * 0.88;
        transformed.xz += pushDir * push;
      }`,
    );
  };
  return { material, wind, playerPos };
}

type WeatherKind = 'clear' | 'mist' | 'rain' | 'snow';

interface EnvironmentProfile {
  sky: number;
  fog: number;
  fogNear: number;
  fogFar: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  fill: number;
  fillIntensity: number;
  sun: number;
  sunIntensity: number;
  weather: WeatherKind;
  night: boolean;
}

/** Четыре дешёвых профиля: выбор зависит от карты, поэтому одинаков у всех клиентов. */
const ENVIRONMENT_PROFILES: EnvironmentProfile[] = [
  { sky: 0x496783, fog: 0x496783, fogNear: 260, fogFar: 1200, hemiSky: 0x9fb8d8, hemiGround: 0x4a4f3e, hemiIntensity: 1, fill: 0xbfd4ea, fillIntensity: 0.42, sun: 0xffe6bd, sunIntensity: 1, weather: 'clear', night: false },
  { sky: 0x817d79, fog: 0x827c72, fogNear: 180, fogFar: 920, hemiSky: 0xd2b9a0, hemiGround: 0x4c473c, hemiIntensity: 0.78, fill: 0xd3b49d, fillIntensity: 0.3, sun: 0xffb477, sunIntensity: 0.72, weather: 'mist', night: false },
  { sky: 0x4e5364, fog: 0x555661, fogNear: 150, fogFar: 760, hemiSky: 0x8d91ab, hemiGround: 0x353943, hemiIntensity: 0.58, fill: 0x8795bd, fillIntensity: 0.24, sun: 0xd78360, sunIntensity: 0.5, weather: 'rain', night: false },
  { sky: 0x111a31, fog: 0x17233b, fogNear: 85, fogFar: 520, hemiSky: 0x455c91, hemiGround: 0x171c27, hemiIntensity: 0.32, fill: 0x6077aa, fillIntensity: 0.16, sun: 0x6e83b6, sunIntensity: 0.2, weather: 'snow', night: true },
];

/** Одна запланированная перемена за матч: достаточно заметная, но не ломающая бой. */
const ENVIRONMENT_CHANGE_DELAY_S = 75;
const ENVIRONMENT_CHANGE_DURATION_S = 18;

function weatherOpacity(kind: WeatherKind): number {
  return kind === 'snow' ? 0.62 : kind === 'rain' ? 0.38 : 0;
}

function weatherSize(kind: WeatherKind): number {
  return kind === 'snow' ? 0.28 : 0.14;
}

function weatherColor(kind: WeatherKind): number {
  return kind === 'snow' ? 0xe5efff : 0x9fc8dc;
}

/**
 * Декоративная форма препятствия. Коллизии считают физические размеры Box
 * (collisionW/collisionD или collisionRadius, если они заданы), поэтому фаски и крона не меняют
 * проезды и прострелы — это только более живой силуэт.
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
  roadBody: THREE.BufferGeometry[];
  sidewalkBody: THREE.BufferGeometry[];
  poleBody: THREE.BufferGeometry[];
  carBody: THREE.BufferGeometry[];
  carGlass: THREE.BufferGeometry[];
  carWheel: THREE.BufferGeometry[];
  treeTrunk: THREE.BufferGeometry[];
  treeLeaf: THREE.BufferGeometry[];
  treeLeafAlt: THREE.BufferGeometry[];
  roofBody: THREE.BufferGeometry[];
  gateBody: THREE.BufferGeometry[];
  roof: THREE.BufferGeometry[];
  trim: THREE.BufferGeometry[];
  windows: THREE.BufferGeometry[];
  doors: THREE.BufferGeometry[];
  rocks: THREE.BufferGeometry[];
  // Корпуса самих препятствий: раньше каждый — свой Mesh, теперь копятся
  // здесь и сливаются по материалу тем же способом, что и декор выше —
  // на карте под сотню коробок, а после слияния это три драв-колла.
  houseBody: THREE.BufferGeometry[];
  crateBody: THREE.BufferGeometry[];
  wallBoxBody: THREE.BufferGeometry[];
}

function createDecorBatch(): DecorBatch {
  return {
    roadBody: [],
    sidewalkBody: [],
    poleBody: [],
    carBody: [],
    carGlass: [],
    carWheel: [],
    treeTrunk: [],
    treeLeaf: [],
    treeLeafAlt: [],
    roofBody: [],
    gateBody: [],
    roof: [],
    trim: [],
    windows: [],
    doors: [],
    rocks: [],
    houseBody: [],
    crateBody: [],
    wallBoxBody: [],
  };
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
 * Высота камеры от первого лица: ниже прежней командирской точки, ближе к
 * опущенной линии орудия, чтобы камера и новая маска воспринимались одной
 * конструкцией. Высота снаряда при этом остаётся авторитетной в симуляции.
 */
const FPV_HEIGHT = TURRET_Y + 0.95;
/** Насколько далеко вынесена точка, куда смотрит камера от первого лица — далеко за горизонт, важно только направление. */
const FPV_LOOK = 60;

/** Высота, на которой висит ник над центром танка. */
const LABEL_HEIGHT = 3.7;
/** Дальше этого ники не рисуем — всё равно нечитаемо, а DOM грузится. */
const LABEL_MAX_DISTANCE = 160;

/** Сколько висит цифра урона, с. */
const DAMAGE_NUMBER_LIFE = 1.1;
/** На сколько метров цифра всплывает за свою жизнь. */
const DAMAGE_NUMBER_RISE = 2.4;
/** Доля жизни, после которой цифра гаснет, а не стоит в полную силу. */
const DAMAGE_NUMBER_FADE_FROM = 0.55;

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

/** Единственный настоящий свет — локальная вспышка у пушки игрока. */
const LOCAL_MUZZLE_LIGHT = {
  intensity: 68,
  distance: 21,
  decay: 2,
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
  /** Базовые корпуса гусениц и общий пакет колёс: скрываются, когда лента слетела. */
  runningBase: THREE.Mesh;
  wheels: THREE.Mesh;
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
  /** Палитра до командной окраски BR: в обычных режимах сохраняем её как есть. */
  basePaintColor: number;
  /** Текущая окраска среды: 0 — штатная, 1 — кусты, 2 — грунт. */
  camouflageStyle: 0 | 1 | 2;
  camouflageColor?: number;
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
   * Подпись строится лениво (см. ensureLabel): подписан только товарищ, а
   * на BR-матч это obычно 1-3 танка из 40 — остальным 3-4 десяткам DOM-узел
   * и вынужденный offsetWidth (форсированная раскладка) не нужны вовсе.
   */
  label: HTMLElement | null;
  hpFill: HTMLElement | null;
  /** Размеры подписи в пикселях, замеряются один раз при постройке — текст не меняется. */
  labelHalfWidth: number;
  labelHeight: number;
  labelVisible: boolean;
  /** Данные для отложенной постройки подписи, когда она наконец понадобится. */
  name: string;
  isSelf: boolean;
  isBot: boolean;
  /** Текущая командная раскраска — нужна, чтобы применить класс сразу при отложенной постройке. */
  faction: TankFaction;
  /**
   * Разрешает ли подпись сам режим боя: подписан только товарищ. Флаг ставит
   * main.ts, потому что «товарищ» — это про команды и режим комнаты, а рендер
   * про них ничего не знает.
   */
  plated: boolean;
  /** Подбитый танк не рисуется и не подписывается. */
  alive: boolean;
  /** Под «Маскировкой» и достаточно далеко: корпус и подпись не рисуются. */
  cloaked: boolean;
  hp: number;
  /** Парашют на время высадки BR. */
  canopy: THREE.Mesh;
  /** Фары видны у всех танков ночью; настоящие источники света есть только у своего. */
  headlights: THREE.Group;
  headlightSpots: THREE.SpotLight[];
  rearLightSpots: THREE.SpotLight[];
}

interface ContactMarkerHandle {
  el: HTMLDivElement;
  x: number;
  z: number;
  until: number;
}

export type TankFaction = 'self' | 'ally' | 'enemy' | 'neutral';

const FACTION_PAINT: Record<Exclude<TankFaction, 'neutral'>, number> = {
  self: 0xd0a34f,
  ally: 0x36a9bd,
  enemy: 0xd6534d,
};
const CAMO_BUSH_PAINT = 0x4f8f4e;

/** Одна всплывающая цифра урона: DOM-узел плюс мировая точка, от которой он растёт. */
interface DamageNumberHandle {
  el: HTMLElement;
  x: number;
  z: number;
  /** Высота старта; сама цифра всплывает вверх на DAMAGE_NUMBER_RISE. */
  baseY: number;
  /** Небольшой случайный снос в сторону — иначе очередь попаданий рисует числа стопкой. */
  driftX: number;
  age: number;
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

interface BushHandle {
  mesh: THREE.InstancedMesh;
  opaqueMaterial: THREE.MeshStandardMaterial;
  fpvMaterial: THREE.MeshStandardMaterial;
  centerX: number;
  centerZ: number;
  halfW: number;
  halfD: number;
  /** Исходные матрицы нужны, чтобы анимация не накапливала погрешность. */
  baseMatrices: THREE.Matrix4[];
  baseX: Float32Array;
  baseZ: Float32Array;
  offsetX: Float32Array;
  offsetZ: Float32Array;
  displaced: boolean;
}

export class Scene3D {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  /** Земля, стены и блоки текущей карты: при смене карты группа собирается заново. */
  private readonly world = new THREE.Group();
  /** Граница безопасной зоны BR; сама зона не перекрывает рельеф и укрытия. */
  private readonly royaleZoneRing = new THREE.Mesh(
    new THREE.RingGeometry(0.985, 1, 128),
    new THREE.MeshBasicMaterial({
      color: 0x8ed8ff,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  /** Прозрачная вертикальная граница BR: видна как надвигающаяся стена, а не как HUD-кольцо. */
  private readonly royaleZoneWall = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 1, 128, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0x8ed8ff,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    }),
  );
  /** Самолёт высадки: живёт вне карты и показывается только в drop-фазе BR. */
  private readonly royalePlane = new THREE.Group();
  private readonly royaleDropCanopyGeometry = new THREE.SphereGeometry(2.1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  private readonly royaleDropCanopyMaterial = new THREE.MeshStandardMaterial({
    color: 0xe5e0cf,
    roughness: 0.85,
    flatShading: true,
  });
  private royaleDropHeight = 0;

  /** Следы гусениц, пыль и обломки: живут отдельно от карты, но чистятся с ней. */
  private readonly tracks = new TrackMarks();
  private readonly dust = new ParticleField(DUST_FIELD);
  private readonly debris = new ParticleField(DEBRIS_FIELD);
  /** Один общий поток частиц погоды на весь кадр, а не сотни отдельных Mesh. */
  private readonly weatherPositions = new Float32Array(560 * 3);
  private readonly weatherSpeeds = new Float32Array(560);
  private readonly weatherPoints: THREE.Points;
  private weatherAttribute!: THREE.BufferAttribute;
  private weatherKind: WeatherKind = 'clear';
  private weatherTime = 0;
  private environmentElapsed = 0;
  private environmentTransitionElapsed = 0;
  private environmentChanging = false;
  private environmentChangeDone = false;
  private environmentFromIndex = 0;
  private environmentToIndex = 0;
  /** Личная настройка: весь бой гонять погоду по случайному циклу или держать стартовый профиль карты. */
  private dynamicWeatherOn = true;
  private readonly environmentScratch = new THREE.Color();
  private nightLightsOn = false;
  /** Часы сцены в секундах: по ним шейдеры считают возраст следов и пылинок. */
  private clock = 0;
  /** Uniform шейдера покачивания травы текущей карты; null, пока карта не построена. */
  private grassWind: { value: number } | null = null;
  /** Мировая позиция своего танка для смятия травы под ним; null без карты. */
  private grassPlayerPos: THREE.Vector2 | null = null;

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
  private readonly contactMarkers = new Map<number, ContactMarkerHandle>();
  private readonly shells = new Map<number, ShellHandle>();
  private readonly shellPool: THREE.Group[] = [];
  private readonly effects: Effect[] = [];
  private readonly effectPool: Effect[] = [];
  private effectsWarmed = false;
  /** Не создаём PointLight для чужих танков: один локальный источник заметно
   * дешевле и не меняет освещение всей сцены от каждого выстрела. */
  private readonly localMuzzleLight = new THREE.PointLight(
    0xfff3d0,
    0,
    LOCAL_MUZZLE_LIGHT.distance,
    LOCAL_MUZZLE_LIGHT.decay,
  );
  private localMuzzleLightLife = 0;

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
    lootPlate: new RoundedBoxGeometry(1.55, 0.62, 0.08, 0.04, 1),
    lootCore: new THREE.CylinderGeometry(0.36, 0.5, 1.5, 10),
    lootWing: new RoundedBoxGeometry(0.34, 0.34, 1.8, 0.06, 1),
    lootBase: new THREE.CylinderGeometry(1.72, 1.96, 0.3, 6),
    lootRing: new THREE.TorusGeometry(1.28, 0.075, 6, 18),
    lootCrystal: new THREE.OctahedronGeometry(0.62, 0),
    lootCross: new RoundedBoxGeometry(0.32, 0.32, 1.55, 0.05, 1),
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

  private readonly moduleShellMaterial = new THREE.MeshStandardMaterial({
    color: 0xdce8e8,
    roughness: 0.38,
    metalness: 0.78,
    flatShading: true,
  });
  private readonly moduleGlassMaterial = new THREE.MeshStandardMaterial({
    color: 0xc8fbff,
    emissive: 0x6ee8ff,
    emissiveIntensity: 0.55,
    transparent: true,
    opacity: 0.55,
    roughness: 0.12,
    metalness: 0.2,
  });
  private readonly moduleTierMaterials = ROYALE_MODULE_TIER_COLORS.map(
    (color) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.7, metalness: 0.5, roughness: 0.32 }),
  );
  private readonly moduleHealMaterial = new THREE.MeshStandardMaterial({
    color: 0x52e6a3,
    emissive: 0x2bd889,
    emissiveIntensity: 1.1,
    metalness: 0.35,
    roughness: 0.28,
  });
  private readonly bonuses = new Map<number, { object: THREE.Object3D; seen: boolean }>();
  /** BR-контейнеры тяжёлые и стоят на земле; старые бонусы по-прежнему парят. */
  private royaleLootVisual = false;

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
  private readonly headlightMaterial = new THREE.MeshStandardMaterial({
    color: 0xffe0a4,
    emissive: 0xffa83d,
    emissiveIntensity: 4.2,
    roughness: 0.28,
    metalness: 0.05,
  });
  private readonly rearLightMaterial = new THREE.MeshStandardMaterial({
    color: 0x8f2424,
    emissive: 0xff1f1f,
    emissiveIntensity: 2.6,
    roughness: 0.3,
    metalness: 0.05,
  });
  private readonly rearLightFrameMaterial = new THREE.MeshStandardMaterial({
    color: 0x24272b,
    roughness: 0.72,
    metalness: 0.38,
    flatShading: true,
  });
  private readonly headlightGeometry = new THREE.SphereGeometry(0.16, 8, 6);
  private readonly rearLightGeometry = new RoundedBoxGeometry(0.42, 0.2, 0.08, 0.035, 1);
  private readonly rearLightFrameGeometry = new RoundedBoxGeometry(0.58, 0.34, 0.08, 0.04, 1);

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
  private hemisphereLight!: THREE.HemisphereLight;
  private fillLight!: THREE.DirectionalLight;
  private sunLight!: THREE.DirectionalLight;

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
   * см. setActiveBush: только куст под FPV-камерой получает отдельный
   * полупрозрачный материал, остальные остаются непрозрачными.
   */
  private bushMeshes: THREE.InstancedMesh[] = [];
  private bushHandles: BushHandle[] = [];
  private activeBush = -1;

  /** Всплывающие цифры урона — DOM-элементы поверх сцены, как и ники. */
  private readonly damageNumbers: DamageNumberHandle[] = [];

  /** Рабочие векторы для дульной вспышки: считается она несколько раз в секунду. */
  private readonly muzzlePoint = new THREE.Vector3();
  /** Общая болванка матрицы: ей расставляем звенья без аллокаций каждый кадр. */
  private readonly trackLinkDummy = new THREE.Object3D();
  /** Переиспользуемая матрица для движения отдельных комков кустов. */
  private readonly bushMatrix = new THREE.Matrix4();

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

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.5, 1200);
    this.camera.position.set(0, 20, -30);

    // Небо не должно проваливаться в почти чёрный фон: при дальнем зуме оно
    // занимает заметную часть кадра и задаёт общий уровень света сцены.
    this.scene.background = new THREE.Color(0x496783);
    // На больших картах туман начинается дальше, иначе «Рубеж» выглядел бы
    // пустым уже через сотню метров, а дальние районы растворялись бы раньше
    // самой игровой дистанции.
    this.scene.fog = new THREE.Fog(0x496783, 260, 1200);

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
    this.localMuzzleLight.castShadow = false;
    // Источник всегда входит в вариант шейдера освещения, но до выстрела
    // ничего не добавляет к картинке. Если переключать visible в бою, three.js
    // пересобирает материалы сцены ровно на первом выстреле.
    this.localMuzzleLight.visible = true;
    this.scene.add(this.localMuzzleLight);
    const weatherGeometry = new THREE.BufferGeometry();
    this.weatherAttribute = new THREE.BufferAttribute(this.weatherPositions, 3);
    weatherGeometry.setAttribute('position', this.weatherAttribute);
    const weatherMaterial = new THREE.PointsMaterial({
      color: 0xb9d7e8,
      size: 0.16,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.weatherPoints = new THREE.Points(weatherGeometry, weatherMaterial);
    this.weatherPoints.visible = false;
    this.scene.add(this.weatherPoints);
    this.royaleZoneRing.rotation.x = -Math.PI / 2;
    this.royaleZoneRing.position.y = 0.08;
    this.royaleZoneRing.visible = false;
    this.scene.add(this.royaleZoneRing);
    this.royaleZoneWall.position.y = 9;
    this.royaleZoneWall.visible = false;
    this.scene.add(this.royaleZoneWall);
    const planeBody = new THREE.Mesh(
      new THREE.BoxGeometry(13, 2.2, 3.2),
      new THREE.MeshStandardMaterial({ color: 0xd9dde0, roughness: 0.72, metalness: 0.22, flatShading: true }),
    );
    const planeWings = new THREE.Mesh(
      new THREE.BoxGeometry(4.2, 0.32, 19),
      new THREE.MeshStandardMaterial({ color: 0xb8c0c5, roughness: 0.78, metalness: 0.2, flatShading: true }),
    );
    planeWings.position.x = -1.2;
    const planeTail = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 1.8, 3.4),
      new THREE.MeshStandardMaterial({ color: 0xc9cfd2, roughness: 0.78, metalness: 0.18, flatShading: true }),
    );
    planeTail.position.x = -5.1;
    planeTail.position.y = 0.8;
    this.royalePlane.add(planeBody, planeWings, planeTail);
    this.royalePlane.visible = false;
    this.scene.add(this.royalePlane);
    this.scene.add(this.tracks.mesh);
    this.scene.add(this.dust.points);
    this.scene.add(this.debris.points);
    this.setupLights();
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  private setupLights(): void {
    // Небо сверху, отражённый от земли свет снизу: именно он вытягивает тени из черноты.
    this.hemisphereLight = new THREE.HemisphereLight(0x9fb8d8, 0x4a4f3e, AMBIENT_INTENSITY);
    this.scene.add(this.hemisphereLight);

    // Слабый контровой свет с противоположной стороны — без него теневой борт танка
    // сливается в один тёмный силуэт.
    this.fillLight = new THREE.DirectionalLight(0xbfd4ea, FILL_INTENSITY);
    this.fillLight.position.set(-70, 45, -55);
    this.scene.add(this.fillLight);

    this.sunLight = new THREE.DirectionalLight(0xffe6bd, SUN_INTENSITY);
    this.sunLight.position.set(60, 95, 40);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.left = -240;
    this.sunLight.shadow.camera.right = 240;
    this.sunLight.shadow.camera.top = 240;
    this.sunLight.shadow.camera.bottom = -240;
    this.sunLight.shadow.camera.near = 10;
    this.sunLight.shadow.camera.far = 600;
    this.sunLight.shadow.bias = -0.0006;
    this.scene.add(this.sunLight);
  }

  /**
   * Строит землю, стены по периметру и препятствия, присланные сервером.
   * Вызывается заново при смене карты, поэтому вся геометрия мира живёт в одной
   * группе: старую снимаем целиком и освобождаем её буферы, иначе смена карты
   * оставляла бы прошлые блоки и в сцене, и в видеопамяти.
   */
  buildWorld(half: number, obstacles: Box[], mapId = 0): void {
    this.clearWorld();
    this.applyEnvironment(mapId);
    // Следы, пыль и обломки от прошлой карты к новой отношения не имеют.
    this.tracks.clear();
    this.dust.clear();
    this.debris.clear();

    const groundSize = half * 6;
    // Одна текстура покрывает всё поле. Повтор маленькой клетки давал заметные
    // квадратные швы на земле, особенно при взгляде почти параллельно плоскости.
    this.groundMap.repeat.set(1, 1);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(groundSize, groundSize),
      new THREE.MeshStandardMaterial({
        color: groundColor(mapId),
        roughness: 1,
        map: this.groundMap,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.world.add(ground);
    this.buildGroundPatches(half, mapId);
    this.buildGrass(half, obstacles, mapId);

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
    const roadMaterial = new THREE.MeshStandardMaterial({
      color: COLOR_ROAD,
      roughness: 0.96,
      flatShading: true,
    });
    const sidewalkMaterial = new THREE.MeshStandardMaterial({
      color: COLOR_SIDEWALK,
      roughness: 0.9,
      flatShading: true,
    });
    const poleMaterial = new THREE.MeshStandardMaterial({
      color: 0x34383a,
      roughness: 0.72,
      metalness: 0.35,
      flatShading: true,
    });
    const carMaterial = new THREE.MeshStandardMaterial({
      color: COLOR_CAR,
      roughness: 0.72,
      metalness: 0.12,
      flatShading: true,
    });
    const carGlassMaterial = new THREE.MeshStandardMaterial({
      color: 0x243841,
      roughness: 0.24,
      metalness: 0.28,
      flatShading: true,
    });
    const carWheelMaterial = new THREE.MeshStandardMaterial({
      color: 0x25282a,
      roughness: 0.96,
      flatShading: true,
    });
    const treeTrunkMaterial = new THREE.MeshStandardMaterial({
      color: COLOR_TREE_TRUNK,
      roughness: 1,
      flatShading: true,
    });
    const treeLeafMaterial = new THREE.MeshStandardMaterial({
      color: TREE_LEAF_COLORS[0],
      roughness: 1,
      flatShading: true,
    });
    const treeLeafAltMaterial = new THREE.MeshStandardMaterial({
      color: TREE_LEAF_COLORS[1],
      roughness: 1,
      flatShading: true,
    });
    const rockMaterial = new THREE.MeshStandardMaterial({
      color: COLOR_BOX,
      roughness: 1,
      flatShading: true,
    });
    // Куст — кластер фасеточных комков (см. buildBush), не крашеная коробка:
    // гранёная форма лучше совпадает с низкополигональными камнями и фасками
    // карты, а приглушённая шероховатая зелень не спорит с окружением.
    const leafGeometry = new THREE.DodecahedronGeometry(LEAF_CUBE * 0.58, 0);
    const leafMaterial = new THREE.MeshStandardMaterial({
      roughness: 0.98,
      metalness: 0,
      flatShading: true,
    });
    this.bushMeshes = [];
    this.activeBush = -1;
    const decor = createDecorBatch();
    for (const box of obstacles) {
      const look = boxLook(box, mapId);
      if (look === 'bush') {
        this.buildBush(box, leafGeometry, leafMaterial);
        continue;
      }
      if (look === 'road' || look === 'sidewalk') {
        const geometry = obstacleGeometry(box, look);
        geometry.translate(box.x, (box.y ?? 0) + box.h / 2, box.z);
        if (look === 'road') decor.roadBody.push(geometry);
        else decor.sidewalkBody.push(geometry);
        continue;
      }
      if (look === 'pole') {
        const pole = new THREE.CylinderGeometry(
          Math.max(0.07, box.w * 0.45),
          Math.max(0.1, box.w * 0.7),
          box.h,
          6,
        );
        pole.translate(box.x, (box.y ?? 0) + box.h / 2, box.z);
        decor.poleBody.push(pole);
        continue;
      }
      if (look === 'car') {
        const geometry = obstacleGeometry(box, look);
        geometry.translate(box.x, (box.y ?? 0) + box.h * 0.5, box.z);
        decor.carBody.push(geometry);
        const alongX = box.w >= box.d;
        decor.carGlass.push(worldBox(
          alongX ? box.w * 0.48 : box.w * 0.68,
          box.h * 0.34,
          alongX ? box.d * 0.68 : box.d * 0.48,
          box.x,
          (box.y ?? 0) + box.h * 0.86,
          box.z,
        ));
        for (const side of [-1, 1]) {
          const wheel = new THREE.CylinderGeometry(0.34, 0.34, 0.16, 8);
          wheel.rotateZ(Math.PI / 2);
          wheel.translate(
            box.x + (alongX ? 0 : side * (box.w * 0.43)),
            (box.y ?? 0) + 0.34,
            box.z + (alongX ? side * (box.d * 0.43) : 0),
          );
          decor.carWheel.push(wheel);
        }
        continue;
      }
      if (look === 'barrel') {
        this.buildBarrel(box, crateMaterial, trimMaterial);
        continue;
      }
      if (look === 'pipe') {
        this.buildPipe(box, trimMaterial);
        continue;
      }
      if (look === 'wreck') {
        this.buildWreck(box, carMaterial, carGlassMaterial, carWheelMaterial, trimMaterial);
        continue;
      }
      if (look === 'tree') {
        this.buildTree(box, decor);
        continue;
      }
      if (look === 'roof' || look === 'gate') {
        const geometry = obstacleGeometry(box, look);
        scaleBoxUv(geometry, box.w, box.h, box.d, BLOCK_TILE);
        geometry.translate(box.x, (box.y ?? 0) + box.h / 2, box.z);
        if (look === 'roof') decor.roofBody.push(geometry);
        else decor.gateBody.push(geometry);
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

      const geometry = obstacleGeometry(box, look);
      // Развёртка правится на геометрии, а не отдельным материалом на блок:
      // блоков на карте под сотню, и сотня материалов — это сотня шейдеров.
      scaleBoxUv(geometry, box.w, box.h, box.d, BLOCK_TILE);
      geometry.translate(box.x, (box.y ?? 0) + box.h / 2, box.z);
      if (look === 'house' || look === 'guardhouse') decor.houseBody.push(geometry);
      else if (look === 'crate' || look === 'container') decor.crateBody.push(geometry);
      else decor.wallBoxBody.push(geometry);
      this.decorateObstacle(box, look, decor);
    }
    this.flushDecor(
      decor,
      roofMaterial,
      trimMaterial,
      windowMaterial,
      doorMaterial,
      rockMaterial,
      houseMaterial,
      crateMaterial,
      wallBoxMaterial,
      roadMaterial,
      sidewalkMaterial,
      poleMaterial,
      carMaterial,
      carGlassMaterial,
      carWheelMaterial,
      treeTrunkMaterial,
      treeLeafMaterial,
      treeLeafAltMaterial,
    );
    this.warmupEffects();
  }

  /**
   * Применяет стартовый профиль карты. Если динамическая погода включена,
   * дальше заводит случайный цикл смен на весь бой (см. updateEnvironment) —
   * он идёт, пока не сменится карта: она снова вызывает этот метод.
   */
  private applyEnvironment(mapId: number): void {
    const index = ((mapId % ENVIRONMENT_PROFILES.length) + ENVIRONMENT_PROFILES.length) % ENVIRONMENT_PROFILES.length;
    const profile = ENVIRONMENT_PROFILES[index];
    this.environmentFromIndex = index;
    this.environmentToIndex = index;
    this.environmentElapsed = 0;
    this.environmentTransitionElapsed = 0;
    this.environmentChanging = false;
    this.environmentChangeDone = !this.dynamicWeatherOn;
    if (this.dynamicWeatherOn) this.pickNextEnvironmentTarget();
    this.weatherKind = profile.weather;
    this.applyEnvironmentBlend(profile, profile, 0);
    this.resetWeatherParticles();
  }

  /**
   * Динамическая погода — личная настройка, как bloom или вид сверху: на бой
   * не влияет, в сеть не уходит, и у каждого в комнате может стоять по-своему.
   * Включили — с текущего профиля стартует случайный цикл смен на весь матч.
   * Выключили — цикл останавливается сразу на профиле, к которому шёл переход.
   */
  setDynamicWeather(on: boolean): void {
    this.dynamicWeatherOn = on;
    if (on) {
      if (this.environmentChangeDone) {
        this.environmentChangeDone = false;
        this.environmentElapsed = 0;
        this.environmentChanging = false;
        this.pickNextEnvironmentTarget();
      }
      return;
    }
    if (this.environmentChanging) {
      const to = ENVIRONMENT_PROFILES[this.environmentToIndex];
      this.weatherKind = to.weather;
      this.applyEnvironmentBlend(to, to, 1);
      this.environmentFromIndex = this.environmentToIndex;
    }
    this.environmentChanging = false;
    this.environmentChangeDone = true;
  }

  /** Следующий профиль цикла всегда отличается от текущего, иначе «случайный» иногда простаивал бы на месте. */
  private pickNextEnvironmentTarget(): void {
    if (ENVIRONMENT_PROFILES.length <= 1) return;
    let next = this.environmentFromIndex;
    while (next === this.environmentFromIndex) {
      next = Math.floor(Math.random() * ENVIRONMENT_PROFILES.length);
    }
    this.environmentToIndex = next;
  }

  /** Смешивает два профиля без создания объектов на каждом кадре перехода. */
  private applyEnvironmentBlend(from: EnvironmentProfile, to: EnvironmentProfile, progress: number): void {
    this.blendEnvironmentColor(this.scene.background as THREE.Color, from.sky, to.sky, progress);
    const fog = this.scene.fog as THREE.Fog;
    this.blendEnvironmentColor(fog.color, from.fog, to.fog, progress);
    fog.near = THREE.MathUtils.lerp(from.fogNear, to.fogNear, progress);
    fog.far = THREE.MathUtils.lerp(from.fogFar, to.fogFar, progress);
    this.blendEnvironmentColor(this.hemisphereLight.color, from.hemiSky, to.hemiSky, progress);
    this.blendEnvironmentColor(this.hemisphereLight.groundColor, from.hemiGround, to.hemiGround, progress);
    this.hemisphereLight.intensity = AMBIENT_INTENSITY * THREE.MathUtils.lerp(from.hemiIntensity, to.hemiIntensity, progress);
    this.blendEnvironmentColor(this.fillLight.color, from.fill, to.fill, progress);
    this.fillLight.intensity = FILL_INTENSITY * THREE.MathUtils.lerp(from.fillIntensity, to.fillIntensity, progress);
    this.blendEnvironmentColor(this.sunLight.color, from.sun, to.sun, progress);
    this.sunLight.intensity = SUN_INTENSITY * THREE.MathUtils.lerp(from.sunIntensity, to.sunIntensity, progress);

    // Фары и характер частиц переключаем в середине перехода, чтобы не было
    // долгого смешения двух разных направлений света/осадков.
    const night = progress >= 0.5 ? to.night : from.night;
    if (night !== this.nightLightsOn) {
      this.nightLightsOn = night;
      this.setNightLights(night);
    }

    const material = this.weatherPoints.material as THREE.PointsMaterial;
    this.blendEnvironmentColor(material.color, weatherColor(from.weather), weatherColor(to.weather), progress);
    material.size = THREE.MathUtils.lerp(weatherSize(from.weather), weatherSize(to.weather), progress);
    material.opacity = THREE.MathUtils.lerp(weatherOpacity(from.weather), weatherOpacity(to.weather), progress);
    this.weatherPoints.visible = weatherOpacity(from.weather) > 0 || weatherOpacity(to.weather) > 0;
  }

  private blendEnvironmentColor(out: THREE.Color, from: number, to: number, progress: number): void {
    out.set(from);
    this.environmentScratch.set(to);
    out.lerp(this.environmentScratch, progress);
  }

  /**
   * Пока включена динамическая погода, смены идут одна за другой весь бой:
   * разгон, переход к случайно выбранному профилю, снова разгон — и так до
   * смены карты (applyEnvironment). Выключенная — эта функция не делает ничего.
   */
  private updateEnvironment(dt: number): void {
    if (this.environmentChangeDone) return;

    if (!this.environmentChanging) {
      this.environmentElapsed += dt;
      if (this.environmentElapsed < ENVIRONMENT_CHANGE_DELAY_S) return;
      this.environmentChanging = true;
      this.environmentTransitionElapsed = 0;
    }

    this.environmentTransitionElapsed = Math.min(
      ENVIRONMENT_CHANGE_DURATION_S,
      this.environmentTransitionElapsed + dt,
    );
    const rawProgress = this.environmentTransitionElapsed / ENVIRONMENT_CHANGE_DURATION_S;
    const progress = rawProgress * rawProgress * (3 - 2 * rawProgress);
    const from = ENVIRONMENT_PROFILES[this.environmentFromIndex];
    const to = ENVIRONMENT_PROFILES[this.environmentToIndex];
    this.applyEnvironmentBlend(from, to, progress);

    if (rawProgress >= 0.5 && this.weatherKind !== to.weather) {
      this.weatherKind = to.weather;
      this.resetWeatherParticles();
    }

    if (rawProgress >= 1) {
      this.environmentChanging = false;
      this.weatherKind = to.weather;
      this.applyEnvironmentBlend(to, to, 1);
      this.environmentFromIndex = this.environmentToIndex;
      if (this.dynamicWeatherOn) {
        this.environmentElapsed = 0;
        this.pickNextEnvironmentTarget();
      } else {
        this.environmentChangeDone = true;
      }
    }
  }

  private resetWeatherParticles(): void {
    for (let i = 0; i < this.weatherSpeeds.length; i++) {
      const seed = Math.abs(Math.sin((i + 1) * 17.17 + this.weatherKind.length * 13.1) * 43758.5);
      const seed2 = Math.abs(Math.sin((i + 1) * 31.73 + this.weatherKind.length * 7.4) * 19341.1);
      const seed3 = Math.abs(Math.sin((i + 1) * 47.29 + this.weatherKind.length * 3.8) * 9821.7);
      const at = i * 3;
      this.weatherPositions[at] = (seed - 0.5) * 80;
      this.weatherPositions[at + 1] = 2 + seed2 * 28;
      this.weatherPositions[at + 2] = (seed3 - 0.5) * 80;
      this.weatherSpeeds[i] = this.weatherKind === 'snow' ? 2.2 + seed * 2.6 : 14 + seed * 12;
    }
    this.weatherTime = 0;
    this.weatherAttribute.needsUpdate = true;
  }

  /** Дешёвый CPU-апдейт общего Points-эмиттера: 560 частиц, без аллокаций. */
  private updateWeather(dt: number): void {
    if (!this.weatherPoints.visible || (this.weatherKind !== 'rain' && this.weatherKind !== 'snow')) return;
    this.weatherTime += dt;
    const anchorX = this.camera.position.x;
    const anchorZ = this.camera.position.z;
    for (let i = 0; i < this.weatherSpeeds.length; i++) {
      const at = i * 3;
      this.weatherPositions[at + 1] -= this.weatherSpeeds[i] * dt;
      if (this.weatherKind === 'snow') {
        this.weatherPositions[at] += Math.sin(this.weatherTime * 0.7 + i) * dt * 1.4;
      } else {
        this.weatherPositions[at] += dt * 1.7;
        this.weatherPositions[at + 2] += dt * 0.9;
      }
      if (this.weatherPositions[at + 1] < 0.5) {
        const seed = Math.abs(Math.sin((i + 1) * 27.17 + this.weatherTime * 0.01) * 43758.5);
        const seed2 = Math.abs(Math.sin((i + 1) * 41.73 + this.weatherTime * 0.01) * 19341.1);
        this.weatherPositions[at] = anchorX + (seed - 0.5) * 80;
        this.weatherPositions[at + 1] = 24 + seed2 * 10;
        this.weatherPositions[at + 2] = anchorZ + (seed2 - 0.5) * 80;
      }
      // При обычном движении не оставляем поток частиц далеко за камерой.
      if (Math.abs(this.weatherPositions[at] - anchorX) > 52) this.weatherPositions[at] = anchorX - Math.sign(this.weatherPositions[at] - anchorX) * 42;
      if (Math.abs(this.weatherPositions[at + 2] - anchorZ) > 52) this.weatherPositions[at + 2] = anchorZ - Math.sign(this.weatherPositions[at + 2] - anchorZ) * 42;
    }
    this.weatherAttribute.needsUpdate = true;
  }

  private setNightLights(enabled: boolean): void {
    for (const handle of this.tanks.values()) {
      // Смена погоды не должна включать фары у уже уничтоженного танка.
      if (handle.dying >= 0) {
        handle.headlights.visible = false;
        continue;
      }
      handle.headlights.visible = enabled;
    }
  }

  /**
   * Крупные пятна грунта лежат чуть выше базовой плоскости и ниже дорог.
   * Неровный семиугольник сохраняет low-poly стиль, а прозрачность не спорит
   * с тенями, следами и укрытиями. Это чисто визуальный слой.
   */
  private buildGroundPatches(half: number, mapId: number): void {
    const palette = GROUND_PATCH_PALETTES[mapId] ?? GROUND_PATCH_PALETTES[0];
    const count = half >= 400 ? 18 : half >= 120 ? 9 : 6;
    const margin = Math.min(half - 12, half * 0.92);
    for (let i = 0; i < count; i++) {
      // Раньше здесь забывали взять дробную часть: размеры и координаты
      // улетали в миллионы метров, а огромные полупрозрачные полигоны начинали
      // мерцать о базовую землю при косом взгляде камеры.
      const seed = patchNoise((i + 1) * 91.731 + (mapId + 3) * 17.117);
      const seed2 = patchNoise((i + 1) * 37.419 + (mapId + 11) * 29.713);
      const x = (seed - 0.5) * margin * 1.7;
      const z = (seed2 - 0.5) * margin * 1.7;
      const radiusX = (half >= 400 ? 25 : 10) + seed * (half >= 400 ? 48 : 18);
      const radiusZ = radiusX * (0.58 + seed2 * 0.45);
      const shape = new THREE.CircleGeometry(1, 7 + (i % 3));
      shape.rotateX(-Math.PI / 2);
      const material = new THREE.MeshStandardMaterial({
        color: palette[i % palette.length],
        roughness: 1,
        transparent: true,
        opacity: half >= 400 ? 0.16 : 0.13,
        depthWrite: false,
        // Дополнительный сдвиг глубины стабилизирует прозрачный слой на
        // горизонте: одной высоты недостаточно на слабых depth-буферах.
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      const patch = new THREE.Mesh(shape, material);
      patch.position.set(x, 0.04, z);
      patch.scale.set(radiusX, 1, radiusZ);
      patch.rotation.y = seed2 * Math.PI * 2;
      patch.receiveShadow = true;
      this.world.add(patch);
    }
  }

  /**
   * Статичная трава: вся карта — один InstancedMesh и один draw call. Точки
   * отбрасываются из дорог, зданий и остальных Box, поэтому травинки не
   * торчат сквозь укрытия и не создают новую физику.
   */
  private buildGrass(half: number, obstacles: Box[], mapId: number): void {
    // Один InstancedMesh — один draw call вне зависимости от числа пучков,
    // поэтому плотность можно поднимать почти бесплатно по кадру.
    const count = half >= 400 ? 9600 : half >= 120 ? 4400 : 2900;
    const { material, wind, playerPos } = createGrassMaterial();
    const mesh = new THREE.InstancedMesh(grassTuftGeometry(), material, count);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.grassWind = wind;
    this.grassPlayerPos = playerPos;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const margin = Math.max(6, half - 8);
    const maxAttempts = count * 14;
    let placed = 0;
    for (let attempt = 0; attempt < maxAttempts && placed < count; attempt++) {
      const seed = Math.abs(Math.sin((attempt + 1) * 17.731 + mapId * 41.17));
      const seed2 = Math.abs(Math.sin((attempt + 1) * 31.419 + mapId * 13.71));
      const seed3 = Math.abs(Math.sin((attempt + 1) * 47.293 + mapId * 7.31));
      const seed4 = Math.abs(Math.sin((attempt + 1) * 59.871 + mapId * 21.42));
      const x = (seed * 2 - 1) * margin;
      const z = (seed2 * 2 - 1) * margin;
      if (!this.isGrassSpot(x, z, obstacles)) continue;

      // Крупнее нижняя граница размера — не даём пучку сжаться до незаметной
      // соринки на дистанции, из-за чего трава раньше выглядела «пустой».
      const height = 0.95 + seed3 * 0.85;
      const width = 0.95 + seed2 * 0.5;
      dummy.position.set(x, 0.025, z);
      dummy.rotation.y = seed * Math.PI * 2;
      dummy.scale.set(width, height, width);
      dummy.updateMatrix();
      mesh.setMatrixAt(placed, dummy.matrix);
      // Оттенок берём по месту (пятна одного тона), яркость чуть дрожит на
      // инстанс — без этого патч выглядит как один и тот же кустик, скопированный.
      color.set(grassPatchColor(x, z, mapId));
      const brightness = 0.85 + seed4 * 0.3;
      color.multiplyScalar(brightness);
      mesh.setColorAt(placed, color);
      placed++;
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.world.add(mesh);
  }

  private isGrassSpot(x: number, z: number, obstacles: Box[]): boolean {
    for (const box of obstacles) {
      const pad = box.style === 'road' || box.style === 'sidewalk' ? 0.35 : GRASS_PAD;
      if (Math.abs(x - box.x) <= box.w / 2 + pad && Math.abs(z - box.z) <= box.d / 2 + pad) return false;
    }
    return true;
  }

  /** Обновляет границу круга BR; null убирает её в остальных режимах. */
  setRoyaleZone(zone: { x: number; z: number; r: number; phase: string } | null): void {
    if (!zone || zone.r <= 0) {
      this.royaleZoneRing.visible = false;
      this.royaleZoneWall.visible = false;
      return;
    }
    this.royaleZoneRing.visible = true;
    this.royaleZoneWall.visible = true;
    this.royaleZoneRing.position.x = zone.x;
    this.royaleZoneRing.position.z = zone.z;
    this.royaleZoneRing.scale.set(zone.r, zone.r, zone.r);
    this.royaleZoneWall.position.x = zone.x;
    this.royaleZoneWall.position.z = zone.z;
    this.royaleZoneWall.scale.set(zone.r, 18, zone.r);
    const material = this.royaleZoneRing.material as THREE.MeshBasicMaterial;
    const color = zone.phase === 'shrinking' ? 0xff8d58 : zone.phase === 'final' ? 0xff4f63 : 0x75d9ff;
    material.color.setHex(color);
    material.opacity = zone.phase === 'final' ? 0.9 : 0.65;
    const wallMaterial = this.royaleZoneWall.material as THREE.MeshBasicMaterial;
    wallMaterial.color.setHex(color);
    wallMaterial.opacity = zone.phase === 'final' ? 0.2 : zone.phase === 'shrinking' ? 0.15 : 0.1;
  }

  /** Синхронизирует командные маркеры последней известной позиции врагов. */
  syncContactMarkers(contacts: Array<{ i: number; x: number; z: number; u: number }>): void {
    const seen = new Set<number>();
    for (const contact of contacts) {
      seen.add(contact.i);
      let marker = this.contactMarkers.get(contact.i);
      if (!marker) {
        const el = document.createElement('div');
        el.className = 'contact-marker';
        el.textContent = '?';
        this.labelContainer.appendChild(el);
        marker = { el, x: contact.x, z: contact.z, until: contact.u };
        this.contactMarkers.set(contact.i, marker);
      } else {
        marker.x = contact.x;
        marker.z = contact.z;
        marker.until = contact.u;
      }
    }
    for (const [id, marker] of this.contactMarkers) {
      if (seen.has(id)) continue;
      marker.el.remove();
      this.contactMarkers.delete(id);
    }
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

  /** Низкополигональная промышленная бочка: заметна, но не похожа на лут. */
  private buildBarrel(
    box: Box,
    bodyMaterial: THREE.MeshStandardMaterial,
    bandMaterial: THREE.MeshStandardMaterial,
  ): void {
    const radius = Math.min(box.w, box.d) * 0.38;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.04, box.h, 10), bodyMaterial);
    body.position.set(box.x, box.h / 2, box.z);
    body.castShadow = true;
    this.world.add(body);
    for (const y of [box.h * 0.27, box.h * 0.72]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.01, 0.08, 6, 10), bandMaterial);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(box.x, y, box.z);
      ring.castShadow = true;
      this.world.add(ring);
    }
  }

  /** Связка труб с видимыми торцами: промышленный ориентир без новой коллизии. */
  private buildPipe(box: Box, material: THREE.MeshStandardMaterial): void {
    const alongX = box.w >= box.d;
    const length = Math.max(box.w, box.d);
    const radius = Math.min(box.w, box.d) * 0.28;
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 10), material);
    if (alongX) pipe.rotation.z = Math.PI / 2;
    else pipe.rotation.x = Math.PI / 2;
    pipe.position.set(box.x, box.h * 0.58, box.z);
    pipe.castShadow = true;
    this.world.add(pipe);
    for (const offset of [-length * 0.28, length * 0.28]) {
      const support = new THREE.Mesh(
        new THREE.BoxGeometry(alongX ? 0.42 : box.w * 0.72, box.h * 0.52, alongX ? box.d * 0.72 : 0.42),
        material,
      );
      support.position.set(box.x + (alongX ? offset : 0), box.h * 0.26, box.z + (alongX ? 0 : offset));
      support.castShadow = true;
      this.world.add(support);
    }
  }

  /** Разбитая лёгкая техника: узнаваемый силуэт без огня и лишнего свечения. */
  private buildWreck(
    box: Box,
    bodyMaterial: THREE.MeshStandardMaterial,
    glassMaterial: THREE.MeshStandardMaterial,
    wheelMaterial: THREE.MeshStandardMaterial,
    trimMaterial: THREE.MeshStandardMaterial,
  ): void {
    const alongX = box.w >= box.d;
    const body = new THREE.Mesh(
      new RoundedBoxGeometry(box.w, box.h * 0.62, box.d, 0.18, 1),
      bodyMaterial,
    );
    body.position.set(box.x, box.h * 0.34, box.z);
    body.rotation.y = (boxVariant(box) - 1.5) * 0.08;
    body.castShadow = true;
    this.world.add(body);

    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(
        alongX ? box.w * 0.46 : box.w * 0.7,
        box.h * 0.42,
        alongX ? box.d * 0.72 : box.d * 0.46,
      ),
      glassMaterial,
    );
    cabin.position.set(box.x + (alongX ? box.w * 0.12 : 0), box.h * 0.76, box.z);
    cabin.rotation.y = body.rotation.y;
    cabin.castShadow = true;
    this.world.add(cabin);

    for (let i = 0; i < 2; i++) {
      const t = i - 0.5;
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(box.h * 0.25, box.h * 0.25, 0.18, 8), wheelMaterial);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(
        box.x + (alongX ? t * box.w * 0.62 : box.w * 0.46),
        box.h * 0.22,
        box.z + (alongX ? box.d * 0.46 : t * box.d * 0.62),
      );
      wheel.castShadow = true;
      this.world.add(wheel);
    }
    const damagedBar = new THREE.Mesh(
      new THREE.BoxGeometry(alongX ? box.w * 0.7 : 0.16, 0.12, alongX ? 0.16 : box.d * 0.7),
      trimMaterial,
    );
    damagedBar.position.set(box.x, box.h * 0.98, box.z);
    damagedBar.rotation.y = body.rotation.y;
    this.world.add(damagedBar);
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
    houseMaterial: THREE.MeshStandardMaterial,
    crateMaterial: THREE.MeshStandardMaterial,
    wallBoxMaterial: THREE.MeshStandardMaterial,
    roadMaterial: THREE.MeshStandardMaterial,
    sidewalkMaterial: THREE.MeshStandardMaterial,
    poleMaterial: THREE.MeshStandardMaterial,
    carMaterial: THREE.MeshStandardMaterial,
    carGlassMaterial: THREE.MeshStandardMaterial,
    carWheelMaterial: THREE.MeshStandardMaterial,
    treeTrunkMaterial: THREE.MeshStandardMaterial,
    treeLeafMaterial: THREE.MeshStandardMaterial,
    treeLeafAltMaterial: THREE.MeshStandardMaterial,
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
    add(batch.roadBody, roadMaterial);
    add(batch.sidewalkBody, sidewalkMaterial);
    add(batch.poleBody, poleMaterial);
    add(batch.carBody, carMaterial);
    add(batch.carGlass, carGlassMaterial);
    add(batch.carWheel, carWheelMaterial);
    add(batch.treeTrunk, treeTrunkMaterial);
    add(batch.treeLeaf, treeLeafMaterial);
    add(batch.treeLeafAlt, treeLeafAltMaterial);
    add(batch.roofBody, roofMaterial);
    add(batch.gateBody, doorMaterial);
    add(batch.houseBody, houseMaterial);
    add(batch.crateBody, crateMaterial);
    add(batch.wallBoxBody, wallBoxMaterial);
    add(batch.roof, roofMaterial);
    add(batch.trim, trimMaterial);
    add(batch.windows, windowMaterial);
    add(batch.doors, doorMaterial);
    add(batch.rocks, rockMaterial);
  }

  /** Разные деревья в одном low-poly стиле; collisionW/collisionD — коллизия ствола. */
  private buildTree(box: Box, batch: DecorBatch): void {
    const variant = boxVariant(box);
    const trunkHeight = Math.max(2.1, box.h * 0.52);
    const trunk = new THREE.CylinderGeometry(
      Math.max(0.22, Math.min(box.w, box.d) * 0.12),
      Math.max(0.32, Math.min(box.w, box.d) * 0.17),
      trunkHeight,
      6,
    );
    trunk.rotateY(variant * 0.4);
    trunk.translate(box.x, (box.y ?? 0) + trunkHeight / 2, box.z);
    batch.treeTrunk.push(trunk);

    const target = variant % 2 === 0 ? batch.treeLeaf : batch.treeLeafAlt;
    const crown = (scale: number, y: number, offsetX: number, offsetZ: number) => {
      const geometry = new THREE.DodecahedronGeometry(1, 0);
      geometry.scale(box.w * scale, box.h * scale * 0.9, box.d * scale);
      geometry.rotateY(variant * 0.65 + scale);
      geometry.translate(box.x + offsetX, (box.y ?? 0) + y, box.z + offsetZ);
      target.push(geometry);
    };
    crown(0.48, box.h * 0.67, -box.w * 0.08, 0);
    crown(0.38, box.h * 0.9, box.w * 0.11, -box.d * 0.04);
  }

  /**
   * Куст: кластер фасеточных комков вместо одной плоской коробки — читается как
   * листва, а не крашеный бетон. Высота фиксирована и заметно выше танка
   * (BUSH_HEIGHT) — box.h в этом не участвует, он у куста чисто про физику
   * (держит снаряд или нет, мешает ехать или нет — см. isBush в map.ts).
   * Один InstancedMesh на куст: кубиков в кластере может быть несколько
   * десятков, обычный Mesh на каждый обошёлся бы куда дороже по кадру.
   */
  private buildBush(box: Box, geometry: THREE.BufferGeometry, material: THREE.MeshStandardMaterial): void {
    const profile = BUSH_PROFILES[Math.floor(bushSeed(box) * BUSH_PROFILES.length)];
    const cols = Math.max(2, Math.round(box.w / LEAF_CUBE));
    const rows = Math.max(2, Math.round(box.d / LEAF_CUBE));
    const stepX = box.w / cols;
    const stepZ = box.d / rows;
    const stepY = profile.height / BUSH_LAYERS;

    const mesh = new THREE.InstancedMesh(geometry, material, cols * rows * BUSH_LAYERS);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const dummy = new THREE.Object3D();
    const baseMatrices: THREE.Matrix4[] = [];
    const baseX = new Float32Array(mesh.count);
    const baseZ = new Float32Array(mesh.count);
    const offsetX = new Float32Array(mesh.count);
    const offsetZ = new Float32Array(mesh.count);
    let i = 0;
    for (let layer = 0; layer < BUSH_LAYERS; layer++) {
      for (let cx = 0; cx < cols; cx++) {
        for (let cz = 0; cz < rows; cz++) {
          const nx = cols === 1 ? 0 : (cx / (cols - 1)) * 2 - 1;
          const nz = rows === 1 ? 0 : (cz / (rows - 1)) * 2 - 1;
          const edge = Math.min(1, Math.hypot(nx, nz) * 0.72);
          const layerT = layer / (BUSH_LAYERS - 1);
          // Верхний ярус не заполняем по сетке целиком: редкие пропуски и
          // детерминированный шум ломают силуэт живой изгороди.
          const sample = Math.abs(Math.sin((cx + 1) * 17.13 + (cz + 1) * 31.71 + (layer + 1) * 47.11 + box.x * 0.17 + box.z * 0.23));
          if (layer === BUSH_LAYERS - 1 && edge > 0.5 && sample < profile.topSparse) continue;
          const jitterX = Math.abs(Math.sin((cx + 1) * 23.17 + (cz + 1) * 11.39 + box.x * 0.11));
          const jitterZ = Math.abs(Math.sin((cx + 1) * 13.71 + (cz + 1) * 29.53 + box.z * 0.19));
          const x = box.x - box.w / 2 + stepX * (cx + 0.5) + (jitterX - 0.5) * stepX * 0.46;
          const z = box.z - box.d / 2 + stepZ * (cz + 0.5) + (jitterZ - 0.5) * stepZ * 0.46;
          const yJitter = Math.abs(Math.sin((cx + 1) * 7.91 + (cz + 1) * 19.37 + layer * 3.17 + box.x * 0.07));
          const y = stepY * (layer + 0.5) + (yJitter - 0.5) * stepY * 0.42;
          dummy.position.set(x, y, z);
          dummy.rotation.set(0, sample * Math.PI * 2, 0);
          // Верх и края компактнее, но профиль добавляет кусту собственную
          // «породу»: широкий, высокий или низкий раскидистый силуэт.
          const fullness = 0.86 + (1 - edge) * 0.28 - layerT * profile.topDrop;
          const size = fullness * (0.9 + sample * 0.18);
          dummy.scale.set(
            size * profile.width * (0.9 + jitterX * 0.18),
            size * (0.84 + jitterZ * 0.2),
            size * profile.depth * (0.9 + jitterX * 0.18),
          );
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
          baseMatrices.push(dummy.matrix.clone());
          baseX[i] = x;
          baseZ[i] = z;
          mesh.setColorAt(i, LEAF_PALETTE[Math.floor(sample * LEAF_PALETTE.length) % LEAF_PALETTE.length]);
          i++;
        }
      }
    }
    // Верхний ярус может пропускать крайние комки, поэтому не оставляем
    // неиспользованные экземпляры с нулевой матрицей в центре карты.
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.world.add(mesh);
    // Порядок совпадает с bushBoxes() — обе функции идут по одному и тому же
    // отфильтрованному списку obstacles, так что индекс тут и есть тот самый
    // индекс, который main.ts получает от bushIndexAt (см. setActiveBush).
    this.bushMeshes.push(mesh);
    this.bushHandles.push({
      mesh,
      opaqueMaterial: material,
      fpvMaterial: (() => {
        const fpvMaterial = material.clone();
        fpvMaterial.transparent = true;
        fpvMaterial.opacity = 0.28;
        fpvMaterial.depthWrite = false;
        return fpvMaterial;
      })(),
      centerX: box.x,
      centerZ: box.z,
      halfW: box.w / 2,
      halfD: box.d / 2,
      baseMatrices,
      baseX,
      baseZ,
      offsetX,
      offsetZ,
      displaced: false,
    });
  }

  /** Снимает прошлую карту вместе с её буферами. */
  private clearWorld(): void {
    const materials = new Set<THREE.Material>();
    for (const child of this.world.children) {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) for (const m of material) materials.add(m);
      else if (material) materials.add(material);
    }
    // У активного FPV-куста отдельный прозрачный материал; он может быть не
    // назначен mesh в момент смены карты, поэтому собираем его отдельно.
    for (const bush of this.bushHandles) {
      materials.add(bush.opaqueMaterial);
      materials.add(bush.fpvMaterial);
    }
    for (const material of materials) material.dispose();
    this.world.clear();
    this.bushMeshes = [];
    this.bushHandles = [];
    this.activeBush = -1;
    this.grassWind = null;
    this.grassPlayerPos = null;
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

    const canopy = new THREE.Mesh(this.royaleDropCanopyGeometry, this.royaleDropCanopyMaterial);
    // Купол должен читаться прямо над башней, а не висеть отдельным объектом
    // высоко над танком.
    canopy.position.y = 7;
    canopy.visible = false;
    root.add(canopy);

    const headlights = new THREE.Group();
    const headlightSpots: THREE.SpotLight[] = [];
    const rearLightSpots: THREE.SpotLight[] = [];
    for (const side of [-1, 1]) {
      const lamp = new THREE.Mesh(this.headlightGeometry, this.headlightMaterial);
      lamp.position.set(side * 0.82, 1.12, 2.12);
      headlights.add(lamp);
      // Два реальных источника только у локального танка: остальные машины
      // получают те же светящиеся корпуса фар, но не создают десятки lights.
      if (!isSelf) continue;
      const spot = new THREE.SpotLight(0xffd99a, 28, 55, Math.PI / 8, 0.72, 1.2);
      spot.position.set(side * 0.82, 1.14, 2.12);
      spot.castShadow = false;
      const target = new THREE.Object3D();
      target.position.set(side * 3.5, 0.2, 42);
      headlights.add(spot, target);
      spot.target = target;
      headlightSpots.push(spot);
    }
    for (const side of [-1, 1]) {
      // Кормовые огни не шарики: плафон и тёмная рамка повторяют плоскую
      // заднюю броню и выглядят как встроенные габариты.
      const frame = new THREE.Mesh(this.rearLightFrameGeometry, this.rearLightFrameMaterial);
      frame.position.set(side * 0.82, 1.12, -1.925);
      const lamp = new THREE.Mesh(this.rearLightGeometry, this.rearLightMaterial);
      lamp.position.set(side * 0.82, 1.12, -1.985);
      headlights.add(frame, lamp);
      // Красные задние фонари у чужих танков тоже видны, но настоящий
      // направленный свет создаём только у своего — как с передними фарами.
      if (!isSelf) continue;
      const spot = new THREE.SpotLight(0xff3030, 6, 24, Math.PI / 9, 0.8, 1.6);
      spot.position.set(side * 0.82, 1.14, -1.99);
      spot.castShadow = false;
      const target = new THREE.Object3D();
      target.position.set(side * 0.82, 0.2, -28);
      headlights.add(spot, target);
      spot.target = target;
      rearLightSpots.push(spot);
    }
    headlights.visible = this.nightLightsOn;
    // Фонари должны быть частью верхней брони, а не корня танка: body получает
    // крен и клевок подвески, upperHull наследует их, и все четыре огня идут
    // вместе с корпусом во время качения/наклона.
    upperHull.add(headlights);

    this.scene.add(root);

    // Подпись строится лениво — см. ensureLabel() и комментарий у TankHandle.label.
    const handle: TankHandle = {
      root,
      body,
      runningGear,
      turret,
      barrel,
      trackLinks,
      runningBase: running,
      wheels,
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
      basePaintColor: paintColor,
      camouflageStyle: 0,
      camouflageColor: undefined,
      dying: -1,
      smokeAt: 0,
      everSeen: false,
      label: null,
      hpFill: null,
      labelHalfWidth: 0,
      labelHeight: 0,
      labelVisible: false,
      name,
      isSelf,
      isBot,
      faction: 'neutral',
      plated: false,
      alive: true,
      cloaked: false,
      hp: MAX_HP,
      canopy,
      headlights,
      headlightSpots,
      rearLightSpots,
    };
    this.tanks.set(id, handle);
    return handle;
  }

  /** Командный цвет BR: меняем только броню, ходовая и металл остаются общими. */
  setTankFaction(id: number, faction: TankFaction): void {
    const handle = this.tanks.get(id);
    if (!handle) return;

    const paintColor = faction === 'neutral' ? handle.basePaintColor : FACTION_PAINT[faction];
    handle.paintColor = paintColor;
    handle.paint.color.setHex(handle.camouflageColor ?? paintColor);
    if (!handle.alive) handle.paint.color.multiplyScalar(WRECK_DARKEN);

    handle.faction = faction;
    // Подписи может ещё не быть (см. ensureLabel) — тогда класс применится сам,
    // как только она наконец понадобится.
    if (handle.label) {
      for (const name of ['faction-self', 'faction-ally', 'faction-enemy']) {
        handle.label.classList.remove(name);
      }
      if (faction !== 'neutral') handle.label.classList.add(`faction-${faction}`);
    }
  }

  /** Применяет окраску окружения от серверного анализа камуфляжа. */
  setTankCamouflage(id: number, style: 0 | 1 | 2, mapId = 0): void {
    const handle = this.tanks.get(id);
    if (!handle || handle.camouflageStyle === style && (style !== 2 || handle.camouflageColor === groundColor(mapId))) return;
    handle.camouflageStyle = style;
    handle.camouflageColor = style === 1 ? CAMO_BUSH_PAINT : style === 2 ? groundColor(mapId) : undefined;
    handle.paint.color.setHex(handle.camouflageColor ?? handle.paintColor);
    if (!handle.alive) handle.paint.color.multiplyScalar(WRECK_DARKEN);
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
      if (handle.hpFill) {
        const fraction = Math.max(0, Math.min(1, hp / max));
        handle.hpFill.style.width = `${(fraction * 100).toFixed(0)}%`;
        // Зелёный -> жёлтый -> красный по мере потери брони.
        handle.hpFill.style.background = `hsl(${Math.round(fraction * 105)} 70% 48%)`;
      }
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
      handle.paint.color.setHex(handle.camouflageColor ?? handle.paintColor).multiplyScalar(WRECK_DARKEN);
      handle.body.rotation.set(WRECK_PITCH, 0, WRECK_ROLL);
      this.setWreckPose(handle, wreckSink(WRECK_S));
      this.setWreckVisual(handle, 1);
      handle.roll = WRECK_ROLL;
      handle.pitch = WRECK_PITCH;
      this.setTankShadow(handle, false);
      // Зашедший после гибели танк получает уже остывший остов без фар.
      handle.headlights.visible = false;
      return;
    }

    handle.dying = 0;
    handle.smokeAt = 0;
    // Фары гаснут сразу и не могут остаться включёнными на мёртвом танке.
    handle.headlights.visible = false;
    handle.root.visible = !handle.cloaked;

    handle.paint.color.setHex(handle.camouflageColor ?? handle.paintColor).multiplyScalar(WRECK_DARKEN);
    handle.body.rotation.set(WRECK_PITCH, 0, WRECK_ROLL);
    this.setWreckPose(handle, 0);
    this.setWreckVisual(handle, 0);
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
    handle.paint.color.setHex(handle.camouflageColor ?? handle.paintColor);
    handle.body.position.y = SUSPENSION_PIVOT_Y;
    handle.body.rotation.set(0, 0, 0);
    handle.turret.rotation.set(0, 0, 0);
    handle.runningGear.position.set(0, 0, 0);
    handle.runningGear.rotation.set(0, 0, 0);
    handle.runningBase.visible = true;
    handle.wheels.visible = true;
    for (const links of handle.trackLinks) {
      links.visible = true;
      links.position.set(0, 0, 0);
      links.rotation.set(0, 0, 0);
    }
    handle.roll = 0;
    handle.pitch = 0;
    this.setTankShadow(handle, true);
    handle.root.visible = !handle.cloaked;
    handle.headlights.visible = this.nightLightsOn;
  }

  /** На смерти ходовая снова следует за корпусом, чтобы остов не распался на части. */
  private setWreckPose(handle: TankHandle, sink: number): void {
    handle.body.position.y = SUSPENSION_PIVOT_Y + sink;
    handle.runningGear.position.y = sink;
    handle.runningGear.rotation.copy(handle.body.rotation);
  }

  /** Разрушенная ходовая: звенья расходятся, а башня заваливается отдельно. */
  private setWreckVisual(handle: TankHandle, progress: number): void {
    const p = Math.max(0, Math.min(1, progress));
    handle.runningBase.visible = false;
    handle.wheels.visible = false;
    handle.turret.rotation.x = -0.13 * p;
    handle.turret.rotation.z = 0.24 * p;

    for (let index = 0; index < handle.trackLinks.length; index++) {
      const side = index === 0 ? -1 : 1;
      const links = handle.trackLinks[index];
      links.visible = true;
      links.position.x = side * (0.16 + 0.72 * p);
      links.position.y = -0.08 - 0.26 * p;
      links.position.z = side * 0.12 * p;
      links.rotation.z = side * 0.12 * p;
    }
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
      this.setWreckVisual(handle, Math.min(handle.dying / 0.55, 1));
      // Защита от переключения погоды во время анимации: мёртвый танк всегда
      // остаётся без фар.
      handle.headlights.visible = false;

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

  /** Сетевой засвет BR: скрытый враг не должен оставаться на старой позиции. */
  setTankVisibility(id: number, visible: boolean): void {
    const handle = this.tanks.get(id);
    if (!handle) return;
    handle.root.visible = visible && (handle.alive || handle.dying >= 0) && !handle.cloaked;
  }

  /**
   * Разрешена ли танку подпись — подписан только товарищ, решение принимает
   * main.ts: рендер не знает ни про команды, ни про режим комнаты.
   *
   * Гасить подпись руками не нужно — updateLabels каждый кадр решает это заново
   * и снимет её сам, ровно как делает «Маскировка». А вот построить саму
   * DOM-подпись, если её ещё не было, нужно именно тут: до первого on=true
   * она вообще не нужна — см. TankHandle.label.
   */
  setNameplate(id: number, on: boolean): void {
    const handle = this.tanks.get(id);
    if (!handle) return;
    handle.plated = on;
    if (on) this.ensureLabel(handle);
  }

  /** Строит DOM-подпись танка по накопленным на handle данным — не раньше, чем понадобится. */
  private ensureLabel(handle: TankHandle): void {
    if (handle.label) return;

    const label = document.createElement('div');
    label.className = handle.isSelf ? 'nameplate is-self' : handle.isBot ? 'nameplate is-bot' : 'nameplate';
    if (handle.faction !== 'neutral') label.classList.add(`faction-${handle.faction}`);

    const text = document.createElement('span');
    text.textContent = handle.name;
    label.appendChild(text);

    // Полоска здоровья фиксированной ширины: меняется только заливка, поэтому
    // размеры подписи остаются постоянными и их можно замерить один раз.
    const bar = document.createElement('i');
    bar.className = 'np-hp';
    const hpFill = document.createElement('b');
    bar.appendChild(hpFill);
    label.appendChild(bar);

    this.labelContainer.appendChild(label);

    handle.label = label;
    handle.hpFill = hpFill;
    // Читаем размеры один раз: offsetWidth заставляет браузер пересчитать
    // раскладку — тем дороже, чем больше подписей уже висит на сцене.
    handle.labelHalfWidth = Math.round(label.offsetWidth / 2);
    handle.labelHeight = label.offsetHeight;
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
    handle.label?.remove();
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
    handle.root.position.set(x, handle.alive ? this.royaleDropHeight : 0, z);
    handle.root.rotation.y = angle;
    // Башня хранится в мировых углах, а её узел — потомок корпуса.
    handle.turret.rotation.y = turret - angle;
  }

  /** Анимация входа в матч BR: самолёт проходит над картой, танки спускаются. */
  setRoyaleDrop(progress: number, half: number): void {
    const p = Math.max(0, Math.min(1, progress));
    this.royaleDropHeight = p < 1 ? (1 - p) * 52 : 0;
    for (const handle of this.tanks.values()) {
      const dropping = p < 1 && handle.alive;
      handle.canopy.visible = dropping && !handle.cloaked;
      if (!dropping && handle.alive) {
        handle.root.position.y = 0;
        handle.root.rotation.x = 0;
        handle.root.rotation.z = 0;
      } else if (dropping) {
        // Разная фаза от координат танка не даёт всему скваду качаться как
        // одна модель. Амплитуда небольшая: читается ветер, но не тошнит.
        const phase = handle.root.position.x * 0.013 + handle.root.position.z * 0.019;
        const gust = Math.sin(this.clock * 2.35 + phase) * 0.1;
        const crosswind = Math.cos(this.clock * 1.8 + phase * 1.7) * 0.055;
        handle.root.rotation.z = gust;
        handle.root.rotation.x = crosswind;
        handle.canopy.rotation.z = -gust * 1.8;
      }
    }
    if (p >= 1) {
      this.royalePlane.visible = false;
      return;
    }
    const route = half + 90;
    this.royalePlane.visible = true;
    this.royalePlane.position.set(
      -route + p * route * 2,
      78,
      -half * 0.72 + p * half * 1.44,
    );
    this.royalePlane.rotation.y = Math.atan2(route * 2, half * 1.44);
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
    // Во время BR-десанта камера поднимается вместе с танком. Раньше модель
    // уходила на 52 м вверх, а камера продолжала смотреть на землю — поэтому
    // вся анимация существовала, но игрок её не видел.
    const drop = this.royaleDropHeight;
    const height = CAMERA_BASE_HEIGHT + Math.sin(pitch) * zoom + drop;

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
    this.cameraTarget.set(x, 2.2 + drop, z);
    this.applyShake(dt);
    this.camera.lookAt(this.cameraTarget);
  }

  /**
   * Кусты непрозрачны по умолчанию — так они читаются как заросли снаружи, в
   * третьем лице и с чужих экранов. index — тот куст (см. bushIndexAt в
   * main.ts), внутри которого сейчас физически камера от первого лица: он
   * остаётся видимым, но становится полупрозрачным. -1 — камера не в кусте,
   * всё видно как есть.
   */
  setActiveBush(index: number): void {
    if (index === this.activeBush) return;
    this.activeBush = index;
    for (let i = 0; i < this.bushMeshes.length; i++) {
      const bush = this.bushHandles[i];
      bush.mesh.visible = true;
      bush.mesh.material = i === index ? bush.fpvMaterial : bush.opaqueMaterial;
    }
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
    const drop = this.royaleDropHeight;

    if (!this.cameraReady) {
      this.cameraHeight = FPV_HEIGHT + drop;
      this.cameraReady = true;
    } else {
      this.cameraHeight += (FPV_HEIGHT + drop - this.cameraHeight) * (1 - Math.exp(-dt * 14));
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

  /** Размер частиц: он задан в метрах, а шейдер выдаёт пиксели устройства. */
  private syncParticleScale(): void {
    const heightPx = this.viewHeight * this.renderer.getPixelRatio();
    this.dust.setViewport(heightPx, this.camera.fov);
    this.debris.setViewport(heightPx, this.camera.fov);
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

  /** Переключает только внешний вид: серверная логика и список предметов не меняются. */
  setRoyaleLootVisual(enabled: boolean): void {
    if (this.royaleLootVisual === enabled) return;
    this.royaleLootVisual = enabled;
    this.clearBonuses();
  }

  /** Собирает светлый техно-стенд; силуэт и цвет сразу показывают тип лута. */
  private createLootContainer(kind: number): THREE.Group {
    const module = royaleModule(kind);
    const group = new THREE.Group();
    const accent = module?.heal !== undefined ? this.moduleHealMaterial : this.moduleTierMaterials[module?.tier ?? 1];
    const base = new THREE.Mesh(this.geo.lootBase, this.moduleShellMaterial);
    const halo = new THREE.Mesh(this.geo.lootRing, accent);
    const upperHalo = new THREE.Mesh(this.geo.lootRing, accent);
    const crystal = new THREE.Mesh(this.geo.lootCrystal, this.moduleGlassMaterial);
    const plate = new THREE.Mesh(this.geo.lootPlate, accent);
    const core = new THREE.Mesh(this.geo.lootCore, accent);

    // Маркер цвета встроен во фронт контейнера, а не висит над ним значком.
    base.position.y = 0.15;
    halo.rotation.x = Math.PI / 2;
    halo.position.y = 0.38;
    upperHalo.rotation.x = Math.PI / 2;
    upperHalo.position.y = 1.85;
    upperHalo.scale.setScalar(0.74);
    crystal.position.y = 1.1;
    crystal.scale.set(0.9, 1.25, 0.9);
    plate.position.set(0, 0.35, -1.7);
    core.position.y = 1.28;
    group.add(base, halo, upperHalo, crystal, plate, core);
    // Силуэт подсказывает класс ещё до того, как игрок подъедет к контейнеру.
    if (module?.heal !== undefined) {
      const vertical = new THREE.Mesh(this.geo.lootCross, this.moduleHealMaterial);
      const horizontal = new THREE.Mesh(this.geo.lootCross, this.moduleHealMaterial);
      vertical.position.y = 1.25;
      horizontal.position.y = 1.25;
      horizontal.rotation.y = Math.PI / 2;
      vertical.scale.setScalar(0.7);
      horizontal.scale.setScalar(0.7);
      group.add(vertical, horizontal);
    } else if (module?.slot === MODULE_SLOT_ARMOR) {
      const left = new THREE.Mesh(this.geo.lootWing, accent);
      const right = new THREE.Mesh(this.geo.lootWing, accent);
      left.position.set(-0.82, 1.25, 0);
      right.position.set(0.82, 1.25, 0);
      left.rotation.y = 0.45;
      right.rotation.y = -0.45;
      group.add(left, right);
    } else if (module?.slot === MODULE_SLOT_GUN) {
      core.rotation.z = Math.PI / 2;
      core.scale.set(1, 1.8, 1);
    } else if (module?.slot === MODULE_SLOT_LOADER) {
      for (const x of [-0.65, 0.65]) {
        const round = new THREE.Mesh(this.geo.lootCore, accent);
        round.position.set(x, 1.25, 0);
        round.scale.setScalar(0.72);
        group.add(round);
      }
    } else if (module?.slot === MODULE_SLOT_ENGINE) {
      core.rotation.x = Math.PI / 2;
      core.scale.set(1.45, 0.9, 1.45);
    } else if (module?.slot === MODULE_SLOT_CAMO) {
      const left = new THREE.Mesh(this.geo.lootWing, accent);
      const right = new THREE.Mesh(this.geo.lootWing, accent);
      left.position.set(-0.5, 1.25, 0);
      right.position.set(0.5, 1.25, 0);
      left.rotation.set(0.35, 0.45, 0.2);
      right.rotation.set(-0.35, -0.45, -0.2);
      group.add(left, right);
    } else if (module) {
      const mast = new THREE.Mesh(this.geo.lootWing, accent);
      mast.position.set(0, 2.2, 0);
      mast.rotation.z = Math.PI / 2;
      group.add(mast);
    }
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) child.castShadow = true;
    });
    return group;
  }

  /** Ставит ящики по списку из снапшота: пропавшие подобрали или они истекли. */
  syncBonuses(list: SnapshotBonus[]): void {
    for (const handle of this.bonuses.values()) handle.seen = false;

    for (const bonus of list) {
      let handle = this.bonuses.get(bonus.i);
      if (!handle) {
        const object = this.royaleLootVisual
          ? this.createLootContainer(bonus.k)
          : new THREE.Mesh(this.geo.bonus, this.bonusMaterials[bonus.k % this.bonusMaterials.length]);
        if (object instanceof THREE.Mesh) object.castShadow = true;
        this.scene.add(object);
        handle = { object, seen: true };
        this.bonuses.set(bonus.i, handle);
      }
      handle.seen = true;
      handle.object.position.set(bonus.x, this.royaleLootVisual ? 0 : BONUS_HOVER, bonus.z);
    }

    for (const [id, handle] of this.bonuses) {
      if (handle.seen) continue;
      this.scene.remove(handle.object);
      this.bonuses.delete(id);
    }
  }

  clearBonuses(): void {
    this.syncBonuses([]);
  }

  /** Старые бонусы крутятся; BR-контейнеры остаются тяжёлыми и неподвижными. */
  private updateBonuses(): void {
    if (this.royaleLootVisual || this.bonuses.size === 0) return;
    const phase = this.clock;
    const bob = Math.sin(phase * 2.2) * 0.28;
    for (const handle of this.bonuses.values()) {
      handle.object.rotation.y = phase * 1.1;
      handle.object.rotation.x = phase * 0.5;
      handle.object.position.y = BONUS_HOVER + bob;
    }
  }

  // --- Взрывы ---

  boom(x: number, z: number, kind: BoomKind): void {
    this.spawnEffect(x, BOOM_HEIGHT[kind], z, BOOM_PRESETS[kind]);
    if (kind === BOOM_HIT) this.tankHit(x, z);
  }

  /**
   * Цифра урона над местом попадания: всплывает и гаснет, как ники — DOM поверх
   * канваса, а не спрайт в сцене, иначе текст на ходу мылился бы точно так же,
   * как мылились бы ники через CSS2DRenderer (см. updateLabels).
   */
  damageNumber(x: number, z: number, amount: number): void {
    const el = document.createElement('div');
    el.className = 'dmg-number';
    el.textContent = String(amount);
    this.labelContainer.appendChild(el);
    this.damageNumbers.push({
      el,
      x,
      z,
      baseY: LABEL_HEIGHT,
      driftX: (Math.random() * 2 - 1) * 0.8,
      age: 0,
    });
  }

  /** Поднимает и гасит цифры урона; отработавшие убирает из DOM. */
  private updateDamageNumbers(dt: number): void {
    if (this.damageNumbers.length === 0) return;
    this.camera.updateMatrixWorld();

    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const dn = this.damageNumbers[i];
      dn.age += dt;
      if (dn.age >= DAMAGE_NUMBER_LIFE) {
        dn.el.remove();
        this.damageNumbers.splice(i, 1);
        continue;
      }

      const t = dn.age / DAMAGE_NUMBER_LIFE;
      // Взлёт быстрый вначале и гасит ход к концу — не равномерный подъём.
      const ease = 1 - (1 - t) * (1 - t);
      const y = dn.baseY + DAMAGE_NUMBER_RISE * ease;

      this.projected.set(dn.x + dn.driftX * t, y, dn.z);
      this.projected.project(this.camera);
      if (this.projected.z < -1 || this.projected.z > 1) {
        dn.el.style.opacity = '0';
        continue;
      }

      const x = Math.round((this.projected.x * 0.5 + 0.5) * this.viewWidth);
      const yPx = Math.round((-this.projected.y * 0.5 + 0.5) * this.viewHeight);
      const opacity = t < DAMAGE_NUMBER_FADE_FROM ? 1 : 1 - (t - DAMAGE_NUMBER_FADE_FROM) / (1 - DAMAGE_NUMBER_FADE_FROM);
      // Лёгкий наезд масштабом в первый миг — попадание «выбивает» цифру, а не
      // просто рисует её.
      const scale = t < 0.15 ? 0.6 + 0.4 * (t / 0.15) : 1;

      dn.el.style.transform = `translate(${x}px, ${yPx}px) translate(-50%, -50%) scale(${scale.toFixed(2)})`;
      dn.el.style.opacity = opacity.toFixed(2);
    }
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
  tankFired(id: number, local = false): boolean {
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
    if (local) {
      this.localMuzzleLight.position.copy(point);
      this.localMuzzleLight.intensity = LOCAL_MUZZLE_LIGHT.intensity;
      this.localMuzzleLight.distance = LOCAL_MUZZLE_LIGHT.distance;
      this.localMuzzleLight.decay = LOCAL_MUZZLE_LIGHT.decay;
      this.localMuzzleLightLife = MUZZLE_PRESET.life;
    }
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

  /**
   * Создаёт и компилирует базовые материалы эффектов до начала боя. Иначе
   * первый выстрел одновременно создаёт вспышку/дым и просит GPU собрать их
   * шейдеры, что особенно заметно на слабых видеокартах.
   */
  private warmupEffects(): void {
    if (this.effectsWarmed) return;

    const warmupScene = new THREE.Scene();
    const warmupCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    warmupCamera.position.set(0, 0, 5);
    warmupCamera.lookAt(0, 0, 0);
    const warmups: Effect[] = [];
    for (let i = 0; i < 2; i++) {
      const fx = this.createEffect(warmupScene);
      fx.group.visible = true;
      warmups.push(fx);
    }

    this.renderer.compile(warmupScene, warmupCamera);
    for (const fx of warmups) {
      fx.group.visible = false;
      warmupScene.remove(fx.group);
      this.scene.add(fx.group);
      this.effectPool.push(fx);
    }
    this.effectsWarmed = true;
  }

  private createEffect(scene = this.scene): Effect {
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

    scene.add(group);
    return { group, flash, ring, cone, life: 0, duration: 1, radius: 1, rise: 0, grow: 0.85, alpha: 0.9 };
  }

  private updateEffects(dt: number): void {
    if (this.localMuzzleLightLife > 0) {
      this.localMuzzleLightLife -= dt;
      if (this.localMuzzleLightLife <= 0) {
        this.localMuzzleLightLife = 0;
        this.localMuzzleLight.intensity = 0;
      } else {
        const t = 1 - this.localMuzzleLightLife / MUZZLE_PRESET.life;
        this.localMuzzleLight.intensity = LOCAL_MUZZLE_LIGHT.intensity * (1 - t) * (1 - t);
      }
    }

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

    this.updateBushes(dt);
  }

  /**
   * Клиентская деформация кустов: каждый листовой комок получает мягкий
   * радиальный толчок от ближайшего танка. В карты и физику это не попадает —
   * меняются только instance-матрицы уже нарисованной листвы.
   */
  private updateBushes(dt: number): void {
    if (this.bushHandles.length === 0) return;
    const radiusSq = BUSH_PUSH_RADIUS * BUSH_PUSH_RADIUS;
    let selfTank: TankHandle | null = null;
    for (const tank of this.tanks.values()) {
      if (tank.isSelf) {
        selfTank = tank;
        break;
      }
    }
    const canPush = selfTank !== null && selfTank.alive && !selfTank.cloaked;
    const tankX = selfTank?.root.position.x ?? 0;
    const tankZ = selfTank?.root.position.z ?? 0;

    for (const bush of this.bushHandles) {
      // Большинство кустов далеко от игрока: их матрицы не трогаем вообще.
      // Уже раздвинутый куст всё равно дорабатывает обратную анимацию.
      const boxDx = canPush ? Math.max(0, Math.abs(tankX - bush.centerX) - bush.halfW) : Infinity;
      const boxDz = canPush ? Math.max(0, Math.abs(tankZ - bush.centerZ) - bush.halfD) : Infinity;
      const nearTank = boxDx * boxDx + boxDz * boxDz <= radiusSq;
      if (!nearTank && !bush.displaced) continue;

      let changed = false;
      let stillDisplaced = false;
      for (let i = 0; i < bush.mesh.count; i++) {
        const x = bush.baseX[i];
        const z = bush.baseZ[i];
        let targetX = 0;
        let targetZ = 0;

        if (nearTank && selfTank && canPush) {
          const dx = x - selfTank.root.position.x;
          const dz = z - selfTank.root.position.z;
          const distanceSq = dx * dx + dz * dz;
          if (distanceSq <= radiusSq) {
            const distance = Math.sqrt(distanceSq);
            let dirX: number;
            let dirZ: number;
            if (distance > 0.001) {
              dirX = dx / distance;
              dirZ = dz / distance;
            } else {
              // В самом центре куста нет радиального направления: комок
              // расходится по ходу корпуса, как будто танк проталкивает его.
              const sign = selfTank.speed < -0.1 ? -1 : 1;
              dirX = Math.sin(selfTank.root.rotation.y) * sign;
              dirZ = Math.cos(selfTank.root.rotation.y) * sign;
            }

            const strength = 1 - distance / BUSH_PUSH_RADIUS;
            const push = strength * strength * BUSH_PUSH_DISTANCE;
            targetX = dirX * push;
            targetZ = dirZ * push;
          }
        }

        const targetLength = Math.hypot(targetX, targetZ);
        if (targetLength > BUSH_PUSH_DISTANCE) {
          const scale = BUSH_PUSH_DISTANCE / targetLength;
          targetX *= scale;
          targetZ *= scale;
        }

        const response = targetLength > 0.001 ? BUSH_PUSH_RESPONSE : BUSH_RETURN_RESPONSE;
        const blend = 1 - Math.exp(-dt * response);
        const nextX = bush.offsetX[i] + (targetX - bush.offsetX[i]) * blend;
        const nextZ = bush.offsetZ[i] + (targetZ - bush.offsetZ[i]) * blend;
        if (Math.abs(nextX - bush.offsetX[i]) < 0.0001 && Math.abs(nextZ - bush.offsetZ[i]) < 0.0001) continue;

        bush.offsetX[i] = nextX;
        bush.offsetZ[i] = nextZ;
        if (Math.abs(nextX) > 0.0005 || Math.abs(nextZ) > 0.0005) stillDisplaced = true;
        this.bushMatrix.copy(bush.baseMatrices[i]);
        this.bushMatrix.elements[12] += nextX;
        this.bushMatrix.elements[14] += nextZ;
        bush.mesh.setMatrixAt(i, this.bushMatrix);
        changed = true;
      }
      bush.displaced = stillDisplaced;
      if (changed) bush.mesh.instanceMatrix.needsUpdate = true;
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

  /** Только свой танк — толчок травы под остальными 39 в BR не стоит доп. uniform'ов. */
  private updateGrassPlayer(): void {
    if (!this.grassPlayerPos) return;
    let found = false;
    for (const tank of this.tanks.values()) {
      if (!tank.isSelf) continue;
      if (tank.alive && !tank.cloaked) {
        this.grassPlayerPos.set(tank.root.position.x, tank.root.position.z);
        found = true;
      }
      break;
    }
    if (!found) this.grassPlayerPos.set(GRASS_PUSH_IDLE, GRASS_PUSH_IDLE);
  }

  render(dt: number): void {
    this.clock += dt;
    if (this.grassWind) this.grassWind.value = this.clock;
    this.updateGrassPlayer();
    this.updateEnvironment(dt);
    this.updateWeather(dt);
    this.updateEffects(dt);
    this.updateRecoil(dt);
    this.updateChassis(dt);
    this.updateWrecks(dt);
    this.updateBonuses();
    this.tracks.update(this.clock);
    this.dust.update(this.clock);
    this.debris.update(this.clock);
    if (this.bloomOn) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.updateLabels();
    this.updateDamageNumbers(dt);
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
    this.camera.updateMatrixWorld();

    for (const handle of this.tanks.values()) {
      // Не товарищ — подписи не было и не будет (см. ensureLabel): даже
      // проекцию на экран считать незачем, а таких танков в BR — почти все.
      if (!handle.plated && !handle.label) continue;

      this.projected.set(
        handle.root.position.x,
        LABEL_HEIGHT,
        handle.root.position.z,
      );
      const distance = this.projected.distanceTo(this.camera.position);
      this.projected.project(this.camera);

      // z вне [-1, 1] значит «за камерой или за дальней плоскостью».
      const visible =
        handle.plated &&
        handle.root.visible &&
        handle.alive &&
        !handle.cloaked &&
        distance < LABEL_MAX_DISTANCE &&
        this.projected.z > -1 &&
        this.projected.z < 1;

      if (!handle.label) continue;
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

    for (const marker of this.contactMarkers.values()) {
      this.projected.set(marker.x, 1.25, marker.z);
      const distance = this.projected.distanceTo(this.camera.position);
      this.projected.project(this.camera);
      const visible =
        distance < LABEL_MAX_DISTANCE * 1.4 &&
        this.projected.z > -1 &&
        this.projected.z < 1;
      marker.el.style.display = visible ? '' : 'none';
      if (!visible) continue;
      const x = Math.round((this.projected.x * 0.5 + 0.5) * this.viewWidth) - 12;
      const y = Math.round((-this.projected.y * 0.5 + 0.5) * this.viewHeight) - 12;
      marker.el.style.opacity = String(Math.max(0.32, Math.min(1, marker.until / 5)));
      marker.el.style.transform = `translate(${x}px, ${y}px)`;
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
    // Композитор тянет пиксельную плотность из рендерера сам, поэтому размер
    // ему отдаётся в тех же условных пикселях, что и рендереру.
    this.composer.setSize(width, height);
    this.bloomPass.setSize(width, height);
    // Размер частицы задан в метрах, а шейдер выдаёт пиксели устройства.
    this.syncParticleScale();
  };
}
