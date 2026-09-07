/**
 * Проверка рельефа: высотное поле, полёт снаряда над ним и то, что аркада от
 * него не изменилась ни в одном числе.
 *
 * Стенд нужен по той же причине, что и стенд вида сверху: ошибки здесь молчат.
 * Перепутанная ось в выборке даёт зеркальный рельеф — картинка выглядит нормально,
 * а снаряд упирается в холм, которого на экране нет. Разъехавшиеся у сервера и
 * клиента высоты — тихий рассинхрон предсказания. Утёкшая в аркаду вертикальная
 * наводка — молча изменившийся бой на семи настроенных картах.
 * Запуск: npm run check:terrain
 */
import {
  GUN_PITCH_MAX,
  GUN_PITCH_MIN,
  MAP_HALF,
  SHELL_HEIGHT,
  SHELL_SPEED,
  TANK_HEIGHT,
} from '../src/shared/constants.js';
import { buildScene, coverBoxes, mapHalf, MAP_NAMES, MAPS } from '../src/shared/map.js';
import { spawnShell, stepTank, sweepShell, sweepTank } from '../src/shared/sim.js';
import {
  buildTerrain,
  FLAT,
  groundHit,
  heightAt,
  settleBoxes,
  slopeAt,
  terrainFrom,
  terrainNet,
  TERRAIN_STEP,
  type Terrain,
} from '../src/shared/terrain.js';
import { createTankState, type Box, type ShellState } from '../src/shared/types.js';

let bad = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) bad++;
  console.log(`  ${ok ? '·' : '!'} ${label}${detail ? ` — ${detail}` : ''}${ok ? '' : ' — ПЛОХО'}`);
}

/** Луч длиной в отрезок: dt = 1, поэтому скорость и есть смещение. */
function ray(
  x: number,
  z: number,
  y: number,
  dx: number,
  dz: number,
  dy: number,
): ShellState {
  return { id: 0, owner: -1, x, z, y, vx: dx, vz: dz, vy: dy, life: 1, bounces: 0 };
}

const field = buildTerrain({ seed: 7, amp: 4, feature: 30 }, MAP_HALF);

/** Сколько карт нарисовано под аркаду. Все они плоские и все размера 140×140. */
const ARCADE_MAPS = 7;
const HILLS = MAP_NAMES.indexOf('Холмы');

// --- Плоскость: аркада ---

console.log('\n=== Плоскость ===');
{
  check('на плоскости высота везде ноль', heightAt(FLAT, 13, -47) === 0 && heightAt(FLAT, 0, 0) === 0);
  const slope = slopeAt(FLAT, 20, 20);
  check('на плоскости уклона нет', slope.dx === 0 && slope.dz === 0);
  check(
    'снаряд над плоскостью землю не задевает',
    groundHit(FLAT, 0, 0, SHELL_HEIGHT, 60, 0, 0) === null,
  );

  let flatMaps = 0;
  let settled = 0;
  let firstSeven = 0;
  for (let id = 0; id < MAPS.length; id++) {
    const scene = buildScene(id);
    if (!scene.terrain.flat) continue;
    flatMaps++;
    if (id < ARCADE_MAPS) firstSeven++;
    if (scene.obstacles.every((box) => box.y === 0)) settled++;
    // Тот же отбор укрытий, что был до рельефа: только блоки выше высоты полёта.
    const cover = coverBoxes(scene.obstacles, scene.terrain);
    if (cover.some((box) => box.h < SHELL_HEIGHT)) bad++;
  }
  // Плоские — ровно первые семь: ни одна новая карта не должна оказаться аркадной
  // по недосмотру, и ни одна старая не должна вдруг получить рельеф.
  check(
    'аркадные карты остались плоскими',
    flatMaps === ARCADE_MAPS && firstSeven === ARCADE_MAPS,
    `${flatMaps} карт`,
  );
  check('на плоской карте все блоки стоят на нуле', settled === flatMaps);
}

// --- Выборка поля ---

