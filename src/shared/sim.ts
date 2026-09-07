import {
  ACCEL,
  BRAKE,
  BUMP_DECEL,
  BUMP_GRAZE,
  clamp,
  FRICTION,
  MAP_HALF,
  MAX_BOUNCES,
  MAX_REVERSE,
  MAX_SPEED,
  MUZZLE_OFFSET,
  RAM_DAMAGE,
  RAM_FULL_SPEED,
  RAM_MIN_SPEED,
  RAM_SELF_SHARE,
  RICOCHET_MAX_COS,
  RICOCHET_SPEED_KEEP,
  SHELL_HEIGHT,
  SHELL_LIFETIME,
  SHELL_RADIUS,
  SHELL_SPEED,
  TANK_HEIGHT,
  TANK_RADIUS,
  TURN_RATE_FULL,
  TURN_RATE_STILL,
  TURRET_RATE,
} from './constants.js';
import { groundHit, heightAt, type Terrain } from './terrain.js';
import type { Box, Input, ShellState, TankState } from './types.js';

// Живёт в constants.ts, чтобы рельеф мог им пользоваться, не замыкая импорты
// на симуляцию. Половина проекта берёт clamp отсюда, поэтому здесь он и остаётся.
export { clamp };

/** Приводит угол к диапазону (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/** Кратчайшая угловая разница from -> to. */
export function angleDiff(from: number, to: number): number {
  return wrapAngle(to - from);
}

export function lerpAngle(from: number, to: number, t: number): number {
  return wrapAngle(from + angleDiff(from, to) * t);
}

/**
 * Один шаг симуляции одного танка. Мутирует state.
 *
 * Это единственное место, где описано движение: сервер вызывает её как источник
 * истины, клиент — для предсказания собственного танка. Функция детерминирована,
 * поэтому при одинаковых input/dt результат совпадает.
 */
export function stepTank(
  state: TankState,
  input: Input,
  dt: number,
  obstacles: Box[],
  /** Множитель хода от бонуса «Ход». Клиент обязан подставлять то же, что и сервер. */
  boost = 1,
): void {
  const throttle = clamp(input.throttle, -1, 1);
  const steer = clamp(input.steer, -1, 1);
  const maxSpeed = MAX_SPEED * boost;

  // Продольная динамика: газ против движения тормозит сильнее, чем разгоняет.
  if (throttle !== 0) {
    const braking = state.speed !== 0 && Math.sign(throttle) !== Math.sign(state.speed);
    state.speed += throttle * (braking ? BRAKE : ACCEL * boost) * dt;
  } else {
    const drop = FRICTION * dt;
    state.speed = Math.abs(state.speed) <= drop ? 0 : state.speed - Math.sign(state.speed) * drop;
  }
  state.speed = clamp(state.speed, -MAX_REVERSE * boost, maxSpeed);

  // Поворот корпуса: на месте вертится бодро, на скорости — вяло.
  const speedFrac = Math.min(Math.abs(state.speed) / maxSpeed, 1);
  const turnRate = TURN_RATE_STILL + (TURN_RATE_FULL - TURN_RATE_STILL) * speedFrac;
  state.angle = wrapAngle(state.angle + steer * turnRate * dt);

  // Перемещение. Угол 0 смотрит в +Z, что совпадает с rotation.y в three.js.
  state.x += Math.sin(state.angle) * state.speed * dt;
  state.z += Math.cos(state.angle) * state.speed * dt;

  // Башня доворачивается к прицелу с ограниченной скоростью.
  const maxTurn = TURRET_RATE * dt;
  state.turret = wrapAngle(
    state.turret + clamp(angleDiff(state.turret, input.turret), -maxTurn, maxTurn),
  );

  // Оба выталкивания копят «насколько удар лобовой» и тормозят один раз: у стены
  // из блоков танк касается сразу двух прямоугольников, и торможение за каждый
  // отдельно останавливало бы вдвое резче, чем у такой же сплошной стены.
  const hit = Math.max(resolveObstacles(state, obstacles), resolveBounds(state));
  if (hit > 0) scrape(state, hit, dt);
}

/**
 * Насколько контакт лобовой, 0..1: проекция курса на нормаль задетой грани.
 * 1 — едем точно в стену, 0 — вдоль неё. Танк движется только по своему курсу,
 * поэтому этого одного числа хватает, чтобы отличить удар от скольжения.
 */
