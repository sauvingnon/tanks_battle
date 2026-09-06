import { MAP_HALF } from './constants.js';
import type { Box } from './types.js';

/**
 * Карты. Геометрия статична и одинакова у сервера и клиента, но клиент не строит
 * её сам: сервер присылает готовые коробки в welcome и в сообщении map, поэтому
 * менять планировки можно только здесь.
 *
 * Общие правила для любой карты:
 *  - всё выровнено по осям, иначе перестанут работать свипы снарядов и рикошеты;
 *  - высота блока выше SHELL_HEIGHT (2.15), иначе укрытие не укрывает;
 *  - проезд между блоками не уже 8 м: танк — круг радиусом 2.4, и в щель
 *    впритык он заезжает, но выбраться уже не может;
 *  - точки спавна перечислены руками и проверяются npm run check:map.
 */
export interface MapDef {
  name: string;
  build: () => Box[];
  /** Точки появления танков; лицом к центру карты. */
  spawns: Array<[number, number]>;
}

/** Двенадцать точек по кругу — исторический спавн первой карты. */
function ring(radius: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    out.push([Math.sin(a) * radius, Math.cos(a) * radius]);
  }
  return out;
}

/**
 * Двенадцать точек по периметру квадрата со стороной 2r. Нужен там, где круг
 * прошёл бы сквозь застройку: у «Города» кварталы стоят сеткой, и свободна
 * ровно окраина.
 */
function perimeter(r: number): Array<[number, number]> {
  const mid = Math.round(r * 0.5);
  return [
    [0, r],
    [mid, r],
    [r, mid],
    [r, 0],
    [r, -mid],
    [mid, -r],
    [0, -r],
    [-mid, -r],
    [-r, -mid],
    [-r, 0],
    [-r, mid],
    [-mid, r],
  ];
}

/** Четыре знака для поворотной симметрии на 90 градусов. */
const CORNERS: Array<[number, number]> = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];

/** Симметричная расстановка блоков вокруг центра — карта, с которой всё началось. */
function buildKremlin(): Box[] {
  const boxes: Box[] = [];
  const add = (x: number, z: number, w: number, d: number, h: number) => {
    boxes.push({ x, z, w, d, h });
  };

  // Центральный «кремль».
  add(0, 0, 14, 14, 5);
  add(0, 22, 20, 4, 3);
  add(0, -22, 20, 4, 3);
  add(22, 0, 4, 20, 3);
  add(-22, 0, 4, 20, 3);

  // Четыре угловых укрытия — поворотная симметрия на 90 градусов.
  for (const [sx, sz] of CORNERS) {
    add(sx * 42, sz * 42, 16, 6, 4);
    add(sx * 42, sz * 30, 6, 10, 2.5);
    add(sx * 55, sz * 18, 8, 8, 3.5);
  }

  // Редкие одиночные блоки, чтобы поле не было пустым.
  add(0, 48, 10, 6, 3);
  add(0, -48, 10, 6, 3);
  add(48, 0, 6, 10, 3);
  add(-48, 0, 6, 10, 3);

  return boxes;
}

/**
 * «Форт»: стены с четырьмя воротами в центре карты, внутри двор с бункером.
 * Волнам это даёт форму, которой не хватало открытой карте: есть что держать,
 * есть куда отходить, а ворота — естественные точки боя и рикошетов. Снаружи
 * просторно, поэтому боты подходят на виду, а не выныривают из-за угла.
 */
function buildFort(): Box[] {
  const boxes: Box[] = [];
  const add = (x: number, z: number, w: number, d: number, h: number) => {
    boxes.push({ x, z, w, d, h });
  };

  // Стена форта: сторона от -22 до 22, ворота шириной 10 посередине каждой.
  const wall = 22;
  const gate = 5; // половина ворот
  const thick = 4;
  const span = (wall - gate) / 2 + gate; // центр половинки стены
  const length = wall - gate;
  for (const side of [1, -1]) {
    for (const dir of [1, -1]) {
      add(dir * span, side * wall, length, thick, 5);
      add(side * wall, dir * span, thick, length, 5);
    }
  }

  // Двор: четыре тумбы по углам. Середину держим пустой — сквозь ворота должен
  // простреливаться весь двор насквозь, иначе они перестают быть точкой боя.
  for (const [sx, sz] of CORNERS) add(sx * 10, sz * 10, 5, 5, 3);

  // Подступы: по блоку на каждую сторону и по диагонали, чтобы поле не было голым.
  add(0, 46, 14, 6, 3.5);
  add(0, -46, 14, 6, 3.5);
  add(46, 0, 6, 14, 3.5);
  add(-46, 0, 6, 14, 3.5);
  for (const [sx, sz] of CORNERS) add(sx * 38, sz * 38, 10, 10, 3);

  return boxes;
}

