import { MAP_HALF, SHELL_HEIGHT } from './constants.js';
import type { Box } from './types.js';

/**
 * Карты. Геометрия статична и одинакова у сервера и клиента, но клиент не строит
 * её сам: сервер присылает готовые коробки в welcome и в сообщении map, поэтому
 * менять планировки можно только здесь.
 *
 * Общие правила для любой карты:
 *  - всё выровнено по осям, иначе перестанут работать свипы снарядов и рикошеты;
 *  - блок выше SHELL_HEIGHT (2.15) укрывает от огня, ниже — только мешает ехать:
 *    через него видно, простреливается насквозь, но проехать нельзя;
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

/** Высота низкого укрытия: ниже SHELL_HEIGHT, значит простреливается насквозь. */
const LOW = 1.5;

/**
 * «Окопы»: поперечные брустверы с разбежкой в проходах. Стрелять можно через всю
 * карту, а ехать — только зигзагом от прохода к проходу, и на этом пути ты весь
 * бой на виду. Карта про то, что «вижу» и «достану» перестали быть одним и тем же.
 */
function buildTrenches(): Box[] {
  const boxes: Box[] = [];

  // Ряд брустверов вдоль X с проходами в перечисленных точках.
  const line = (z: number, gaps: number[]) => {
    const half = 7; // половина прохода: 14 м, танку хватает с запасом
    const edges = [-MAP_HALF, ...gaps.flatMap((g) => [g - half, g + half]), MAP_HALF];
    for (let i = 0; i < edges.length; i += 2) {
      const from = edges[i];
      const to = edges[i + 1];
      if (to - from < 1) continue;
      boxes.push({ x: (from + to) / 2, z, w: to - from, d: 2.5, h: LOW });
    }
  };

  // Проходы соседних рядов не совпадают: иначе через карту шёл бы прямой коридор.
  line(-50, [-35, 35]);
  line(-25, [0]);
  line(0, [-35, 35]);
  line(25, [0]);
  line(50, [-35, 35]);

  // Настоящие укрытия: без них поле простреливается насквозь и прятаться негде.
  for (const [x, z] of [
    [-40, -37],
    [40, -37],
    [0, -12],
    [0, 12],
    [-40, 37],
    [40, 37],
  ]) {
    boxes.push({ x, z, w: 6, d: 6, h: 4.5 });
  }

  return boxes;
}

/** Спавны «Окопов»: в полосах между брустверами, у боковых стен и за крайними рядами. */
const TRENCH_SPAWNS: Array<[number, number]> = [
  [-62, -37], [-62, -12], [-62, 12], [-62, 37],
  [62, -37], [62, -12], [62, 12], [62, 37],
  [-30, -63], [30, -63], [-30, 63], [30, 63],
];

/**
 * «Автопарк»: ряды контейнеров и один высокий ангар посередине. Контейнеры ниже
 * высоты полёта, поэтому весь парк простреливается поверху, а ехать приходится
 * по проездам. Дуэль тут выигрывает тот, кто раньше понял, что его видно.
 */
function buildDepot(): Box[] {
  const boxes: Box[] = [];

  // Ангар — единственное настоящее укрытие, поэтому он в центре и за него дерутся.
  boxes.push({ x: 0, z: 0, w: 20, d: 14, h: 5 });

  // Контейнеры 4x12: шаг 15 по X даёт проезд 11 м, шаг 22 по Z — 10 м.
  for (const x of [-52.5, -37.5, -22.5, -7.5, 7.5, 22.5, 37.5, 52.5]) {
    for (const z of [-54, -32, -10, 10, 32, 54]) {
      // Два ряда у ангара пришлось бы ставить внахлёст с ним.
      if (Math.abs(x) < 10 && Math.abs(z) < 20) continue;
      boxes.push({ x, z, w: 4, d: 12, h: LOW });
    }
  }

  // Пара сторожевых будок по углам: чтобы укрытие было не только в центре.
  for (const [sx, sz] of CORNERS) boxes.push({ x: sx * 45, z: sz * 45, w: 7, d: 7, h: 4 });

  return boxes;
}

/**
 * «Дюны»: открытая карта с длинными линиями огня и низкими барханами. Спрятаться
 * почти негде — только три скальных выхода, — зато проехать напрямик тоже нельзя.
 * Самая «снайперская» из карт: важнее позиция, чем укрытие.
 */
function buildDunes(): Box[] {
  const boxes: Box[] = [];
  const low = (x: number, z: number, w: number, d: number) => {
    boxes.push({ x, z, w, d, h: LOW });
  };

  for (const [sx, sz] of CORNERS) {
    low(sx * 22, sz * 20, 16, 10);
    low(sx * 48, sz * 16, 10, 18);
    low(sx * 16, sz * 48, 18, 10);
    low(sx * 56, sz * 52, 14, 14);
  }

  // Три скальных выхода — единственное, что держит снаряд.
  boxes.push({ x: 0, z: 0, w: 12, d: 12, h: 4.5 });
  boxes.push({ x: -38, z: 38, w: 9, d: 9, h: 4 });
  boxes.push({ x: 38, z: -38, w: 9, d: 9, h: 4 });

  return boxes;
}

export const MAPS: MapDef[] = [
  { name: 'Кремль', build: buildKremlin, spawns: ring(MAP_HALF - 10) },
  { name: 'Форт', build: buildFort, spawns: perimeter(60) },
  { name: 'Город', build: buildCity, spawns: perimeter(62) },
  { name: 'Овраг', build: buildRavine, spawns: RAVINE_SPAWNS },
  { name: 'Окопы', build: buildTrenches, spawns: TRENCH_SPAWNS },
  { name: 'Автопарк', build: buildDepot, spawns: perimeter(63) },
  { name: 'Дюны', build: buildDunes, spawns: ring(MAP_HALF - 8) },
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

/**
 * Блоки, которые останавливают снаряд. Всё, что ниже высоты полёта, снаряд
 * проходит насквозь: низкое укрытие мешает ехать, но не стрелять. Список
 * считается один раз на смену карты — фильтровать его в каждом свипе было бы
 * самой дорогой строчкой сервера.
 */
export function coverBoxes(obstacles: Box[]): Box[] {
  return obstacles.filter((box) => box.h >= SHELL_HEIGHT);
}

export function spawnCount(id = 0): number {
  return MAPS[isMapId(id) ? id : 0].spawns.length;
}
