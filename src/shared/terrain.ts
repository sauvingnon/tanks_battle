import type { Box } from './types.js';

/**
 * Рельеф: высотное поле карты.
 *
 * Поле — сетка высот с билинейной выборкой, а не произвольная геометрия. Причин
 * четыре, и все они про то, чтобы рельеф не потянул за собой физический движок:
 *  - выборка стоит O(1) и не зависит от того, сколько на карте холмов;
 *  - поле детерминировано и живёт в shared/, поэтому предсказание клиента считает
 *    ровно ту же землю, что и сервер;
 *  - луч трассируется маршем со сравнением высот — прямое продолжение sweepShell;
 *  - танк остаётся кругом в плане, resolveObstacles не меняется: рельеф добавляет
 *    танку высоту и наклон, а не новую физику.
 *
 * Высоты хранятся целыми в дециметрах — ровно в том виде, в каком уходят в сеть.
 * Клиент получает готовый массив (геометрию карты он и так не строит сам), и обе
 * стороны считают по одним и тем же числам, а не по «одинаковым» формулам: тихого
 * рассинхрона из-за разной арифметики генератора быть не может в принципе.
 *
 * Аркада — вырожденный случай: FLAT, все высоты нули, ни одной лишней выборки.
 */
export interface Terrain {
  /** Половина стороны квадрата, м: поле покрывает [-half, half] по X и Z. */
  half: number;
  /** Шаг сетки, м. */
  step: number;
  /** Узлов по стороне: 2*half/step + 1. */
  n: number;
  /** Высоты узлов в дециметрах, ряд за рядом по Z. */
  d: number[];
  /** Поле нулевое. Все выборки уходят по короткому пути и стоят одно сравнение. */
  flat: boolean;
}

/** Шаг сетки высот, м. Полкорпуса танка: холм мельче этого танк всё равно сгладит. */
export const TERRAIN_STEP = 4;

/** Плоскость. Аркада живёт на ней, и стоит она ровно ничего. */
export const FLAT: Terrain = { half: 0, step: TERRAIN_STEP, n: 0, d: [], flat: true };

/** Описание рельефа карты: генератор разворачивает его в поле высот. */
export interface TerrainDef {
  /** Любое целое: одно и то же число всегда даёт один и тот же рельеф. */
  seed: number;
  /** Размах высот, м. Поле лежит примерно в [-amp, amp]. */
  amp: number;
  /** Поперечник холма, м. */
  feature: number;
}

/** Высота земли в точке; вне поля — как на ближайшем его краю. */
export function heightAt(t: Terrain, x: number, z: number): number {
  if (t.flat) return 0;

  const last = t.n - 1;
  const u = clip((x + t.half) / t.step, 0, last);
  const v = clip((z + t.half) / t.step, 0, last);
  const i = Math.min(Math.floor(u), last - 1);
  const j = Math.min(Math.floor(v), last - 1);
  const fx = u - i;
  const fz = v - j;

  const row = j * t.n + i;
  const a = t.d[row];
  const b = t.d[row + 1];
  const c = t.d[row + t.n];
  const e = t.d[row + t.n + 1];

  const near = a + (b - a) * fx;
  const far = c + (e - c) * fx;
  return (near + (far - near) * fz) * 0.1;
}

/**
 * Уклон земли в точке: прирост высоты на метр по X и по Z. Считается по той же
 * билинейной клетке, что и высота, поэтому наклон корпуса и высота под ним всегда
 * согласованы — танк не висит углом над склоном.
 */
export function slopeAt(t: Terrain, x: number, z: number): { dx: number; dz: number } {
  if (t.flat) return { dx: 0, dz: 0 };

  const last = t.n - 1;
  const u = clip((x + t.half) / t.step, 0, last);
  const v = clip((z + t.half) / t.step, 0, last);
  const i = Math.min(Math.floor(u), last - 1);
  const j = Math.min(Math.floor(v), last - 1);
  const fx = u - i;
  const fz = v - j;

  const row = j * t.n + i;
  const a = t.d[row];
  const b = t.d[row + 1];
  const c = t.d[row + t.n];
  const e = t.d[row + t.n + 1];

  // Производные билинейной поверхности: по X растут вдоль ряда, по Z — поперёк.
  const k = 0.1 / t.step;
  return {
    dx: (b - a + (e - c - (b - a)) * fz) * k,
    dz: (c - a + (e - b - (c - a)) * fx) * k,
  };
}

/**
 * Доля отрезка до касания земли, 0..1, или null — путь над рельефом свободен.
 *
 * Марш по отрезку с шагом в полклетки: между узлами поле линейно, и пропустить
 * гребень на таком шаге нельзя. Внутри клетки точка касания уточняется линейно —
 * снаряд взрывается на склоне там, куда прилетел, а не там, где случился отсчёт.
 */
export function groundHit(
  t: Terrain,
  x: number,
  z: number,
  y: number,
  dx: number,
  dz: number,
  dy: number,
): number | null {
  let below = y - heightAt(t, x, z);
  // Снаряд начал шаг под землёй: такое бывает после отскока у самого склона.
  if (below <= 0) return 0;

  const span = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(span / (t.step * 0.5)));
  for (let i = 1; i <= steps; i++) {
    const s = i / steps;
    const next = y + dy * s - heightAt(t, x + dx * s, z + dz * s);
    if (next <= 0) {
      // Линейная интерполяция по разнице высот: below > 0 >= next.
      const back = below / (below - next);
      return ((i - 1) + back) / steps;
    }
    below = next;
  }
  return null;
}

// --- Генератор ---

/**
 * Поле высот по описанию карты. Считается один раз на смену карты (сервером) и
 * дальше живёт как данные: клиенту уходит готовый массив.
 */