function headOn(state: TankState, nx: number, nz: number): number {
  if (state.speed === 0) return 0;
  const into = -Math.sign(state.speed) * (Math.sin(state.angle) * nx + Math.cos(state.angle) * nz);
  return clamp(into, 0, 1);
}

/**
 * Торможение о грань. До BUMP_GRAZE стена не стоит ничего — там танк просто
 * скользит вдоль неё выталкиванием, — а дальше сопротивление растёт квадратом и
 * упор в лоб гасит ход почти мгновенно.
 *
 * Порог, а не плавная кривая, потому что мотор даёт всего ACCEL: любое
 * торможение сильнее него — это уже полная остановка, а не «медленнее». Без
 * порога полоса «едет, но вяло» получалась шириной градусов в пять, и всё, что
 * круче, вставало намертво.
 */
function scrape(state: TankState, frac: number, dt: number): void {
  const over = (frac - BUMP_GRAZE) / (1 - BUMP_GRAZE);
  if (over <= 0) return;
  const drop = BUMP_DECEL * over * over * dt;
  state.speed = Math.abs(state.speed) <= drop ? 0 : state.speed - Math.sign(state.speed) * drop;
}

/** Стена по периметру карты. Возвращает, насколько удар лобовой; 0 — контакта нет. */
function resolveBounds(state: TankState): number {
  const limit = MAP_HALF - TANK_RADIUS;
  const cx = clamp(state.x, -limit, limit);
  const cz = clamp(state.z, -limit, limit);
  if (cx === state.x && cz === state.z) return 0;

  // Нормаль смотрит внутрь карты: в угол упираются сразу по двум осям.
  let nx = cx - state.x;
  let nz = cz - state.z;
  const len = Math.hypot(nx, nz) || 1;
  nx /= len;
  nz /= len;

  state.x = cx;
  state.z = cz;
  return headOn(state, nx, nz);
}

/** Выталкивание круга танка из прямоугольных препятствий; результат — как у resolveBounds. */
function resolveObstacles(state: TankState, obstacles: Box[]): number {
  let worst = 0;
  for (const box of obstacles) {
    const hw = box.w / 2;
    const hd = box.d / 2;

    // Ближайшая к центру танка точка прямоугольника.
    const nearestX = clamp(state.x, box.x - hw, box.x + hw);
    const nearestZ = clamp(state.z, box.z - hd, box.z + hd);

    const dx = state.x - nearestX;
    const dz = state.z - nearestZ;
    const dist2 = dx * dx + dz * dz;
    if (dist2 >= TANK_RADIUS * TANK_RADIUS) continue;

    if (dist2 > 1e-8) {
      const dist = Math.sqrt(dist2);
      const push = (TANK_RADIUS - dist) / dist;
      state.x += dx * push;
      state.z += dz * push;
      worst = Math.max(worst, headOn(state, dx / dist, dz / dist));
    } else {
      // Центр танка внутри прямоугольника — выталкиваем через ближайшую грань.
      const toLeft = state.x - (box.x - hw);
      const toRight = box.x + hw - state.x;
      const toBack = state.z - (box.z - hd);
      const toFront = box.z + hd - state.z;
      const min = Math.min(toLeft, toRight, toBack, toFront);
      if (min === toLeft) state.x = box.x - hw - TANK_RADIUS;
      else if (min === toRight) state.x = box.x + hw + TANK_RADIUS;
      else if (min === toBack) state.z = box.z - hd - TANK_RADIUS;
      else state.z = box.z + hd + TANK_RADIUS;
      // Танк сидел внутри блока: это всегда упор, а не касание.
      worst = 1;
    }
  }
  return worst;
}

// --- Снаряды ---

/**
 * Снаряд, вылетающий из башни танка. Скорость танка не добавляется — так проще целиться.
 *
 * pitch — вертикальная наводка, рад: вверх положительная. На аркадных картах она
 * всегда ноль, и тогда всё это в точности прежний горизонтальный выстрел.
 * ground — высота земли под танком: снаряд летит на SHELL_HEIGHT над ней.
 */
export function spawnShell(
  id: number,
  owner: number,
  state: TankState,
  pitch = 0,
  ground = 0,
): ShellState {
  const a = state.turret;
  const flat = Math.cos(pitch);
  const rise = Math.sin(pitch);
  return {
    id,
    owner,
    x: state.x + Math.sin(a) * MUZZLE_OFFSET * flat,
    z: state.z + Math.cos(a) * MUZZLE_OFFSET * flat,
    y: ground + SHELL_HEIGHT + rise * MUZZLE_OFFSET,
    vx: Math.sin(a) * SHELL_SPEED * flat,
    vz: Math.cos(a) * SHELL_SPEED * flat,
    vy: rise * SHELL_SPEED,
    life: SHELL_LIFETIME,
    bounces: 0,
  };
}

