/**
 * Проверка всех карт: спавны не в блоках, блоки не перекрывают друг друга внахлёст
 * так, чтобы образовалась непроездная щель, и весь свободный объём карты связен —
 * то есть до любого закутка можно доехать.
 * Запуск: npm run check:map
 */
import { SHELL_HEIGHT, TANK_RADIUS } from '../src/shared/constants.js';
import { coverBoxes, MAPS, mapHalf, passableObstacles, spawnCount, spawnPoint } from '../src/shared/map.js';
import { boxCollisionSize, distanceToPolygon, worldCollisionPolygon, type Box } from '../src/shared/types.js';

/** Запас поверх радиуса танка: впритык он заезжает, но выехать уже не может. */
const CLEARANCE = TANK_RADIUS + 0.6;
/** Шаг сетки проходимости, м. */
const STEP = 2;

let bad = 0;

/** Расстояние от точки до ближайшего блока (0 — внутри блока). */
function gap(x: number, z: number, boxes: Box[]): number {
  let nearest = Infinity;
  for (const box of boxes) {
    if (box.collisionPolygon && box.collisionPolygon.length >= 3) {
      nearest = Math.min(nearest, distanceToPolygon(x, z, worldCollisionPolygon(box)));
      continue;
    }
    const size = boxCollisionSize(box);
    const hw = size.w / 2;
    const hd = size.d / 2;
    const nx = Math.min(Math.max(x, box.x - hw), box.x + hw);
    const nz = Math.min(Math.max(z, box.z - hd), box.z + hd);
    nearest = Math.min(nearest, Math.hypot(x - nx, z - nz));
  }
  return nearest;
}

/**
 * Заливка по сетке от первого спавна. Клетка проездная, если центр танка в ней
 * не задевает блок и не выходит за стены. Если после заливки остались
 * недостижимые проездные клетки — на карте есть отрезанный карман.
 */
function reachability(
  boxes: Box[],
  from: { x: number; z: number },
  half: number,
): {
  free: number;
  reached: number;
} {
  const limit = half - TANK_RADIUS;
  const size = Math.floor((limit * 2) / STEP) + 1;
  const index = (ix: number, iz: number) => iz * size + ix;
  const toWorld = (i: number) => -limit + i * STEP;

  const open = new Uint8Array(size * size);
  let free = 0;
  for (let iz = 0; iz < size; iz++) {
    for (let ix = 0; ix < size; ix++) {
      if (gap(toWorld(ix), toWorld(iz), boxes) < TANK_RADIUS) continue;
      open[index(ix, iz)] = 1;
      free++;
    }
  }

  const seen = new Uint8Array(size * size);
  const startX = Math.round((from.x + limit) / STEP);
  const startZ = Math.round((from.z + limit) / STEP);
  const queue = [index(startX, startZ)];
  seen[queue[0]] = 1;
  let reached = open[queue[0]] ? 1 : 0;

  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    const ix = cell % size;
    const iz = (cell - ix) / size;
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = ix + dx;
      const nz = iz + dz;
      if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
      const next = index(nx, nz);
      if (seen[next] || !open[next]) continue;
      seen[next] = 1;
      reached++;
      queue.push(next);
    }
  }
  return { free, reached };
}

for (let id = 0; id < MAPS.length; id++) {
  const boxes = MAPS[id].build();
  // Крыши, козырьки и поднятые ворота enterable-объектов находятся над землёй
  // и не должны превращаться в невидимые стены этой проверки.
  const physicsBoxes = boxes.filter((box) => box.solid !== false);
  const count = spawnCount(id);
  const half = mapHalf(id);
  const low = physicsBoxes.length - coverBoxes(physicsBoxes).length;
  console.log(
    `\n=== ${MAPS[id].name} (${half * 2}×${half * 2}, ${boxes.length} блоков, ` +
      `из них низких ${low}, ${count} спавнов) ===`,
  );

  // Блок ровно на высоте полёта — это не низкое укрытие и не стена, а лотерея
  // из погрешности: снаряд то проходит, то нет. Требуем внятного зазора.
  const ambiguous = physicsBoxes.filter((b) => Math.abs(b.h - SHELL_HEIGHT) < 0.3);
  if (ambiguous.length > 0) {
    bad++;
    console.log(`  ${ambiguous.length} блоков стоят на самой высоте полёта — ДВУСМЫСЛЕННО`);
  }

  // Блок за стеной — это не укрытие, а кусок геометрии, до которого не доехать
  // и в который снаряд не попадёт: свип гасит его о стену раньше.
  const outside = physicsBoxes.filter(
    (b) => Math.abs(b.x) + b.w / 2 > half || Math.abs(b.z) + b.d / 2 > half,
  );
  if (outside.length > 0) {
    bad++;
    console.log(`  ${outside.length} блоков вылезли за стену карты — ЗА ПРЕДЕЛАМИ`);
  }

  let worst = Infinity;
  for (let i = 0; i < count; i++) {
    const spawn = spawnPoint(i, id);
    const toBox = gap(spawn.x, spawn.z, physicsBoxes);
    const toWall = half - Math.max(Math.abs(spawn.x), Math.abs(spawn.z));
    const ok = toBox >= CLEARANCE && toWall >= CLEARANCE;
    if (!ok) {
      bad++;
      console.log(
        `  #${i} (${spawn.x.toFixed(0)}, ${spawn.z.toFixed(0)}) ` +
          `до блока ${toBox.toFixed(2)} м, до стены ${toWall.toFixed(2)} м — ЗАДЕВАЕТ`,
      );
    }
    worst = Math.min(worst, toBox, toWall);
  }
  console.log(`  спавны: минимальный зазор ${worst.toFixed(2)} м (нужно ${CLEARANCE.toFixed(1)})`);

  const { free, reached } = reachability(passableObstacles(physicsBoxes), spawnPoint(0, id), half);
  const share = (reached / free) * 100;
  if (reached !== free) bad++;
  console.log(
    `  проходимость: доступно ${reached} из ${free} клеток (${share.toFixed(1)}%)` +
      (reached === free ? '' : ' — ЕСТЬ ОТРЕЗАННЫЕ КАРМАНЫ'),
  );
}

console.log(bad === 0 ? '\nВсе карты чистые' : `\nПроблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