console.log('\n=== Высотное поле ===');
{
  const last = field.n - 1;
  const node = (i: number) => -MAP_HALF + i * TERRAIN_STEP;
  let worstNode = 0;
  for (let j = 0; j <= last; j += 7) {
    for (let i = 0; i <= last; i += 7) {
      const want = field.d[j * field.n + i] * 0.1;
      worstNode = Math.max(worstNode, Math.abs(heightAt(field, node(i), node(j)) - want));
    }
  }
  check('в узлах выборка даёт записанную высоту', worstNode < 1e-9, `расхождение ${worstNode.toExponential(1)}`);

  // Билинейность: середина ребра — среднее его концов.
  const x0 = -MAP_HALF + 12 * TERRAIN_STEP;
  const z0 = -MAP_HALF + 9 * TERRAIN_STEP;
  const mid = heightAt(field, x0 + TERRAIN_STEP / 2, z0);
  const ends = (heightAt(field, x0, z0) + heightAt(field, x0 + TERRAIN_STEP, z0)) / 2;
  check('между узлами поле линейно', Math.abs(mid - ends) < 1e-9);

  check(
    'за краем поля держится высота его края',
    Math.abs(heightAt(field, MAP_HALF + 40, 5) - heightAt(field, MAP_HALF, 5)) < 1e-9,
  );

  // Уклон должен совпадать с конечной разностью того же поля: иначе танк стоит
  // под одним углом, а едет по другому.
  // Точки берём внутри клеток, а не на их границах: поле склеено из билинейных
  // кусков, и на самом стыке односторонние наклоны честно не совпадают.
  let worstSlope = 0;
  for (const [x, z] of [[3.3, 7.1], [-25.4, 41.9], [49.3, -18.6], [0.5, 0.5]]) {
    const step = 0.05;
    const g = slopeAt(field, x, z);
    const byDiff = {
      dx: (heightAt(field, x + step, z) - heightAt(field, x - step, z)) / (2 * step),
      dz: (heightAt(field, x, z + step) - heightAt(field, x, z - step)) / (2 * step),
    };
    worstSlope = Math.max(worstSlope, Math.abs(g.dx - byDiff.dx), Math.abs(g.dz - byDiff.dz));
  }
  check('уклон совпадает с наклоном самого поля', worstSlope < 1e-6, `расхождение ${worstSlope.toExponential(1)}`);

  // Проезжаемость: стена вместо склона — это не рельеф, а обрыв.
  let steepest = 0;
  for (let j = 0; j < field.n; j++) {
    for (let i = 0; i < field.n; i++) {
      const g = slopeAt(field, -MAP_HALF + i * TERRAIN_STEP, -MAP_HALF + j * TERRAIN_STEP);
      steepest = Math.max(steepest, Math.hypot(g.dx, g.dz));
    }
  }
  check('склоны проезжаемые', steepest < 0.6, `круче всего ${(steepest * 100).toFixed(0)}%`);
}

// --- Детерминизм и сеть ---

console.log('\n=== Одно поле у сервера и клиента ===');
{
  const again = buildTerrain({ seed: 7, amp: 4, feature: 30 }, MAP_HALF);
  check('генератор повторяем', again.d.every((v, i) => v === field.d[i]));
  check('высоты — целые дециметры', field.d.every((v) => Number.isInteger(v)));

  const net = terrainNet(field);
  const back = terrainFrom(net);
  check(
    'поле переживает дорогу до клиента без потерь',
    !back.flat && back.n === field.n && back.d.every((v, i) => v === field.d[i]),
  );
  check('плоскость по сети не едет вовсе', terrainNet(FLAT) === undefined);
  check('мусор вместо поля читается как плоскость', terrainFrom(undefined).flat);
}

// --- Площадки под блоками ---

console.log('\n=== Блоки на рельефе ===');
{
  const pad = buildTerrain({ seed: 3, amp: 4, feature: 26 }, MAP_HALF);
  const boxes: Box[] = [
    { x: 20, z: -14, w: 12, d: 8, h: 4 },
    { x: -38, z: 30, w: 6, d: 6, h: 1.5 },
  ];
  settleBoxes(pad, boxes);

  let worst = 0;
  for (const box of boxes) {
    for (const [dx, dz] of [[0, 0], [0.45, 0.45], [-0.45, 0.45], [0.45, -0.45], [-0.45, -0.45]]) {
      const ground = heightAt(pad, box.x + box.w * dx, box.z + box.d * dz);
      worst = Math.max(worst, Math.abs(ground - (box.y ?? 0)));
    }
  }
  check('земля под блоком выровнена по его основанию', worst < 0.06, `перепад ${worst.toFixed(3)} м`);
  check('основание проставлено', boxes.every((box) => typeof box.y === 'number'));

  // Карта «Холмы» собирается целиком тем же путём, что в бою.
  const hills = buildScene(HILLS);
  check('у «Холмов» есть рельеф', !hills.terrain.flat);
  check('блоки «Холмов» получили основание', hills.obstacles.every((b) => typeof b.y === 'number'));
  check(
    'блоки стоят на своей земле, а не парят',
    hills.obstacles.every((b) => Math.abs(heightAt(hills.terrain, b.x, b.z) - (b.y ?? 0)) < 0.06),
  );
}