/**
 * Один шаг снаряда по свободному участку: прямая, без гравитации.
 *
 * Гравитации не будет и дальше. При 62 м/с снаряд на двухстах метрах падал бы на
 * полсотни: честная баллистика требует поднять скорость до реальных, а тогда
 * исчезает упреждение — то, на чём держится вся стрельба по движущимся. Высоту и
 * вертикальную наводку рельеф требует, падение снаряда — нет.
 */
export function stepShell(shell: ShellState, dt: number): void {
  shell.x += shell.vx * dt;
  shell.z += shell.vz * dt;
  shell.y += shell.vy * dt;
  shell.life -= dt;
}

/** Касание снаряда с геометрией карты на отрезке одного шага. */
export interface ShellHit {
  /** Доля шага до касания, 0..1. */
  t: number;
  /** Нормаль задетой грани: одна компонента ±1, другая 0. */
  nx: number;
  nz: number;
  /** Снаряд начал шаг внутри геометрии — отражать не от чего, только взрыв. */
  stuck: boolean;
  /**
   * Задета земля или крыша блока, а не боковая грань. Рикошета отсюда нет: все
   * вертикальные грани на карте выровнены по осям, и отскок от них считается
   * точно, а склон — поверхность произвольного наклона, от которой честно
   * отражать нечем. Снаряд, воткнувшийся в землю, взрывается.
   */
  ground: boolean;
}

/**
 * Ближайшее препятствие, земля или стена карты на пути снаряда за время dt;
 * null — путь свободен.
 *
 * Прямоугольники раздуты на радиус снаряда, поэтому сам снаряд считается точкой,
 * и задача сводится к пересечению отрезка с AABB методом слэбов. Заодно это
 * избавляет от подшагов: касание находится точно, сквозь тонкий блок не проскочить.
 *
 * terrain задаёт, считать ли высоту. Без него свип двумерный, ровно как был: на
 * аркадных картах снаряд идёт на постоянной высоте, все укрытия выше неё, и
 * лишняя ось стоила бы работы, не меняя ни одного ответа. С рельефом добавляются
 * третий слэб у блоков (можно перелететь через крышу) и марш по земле.
 */
export function sweepShell(
  shell: ShellState,
  dt: number,
  obstacles: Box[],
  terrain?: Terrain,
): ShellHit | null {
  const dx = shell.vx * dt;
  const dz = shell.vz * dt;
  const dy = shell.vy * dt;

  let best = sweepBounds(shell.x, shell.z, dx, dz);
  for (const box of obstacles) {
    const hit = sweepBox(shell.x, shell.z, shell.y, dx, dz, dy, box, terrain !== undefined);
    if (hit && (best === null || hit.t < best.t)) best = hit;
  }

  if (terrain) {
    const t = groundHit(terrain, shell.x, shell.z, shell.y, dx, dz, dy);
    if (t !== null && (best === null || t < best.t)) {
      best = { t, nx: 0, nz: 0, stuck: t === 0, ground: true };
    }
  }
  return best;
}

/**
 * Раздутый прямоугольник препятствия. vertical включает третий слэб по высоте:
 * блок стоит на своём основании box.y и кончается на box.y + box.h, и снаряд с
 * вертикальной наводкой может пройти над ним.
 */
function sweepBox(
  px: number,
  pz: number,
  py: number,
  dx: number,
  dz: number,
  dy: number,
  box: Box,
  vertical: boolean,
): ShellHit | null {
  const hw = box.w / 2 + SHELL_RADIUS;
  const hd = box.d / 2 + SHELL_RADIUS;

  const sx = slab(px, dx, box.x - hw, box.x + hw);
  if (sx === null) return null;
  const sz = slab(pz, dz, box.z - hd, box.z + hd);
  if (sz === null) return null;

  let enter = Math.max(sx.enter, sz.enter);
  let exit = Math.min(sx.exit, sz.exit);
  let roof = false;

  if (vertical) {
    const base = box.y ?? 0;
    const sy = slab(py, dy, base - SHELL_RADIUS, base + box.h + SHELL_RADIUS);
    if (sy === null) return null;
    roof = sy.enter > enter;
    enter = Math.max(enter, sy.enter);
    exit = Math.min(exit, sy.exit);
  }

  if (enter > exit || exit < 0 || enter > 1) return null;

  // Танк может прижаться к стене вплотную, и тогда снаряд рождается уже внутри блока.
  if (enter < 0) return { t: 0, nx: 0, nz: 0, stuck: true, ground: false };

  // Вошли по той оси, в чей слэб попали последней. Крыша — та же земля: от неё
  // не рикошетят, потому что снаряд пришёл в неё сверху и почти отвесно.
  if (roof) return { t: enter, nx: 0, nz: 0, stuck: false, ground: true };
  return sx.enter > sz.enter ? faceHit(enter, dx, true) : faceHit(enter, dz, false);
}