export function buildTerrain(def: TerrainDef, half: number, step = TERRAIN_STEP): Terrain {
  const n = Math.round((half * 2) / step) + 1;
  const raw = new Array<number>(n * n);

  let sum = 0;
  for (let j = 0; j < n; j++) {
    const z = -half + j * step;
    for (let i = 0; i < n; i++) {
      const x = -half + i * step;
      // Три октавы: крупные холмы, складки на них и мелкая неровность. Веса
      // подобраны так, чтобы уклон оставался проезжаемым, а гребни — читаемыми.
      const h =
        def.amp *
        (0.62 * noise(def.seed, x, z, def.feature) +
          0.28 * noise(def.seed + 101, x, z, def.feature / 2.3) +
          0.1 * noise(def.seed + 202, x, z, def.feature / 5));
      raw[j * n + i] = h;
      sum += h;
    }
  }

  // Средний уровень уводим в ноль: «высота 0» должна значить «обычная земля»,
  // иначе вся карта незаметно уезжает вверх или вниз вместе со стенами и танками.
  const mean = sum / raw.length;
  const d = raw.map((h) => Math.round((h - mean) * 10));
  return { half, step, n, d, flat: false };
}

/** Значение шума в точке, -1..1. Решётка с шагом cell, сглаживание smoothstep. */
function noise(seed: number, x: number, z: number, cell: number): number {
  const u = x / cell;
  const v = z / cell;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fx = smooth(u - i);
  const fz = smooth(v - j);

  const a = lattice(seed, i, j);
  const b = lattice(seed, i + 1, j);
  const c = lattice(seed, i, j + 1);
  const e = lattice(seed, i + 1, j + 1);

  const near = a + (b - a) * fx;
  const far = c + (e - c) * fx;
  return (near + (far - near) * fz) * 2 - 1;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Значение решётки в узле, 0..1. Целочисленный хеш: одинаков везде, где считается. */
function lattice(seed: number, i: number, j: number): number {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Ровняет землю под блоками и проставляет им основание.
 *
 * Блок — прямоугольник, выровненный по осям, и стоять на склоне он не умеет:
 * одним углом повис бы в воздухе, другим ушёл бы в грунт, а укрытие превратилось
 * бы в щель под стеной. Поэтому под каждым блоком земля выравнивается площадкой,
 * а по краю площадка сходит на нет за margin метров — получается насыпь, а не
 * ступенька. Высота площадки берётся из исходного поля, до всех правок, иначе
 * соседние блоки тянули бы землю друг за другом.
 *
 * После этого «верх блока» — это ровно box.y + box.h, и никакой разницы между
 * углами блока нет: правило укрытия остаётся тем же, что на плоскости.
 */
export function settleBoxes(t: Terrain, boxes: Box[], margin = TERRAIN_STEP * 1.5): void {
  if (t.flat) {
    for (const box of boxes) box.y = 0;
    return;
  }

  const before = t.d.slice();
  const level = (x: number, z: number) => heightAt({ ...t, d: before }, x, z);

  for (const box of boxes) {
    const hw = box.w / 2;
    const hd = box.d / 2;
    // Площадка встаёт на среднюю высоту своего пятна: центр и четыре угла.
    const pad =
      (level(box.x, box.z) +
        level(box.x - hw, box.z - hd) +
        level(box.x + hw, box.z - hd) +
        level(box.x - hw, box.z + hd) +
        level(box.x + hw, box.z + hd)) /
      5;
    box.y = Math.round(pad * 10) * 0.1;

    const from = (v: number) => Math.max(0, Math.floor((v + t.half) / t.step));
    const to = (v: number) => Math.min(t.n - 1, Math.ceil((v + t.half) / t.step));
    for (let j = from(box.z - hd - margin); j <= to(box.z + hd + margin); j++) {
      const z = -t.half + j * t.step;
      for (let i = from(box.x - hw - margin); i <= to(box.x + hw + margin); i++) {
        const x = -t.half + i * t.step;
        // Полный вес держится на клетку дальше самого блока и только потом
        // сходит к нулю. Без этого запаса узел за гранью тянул бы вверх землю
        // внутри пятна: выборка между узлами линейна, и площадка у края блока
        // переставала быть ровной ровно там, где блок на неё опирается.
        const out = Math.max(Math.abs(x - box.x) - hw, Math.abs(z - box.z) - hd, 0);
        const w = out <= t.step ? 1 : Math.max(0, 1 - (out - t.step) / margin);
        if (w <= 0) continue;
        const cell = j * t.n + i;
        t.d[cell] = Math.round(t.d[cell] + (box.y * 10 - t.d[cell]) * w);
      }
    }
  }
}

// --- Сеть ---

/** Поле в том виде, в каком уходит клиенту. Плоскости в сети нет вовсе. */
export interface TerrainNet {
  half: number;
  step: number;
  d: number[];
}

export function terrainNet(t: Terrain): TerrainNet | undefined {
  return t.flat ? undefined : { half: t.half, step: t.step, d: t.d };
}

/** Обратно из сети. Нет поля — значит плоскость, то есть аркадная карта. */
export function terrainFrom(net: TerrainNet | undefined): Terrain {
  if (!net || !Array.isArray(net.d) || net.d.length < 4) return FLAT;
  const n = Math.round((net.half * 2) / net.step) + 1;
  if (n * n !== net.d.length) return FLAT;
  return { half: net.half, step: net.step, n, d: net.d, flat: false };
}

/** Свой, чтобы не заводить цикл импортов с sim.ts: рельеф — лист в дереве модулей. */
function clip(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