// --- Полёт снаряда ---

console.log('\n=== Снаряд и земля ===');
{
  // Одиночный холм: поле строим руками, чтобы проверка не зависела от генератора.
  const n = Math.round((MAP_HALF * 2) / TERRAIN_STEP) + 1;
  const hill: Terrain = { half: MAP_HALF, step: TERRAIN_STEP, n, d: new Array(n * n).fill(0), flat: false };
  for (let j = 0; j < n; j++) {
    const z = -MAP_HALF + j * TERRAIN_STEP;
    // Гребень вдоль X на z = 0: 6 м высотой, склоны по десять метров в обе стороны.
    const h = Math.round(Math.max(0, 6 - Math.abs(z) * 0.6) * 10);
    for (let i = 0; i < n; i++) hill.d[j * n + i] = h;
  }

  const low = ray(0, -40, SHELL_HEIGHT, 0, 80, 0);
  const overHit = groundHit(hill, low.x, low.z, low.y, low.vx, low.vz, low.vy);
  check('гребень останавливает настильный выстрел', overHit !== null);
  if (overHit !== null) {
    const at = low.z + low.vz * overHit;
    const ground = heightAt(hill, low.x, at);
    check(
      'касание найдено на самом склоне, а не за ним',
      Math.abs(SHELL_HEIGHT - ground) < 0.35,
      `на z = ${at.toFixed(1)}, земля ${ground.toFixed(2)} м`,
    );
  }

  const arc = ray(0, -40, SHELL_HEIGHT, 0, 80, 12);
  check('через гребень снаряд с возвышением проходит', groundHit(hill, arc.x, arc.z, arc.y, arc.vx, arc.vz, arc.vy) === null);

  // Тот же гребень глазами полного свипа: земля должна прийти как касание, от
  // которого не рикошетят.
  const wall = sweepShell(ray(0, -40, SHELL_HEIGHT, 0, 80, 0), 1, [], hill);
  check('свип видит землю', wall !== null && wall.ground);

  // Стрелок на гребне бьёт вниз по низине: склонения хватает, склон не мешает.
  const crest = createTankState(0, 0, Math.PI); // корпус и башня смотрят в -Z
  const victim = createTankState(0, -45, 0);
  const drop = Math.max(
    GUN_PITCH_MIN,
    Math.atan2(TANK_HEIGHT / 2 - (heightAt(hill, 0, 0) + SHELL_HEIGHT), 45),
  );
  const down = spawnShell(1, 1, crest, drop, heightAt(hill, crest.x, crest.z));
  const flight = 50 / SHELL_SPEED;
  check('с гребня вниз путь свободен', sweepShell(down, flight, [], hill) === null);
  check('и цель в низине достаётся', sweepTank(down, flight, victim, hill) !== null);

  // Снизу тот же выстрел настильно упирается в склон.
  const foot = createTankState(0, -34, 0); // смотрит в +Z, на гребень
  const up = spawnShell(2, 2, foot, 0, heightAt(hill, foot.x, foot.z));
  check(
    'снизу настильный выстрел упирается в гребень',
    sweepShell(up, 34 / SHELL_SPEED, [], hill) !== null,
  );
}

// --- Высота попадания ---