/** Стена по периметру карты: снаряд летит внутри квадрата и упирается в него изнутри. */
function sweepBounds(px: number, pz: number, dx: number, dz: number): ShellHit | null {
  const limit = MAP_HALF - SHELL_RADIUS;
  if (Math.abs(px) > limit || Math.abs(pz) > limit) {
    return { t: 0, nx: 0, nz: 0, stuck: true, ground: false };
  }

  const tx = dx === 0 ? Infinity : ((dx > 0 ? limit : -limit) - px) / dx;
  const tz = dz === 0 ? Infinity : ((dz > 0 ? limit : -limit) - pz) / dz;
  if (Math.min(tx, tz) > 1) return null;

  return tx < tz ? faceHit(Math.max(tx, 0), dx, true) : faceHit(Math.max(tz, 0), dz, false);
}

/** Нормаль всегда смотрит навстречу снаряду. */
function faceHit(t: number, d: number, alongX: boolean): ShellHit {
  const n = d > 0 ? -1 : 1;
  return { t, nx: alongX ? n : 0, nz: alongX ? 0 : n, stuck: false, ground: false };
}

/** Пересечение луча с полосой [min, max] по одной оси; null — луч идёт мимо полосы. */
function slab(
  p: number,
  d: number,
  min: number,
  max: number,
): { enter: number; exit: number } | null {
  if (Math.abs(d) < 1e-9) {
    // По этой оси движения нет: либо мы всё время внутри полосы, либо всё время вне.
    return p < min || p > max ? null : { enter: -Infinity, exit: Infinity };
  }
  const t1 = (min - p) / d;
  const t2 = (max - p) / d;
  return t1 < t2 ? { enter: t1, exit: t2 } : { enter: t2, exit: t1 };
}

/**
 * Доля шага до попадания в танк, или null. Танк — круг, снаряд — точка с радиусом,
 * то есть это пересечение отрезка с окружностью суммарного радиуса.
 *
 * С рельефом круг становится цилиндром высотой TANK_HEIGHT, стоящим на своей
 * земле: снаряд с вертикальной наводкой проходит над целью или бьёт в склон
 * перед ней. Без terrain — прежняя двумерная задача, где высота одна на всех.
 */
export function sweepTank(
  shell: ShellState,
  dt: number,
  tank: TankState,
  terrain?: Terrain,
): number | null {
  const dx = shell.vx * dt;
  const dz = shell.vz * dt;
  const px = shell.x - tank.x;
  const pz = shell.z - tank.z;
  const r = TANK_RADIUS + SHELL_RADIUS;

  const a = dx * dx + dz * dz;
  if (a < 1e-12) return null;

  const c = px * px + pz * pz - r * r;
  const b = 2 * (px * dx + pz * dz);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const root = Math.sqrt(disc);
  // Снаряд уже внутри круга — считаем, что он был там с начала отрезка.
  let from = c <= 0 ? 0 : (-b - root) / (2 * a);
  const till = (-b + root) / (2 * a);
  if (till < 0 || from > 1) return null;
  from = Math.max(from, 0);

  if (!terrain) return from;

  // Высотный слэб цилиндра. Земля берётся под центром танка: наклон корпуса на
  // склоне меняет силуэт на десяток сантиметров, а стоит выборки в каждом свипе.
  const base = heightAt(terrain, tank.x, tank.z);
  const sy = slab(shell.y, shell.vy * dt, base - SHELL_RADIUS, base + TANK_HEIGHT + SHELL_RADIUS);
  if (sy === null) return null;

  const enter = Math.max(from, sy.enter);
  const exit = Math.min(till, sy.exit);
  if (enter > exit || enter > 1) return null;
  return Math.max(enter, 0);
}