/**
 * «Город»: сетка кварталов с улицами по 12 м. Линии огня короткие, зато углов и
 * рикошетов — сколько угодно. Ботам здесь негде работать с любимой дистанции
 * 32-44 м, поэтому дерутся они заметно ближе и злее.
 */
function buildCity(): Box[] {
  const boxes: Box[] = [];
  const centers = [-48, -24, 0, 24, 48];
  // Кварталы 12x12 при шаге 24 оставляют улицу ровно 12 м.
  for (const x of centers) {
    for (const z of centers) {
      // Центральный квартал снесён — это площадь, единственное открытое место.
      if (x === 0 && z === 0) continue;
      // Высоты вразнобой, но все выше высоты полёта снаряда.
      const h = 3 + ((Math.abs(x) + Math.abs(z)) % 3);
      boxes.push({ x, z, w: 12, d: 12, h });
    }
  }
  return boxes;
}

/**
 * «Овраг»: сплошная стена делит карту надвое, пройти можно тремя проходами.
 * Карта для «все против всех»: фланги, засады у проходов, длинные дуэли вдоль
 * стены. В волнах она честная, но однобокая — боты идут с одной стороны и
 * толпятся в проходах.
 */
function buildRavine(): Box[] {
  const boxes: Box[] = [];
  const add = (x: number, z: number, w: number, d: number, h: number) => {
    boxes.push({ x, z, w, d, h });
  };

  // Стена по x = 0 с проходами шириной 12 напротив z = -35, 0, 35.
  for (const [from, to] of [
    [-MAP_HALF, -41],
    [-29, -6],
    [6, 29],
    [41, MAP_HALF],
  ]) {
    add(0, (from + to) / 2, 5, to - from, 5);
  }

  // Укрытия на обеих половинах: зеркально, чтобы никому не было выгоднее.
  for (const side of [1, -1]) {
    add(side * 25, 40, 12, 6, 3.5);
    add(side * 25, -40, 12, 6, 3.5);
    add(side * 45, 15, 6, 14, 3);
    add(side * 45, -15, 6, 14, 3);
    add(side * 35, 0, 10, 10, 4);
  }

  return boxes;
}

/** Спавны «Оврага»: свободные колонны у боковых стен, по шесть на половину. */
const RAVINE_SPAWNS: Array<[number, number]> = [];
for (const x of [-62, 62]) {
  for (const z of [-55, -33, -11, 11, 33, 55]) RAVINE_SPAWNS.push([x, z]);
}

export const MAPS: MapDef[] = [
  { name: 'Кремль', build: buildKremlin, spawns: ring(MAP_HALF - 10) },
  { name: 'Форт', build: buildFort, spawns: perimeter(60) },
  { name: 'Город', build: buildCity, spawns: perimeter(62) },
  { name: 'Овраг', build: buildRavine, spawns: RAVINE_SPAWNS },
];

export const MAP_NAMES = MAPS.map((m) => m.name);
export const MAP_COUNT = MAPS.length;

export function isMapId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < MAP_COUNT;
}

/** Геометрия карты. Сервер строит её один раз на смену карты и рассылает клиентам. */
export function buildMap(id = 0): Box[] {
  return MAPS[isMapId(id) ? id : 0].build();
}

/** Точка респавна по кругу спавнов карты, лицом к центру. */
export function spawnPoint(index: number, id = 0): { x: number; z: number; angle: number } {
  const spawns = MAPS[isMapId(id) ? id : 0].spawns;
  const [x, z] = spawns[((index % spawns.length) + spawns.length) % spawns.length];
  // Разворачиваем к центру: направление (0,0) - (x,z).
  return { x, z, angle: Math.atan2(-x, -z) };
}

export function spawnCount(id = 0): number {
  return MAPS[isMapId(id) ? id : 0].spawns.length;
}