console.log('\n=== Попадание по высоте ===');
{
  const target = createTankState(0, 30, 0);
  // Настильный выстрел на плоскости: рельефа нет, высота не при чём.
  const level = ray(0, 0, SHELL_HEIGHT, 0, 40, 0);
  check('на плоскости попадание считается как раньше', sweepTank(level, 1, target) !== null);

  const n = Math.round((MAP_HALF * 2) / TERRAIN_STEP) + 1;
  const plain: Terrain = { half: MAP_HALF, step: TERRAIN_STEP, n, d: new Array(n * n).fill(0), flat: false };
  check('на нулевом поле попадание то же', sweepTank(level, 1, target, plain) !== null);

  const over = ray(0, 0, SHELL_HEIGHT + TANK_HEIGHT + 2, 0, 40, 0);
  check('снаряд выше башни проходит мимо', sweepTank(over, 1, target, plain) === null);

  const rising = ray(0, 0, SHELL_HEIGHT, 0, 40, 12);
  check('уходящий вверх снаряд цель не задевает', sweepTank(rising, 1, target, plain) === null);
}

// --- Пределы наводки ---

console.log('\n=== Пределы пушки ===');
{
  check('склонение и возвышение разного знака', GUN_PITCH_MIN < 0 && GUN_PITCH_MAX > 0);
  const rise = Math.tan(GUN_PITCH_MAX) * 100;
  const drop = Math.tan(GUN_PITCH_MIN) * 100;
  check(
    'на сотне метров пушка достаёт разумную высоту',
    rise > 20 && rise < 50 && drop < -10 && drop > -25,
    `+${rise.toFixed(0)} / ${drop.toFixed(0)} м`,
  );

  const flatShot = spawnShell(1, 1, createTankState(0, 0, 0));
  check('без наводки снаряд летит горизонтально', flatShot.vy === 0 && flatShot.y === SHELL_HEIGHT);
  const raised = spawnShell(2, 1, createTankState(0, 0, 0), GUN_PITCH_MAX, 3);
  check('наводка поднимает и ствол, и снаряд', raised.vy > 0 && raised.y > 3 + SHELL_HEIGHT);
  check(
    'горизонтальная скорость при этом почти не теряется',
    Math.hypot(raised.vx, raised.vz) > SHELL_SPEED * 0.94,
  );
}

// --- Размер карты ---

/**
 * Размер перестал быть общей константой и стал свойством карты. Ошибка тут молчит
 * громче всех остальных: с чужим размером танк упирается в невидимую стену, снаряд
 * гаснет в чистом поле, а поле высот кончается там, где карта ещё идёт, — и ни одна
 * из этих бед не пишет ни строчки в лог.
 */
console.log('\n=== Размер карты ===');
{
  const big = MAP_NAMES.indexOf('Долина');
  check('аркадные карты остались 140×140', [...Array(ARCADE_MAPS)].every((_, id) => mapHalf(id) === MAP_HALF));
  check('«Холмы» тоже 140×140', mapHalf(HILLS) === MAP_HALF);
  check('«Долина» и «Промзона» вчетверо больше', mapHalf(big) === 140 && mapHalf(big + 1) === 140);

  // Поле высот строится под размер своей карты, а не под общий.
  const scene = buildScene(big);
  check(
    'поле высот покрывает всю большую карту',
    scene.terrain.half === 140 && scene.terrain.n === (140 * 2) / TERRAIN_STEP + 1,
    `${scene.terrain.n}×${scene.terrain.n} узлов`,
  );
  check(
    'блоки большой карты стоят внутри её стен',
    scene.obstacles.every((b) => Math.abs(b.x) + b.w / 2 <= 140 && Math.abs(b.z) + b.d / 2 <= 140),
  );

  // Стена по периметру: та же точка на маленькой карте за стеной, на большой — нет.
  const drive = (half: number) => {
    const tank = createTankState(0, 100, 0);
    stepTank(tank, { seq: 0, throttle: 0, steer: 0, turret: 0 }, 0.1, [], 1, half);
    return tank.z;
  };
  check('на карте 140×140 стена держит танк на сотне метров', drive(MAP_HALF) < 68);
  check('на карте 280×280 в той же точке чистое поле', drive(140) === 100);

  // Снаряд — тем же порядком: свип упирается в стену своей карты.
  const shot = () => ray(0, 100, SHELL_HEIGHT, 0, 30, 0);
  check('снаряд гаснет о стену маленькой карты', sweepShell(shot(), 1, [], undefined, MAP_HALF) !== null);
  check('и летит дальше на большой', sweepShell(shot(), 1, [], undefined, 140) === null);
}

console.log(bad === 0 ? '\nРельеф сходится' : `\nПроблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