/** Достаточно ли полого снаряд задел грань, чтобы отскочить, а не взорваться. */
export function canRicochet(shell: ShellState, hit: ShellHit): boolean {
  if (hit.stuck || hit.ground || shell.bounces >= MAX_BOUNCES) return false;

  const speed = Math.hypot(shell.vx, shell.vz);
  if (speed < 1e-6) return false;

  const cos = Math.abs(shell.vx * hit.nx + shell.vz * hit.nz) / speed;
  return cos < RICOCHET_MAX_COS;
}

/** Отражает снаряд от грани и гасит часть скорости. Мутирует shell. */
export function bounceShell(shell: ShellState, hit: ShellHit): void {
  if (hit.nx !== 0) shell.vx = -shell.vx;
  else shell.vz = -shell.vz;

  shell.vx *= RICOCHET_SPEED_KEEP;
  shell.vz *= RICOCHET_SPEED_KEEP;
  shell.bounces++;

  // Отодвигаем от грани, иначе следующий свип найдёт то же самое касание в t = 0.
  shell.x += hit.nx * SURFACE_EPS;
  shell.z += hit.nz * SURFACE_EPS;
}

/** Зазор, на который снаряд отодвигается от стены после отскока. */
const SURFACE_EPS = 1e-3;

/** Столкновение двух танков, в котором кто-то разогнался: индексы во входном массиве. */
export interface RamHit {
  a: number;
  b: number;
  /** Скорость сближения по нормали удара, м/с. */
  closing: number;
  /** Урон каждому. Наезжающий получает меньше, но не ноль. */
  damageA: number;
  damageB: number;
}

/**
 * Расталкивание танков между собой и разбор тарана. Вызывается только на сервере,
 * после того как все танки сделали свой шаг, — это глобальная фаза, а не часть
 * stepTank. Возвращает столкновения, в которых была скорость: кому и сколько
 * стоил удар, решает комната — здесь только физика.
 */
export function resolveTankCollisions(tanks: TankState[], dt: number): RamHit[] {
  const minDist = TANK_RADIUS * 2;
  const hits: RamHit[] = [];

  for (let i = 0; i < tanks.length; i++) {
    for (let j = i + 1; j < tanks.length; j++) {
      const a = tanks[i];
      const b = tanks[j];
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      const dist2 = dx * dx + dz * dz;
      if (dist2 >= minDist * minDist) continue;

      let dist = Math.sqrt(dist2);
      if (dist < 1e-6) {
        // Идеально совпали — разводим по произвольной оси.
        dx = 1;
        dz = 0;
        dist = 1;
      }
      // Нормаль удара: от a к b.
      const nx = dx / dist;
      const nz = dz / dist;

      const overlap = (minDist - dist) / 2;
      a.x -= nx * overlap;
      a.z -= nz * overlap;
      b.x += nx * overlap;
      b.z += nz * overlap;

      // Кто сколько привнёс в сближение. Отрицательное значит «уже уезжает» —
      // такой танк в столкновении не виноват и в долю вины не идёт.
      const intoA = Math.max(0, a.speed * (Math.sin(a.angle) * nx + Math.cos(a.angle) * nz));
      const intoB = Math.max(0, -b.speed * (Math.sin(b.angle) * nx + Math.cos(b.angle) * nz));

      // Борт о борт танки трутся весь бой, поэтому тормозим их тем же правилом,
      // что и о стену: удар в лоб гасит ход, касание по касательной — почти нет.
      scrape(a, Math.min(1, intoA / (Math.abs(a.speed) || 1)), dt);
      scrape(b, Math.min(1, intoB / (Math.abs(b.speed) || 1)), dt);

      const closing = intoA + intoB;
      if (closing <= RAM_MIN_SPEED) continue;

      const total =
        RAM_DAMAGE *
        clamp((closing - RAM_MIN_SPEED) / (RAM_FULL_SPEED - RAM_MIN_SPEED), 0, 1);
      // Доля вины: наехал ты — платишь только RAM_SELF_SHARE, наехали на тебя —
      // полную цену. В лобовом сближении вина пополам, и достаётся обоим поровну.
      const blameA = intoA / closing;
      hits.push({
        a: i,
        b: j,
        closing,
        damageA: total * (RAM_SELF_SHARE + (1 - RAM_SELF_SHARE) * (1 - blameA)),
        damageB: total * (RAM_SELF_SHARE + (1 - RAM_SELF_SHARE) * blameA),
      });
    }
  }
  return hits;
}
