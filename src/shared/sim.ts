import {
  ACCEL,
  BRAKE,
  BUMP_DAMPING,
  FRICTION,
  MAP_HALF,
  MAX_BOUNCES,
  MAX_REVERSE,
  MAX_SPEED,
  MUZZLE_OFFSET,
  RICOCHET_MAX_COS,
  RICOCHET_SPEED_KEEP,
  SHELL_LIFETIME,
  SHELL_RADIUS,
  SHELL_SPEED,
  TANK_RADIUS,
  TURN_RATE_FULL,
  TURN_RATE_STILL,
  TURRET_RATE,
} from './constants.js';
import type { Box, Input, ShellState, TankState } from './types.js';

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

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
export function stepTank(state: TankState, input: Input, dt: number, obstacles: Box[]): void {
  const throttle = clamp(input.throttle, -1, 1);
  const steer = clamp(input.steer, -1, 1);

  // Продольная динамика: газ против движения тормозит сильнее, чем разгоняет.
  if (throttle !== 0) {
    const braking = state.speed !== 0 && Math.sign(throttle) !== Math.sign(state.speed);
    state.speed += throttle * (braking ? BRAKE : ACCEL) * dt;
  } else {
    const drop = FRICTION * dt;
    state.speed = Math.abs(state.speed) <= drop ? 0 : state.speed - Math.sign(state.speed) * drop;
  }
  state.speed = clamp(state.speed, -MAX_REVERSE, MAX_SPEED);

  // Поворот корпуса: на месте вертится бодро, на скорости — вяло.
  const speedFrac = Math.min(Math.abs(state.speed) / MAX_SPEED, 1);
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

  resolveObstacles(state, obstacles);
  resolveBounds(state);
}

function resolveBounds(state: TankState): void {
  const limit = MAP_HALF - TANK_RADIUS;
  const cx = clamp(state.x, -limit, limit);
  const cz = clamp(state.z, -limit, limit);
  if (cx !== state.x || cz !== state.z) {
    state.x = cx;
    state.z = cz;
    state.speed *= BUMP_DAMPING;
  }
}

/** Выталкивание круга танка из прямоугольных препятствий. */
function resolveObstacles(state: TankState, obstacles: Box[]): void {
  for (const box of obstacles) {
    const hw = box.w / 2;
    const hd = box.d / 2;

    // Ближайшая к центру танка точка прямоугольника.
    const nearestX = clamp(state.x, box.x - hw, box.x + hw);
    const nearestZ = clamp(state.z, box.z - hd, box.z + hd);

    let dx = state.x - nearestX;
    let dz = state.z - nearestZ;
    const dist2 = dx * dx + dz * dz;
    if (dist2 >= TANK_RADIUS * TANK_RADIUS) continue;

    if (dist2 > 1e-8) {
      const dist = Math.sqrt(dist2);
      const push = (TANK_RADIUS - dist) / dist;
      state.x += dx * push;
      state.z += dz * push;
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
    }
    state.speed *= BUMP_DAMPING;
  }
}

// --- Снаряды ---

/** Снаряд, вылетающий из башни танка. Скорость танка не добавляется — так проще целиться. */
export function spawnShell(id: number, owner: number, state: TankState): ShellState {
  const a = state.turret;
  return {
    id,
    owner,
    x: state.x + Math.sin(a) * MUZZLE_OFFSET,
    z: state.z + Math.cos(a) * MUZZLE_OFFSET,
    vx: Math.sin(a) * SHELL_SPEED,
    vz: Math.cos(a) * SHELL_SPEED,
    life: SHELL_LIFETIME,
    bounces: 0,
  };
}

/** Один шаг снаряда по свободному участку: прямая, без гравитации. */
export function stepShell(shell: ShellState, dt: number): void {
  shell.x += shell.vx * dt;
  shell.z += shell.vz * dt;
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
}

/**
 * Ближайшее препятствие или стена карты на пути снаряда за время dt; null — путь свободен.
 *
 * Прямоугольники раздуты на радиус снаряда, поэтому сам снаряд считается точкой,
 * и задача сводится к пересечению отрезка с AABB методом слэбов. Заодно это
 * избавляет от подшагов: касание находится точно, сквозь тонкий блок не проскочить.
 */
export function sweepShell(shell: ShellState, dt: number, obstacles: Box[]): ShellHit | null {
  const dx = shell.vx * dt;
  const dz = shell.vz * dt;

  let best = sweepBounds(shell.x, shell.z, dx, dz);
  for (const box of obstacles) {
    const hit = sweepBox(shell.x, shell.z, dx, dz, box);
    if (hit && (best === null || hit.t < best.t)) best = hit;
  }
  return best;
}

/** Раздутый прямоугольник препятствия. */
function sweepBox(px: number, pz: number, dx: number, dz: number, box: Box): ShellHit | null {
  const hw = box.w / 2 + SHELL_RADIUS;
  const hd = box.d / 2 + SHELL_RADIUS;

  const sx = slab(px, dx, box.x - hw, box.x + hw);
  if (sx === null) return null;
  const sz = slab(pz, dz, box.z - hd, box.z + hd);
  if (sz === null) return null;

  const enter = Math.max(sx.enter, sz.enter);
  const exit = Math.min(sx.exit, sz.exit);
  if (enter > exit || exit < 0 || enter > 1) return null;

  // Танк может прижаться к стене вплотную, и тогда снаряд рождается уже внутри блока.
  if (enter < 0) return { t: 0, nx: 0, nz: 0, stuck: true };

  // В прямоугольник входят по той оси, в чей слэб попали последней.
  return sx.enter > sz.enter ? faceHit(enter, dx, true) : faceHit(enter, dz, false);
}

/** Стена по периметру карты: снаряд летит внутри квадрата и упирается в него изнутри. */
function sweepBounds(px: number, pz: number, dx: number, dz: number): ShellHit | null {
  const limit = MAP_HALF - SHELL_RADIUS;
  if (Math.abs(px) > limit || Math.abs(pz) > limit) return { t: 0, nx: 0, nz: 0, stuck: true };

  const tx = dx === 0 ? Infinity : ((dx > 0 ? limit : -limit) - px) / dx;
  const tz = dz === 0 ? Infinity : ((dz > 0 ? limit : -limit) - pz) / dz;
  if (Math.min(tx, tz) > 1) return null;

  return tx < tz ? faceHit(Math.max(tx, 0), dx, true) : faceHit(Math.max(tz, 0), dz, false);
}

/** Нормаль всегда смотрит навстречу снаряду. */
function faceHit(t: number, d: number, alongX: boolean): ShellHit {
  const n = d > 0 ? -1 : 1;
  return { t, nx: alongX ? n : 0, nz: alongX ? 0 : n, stuck: false };
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
 */
export function sweepTank(shell: ShellState, dt: number, tank: TankState): number | null {
  const dx = shell.vx * dt;
  const dz = shell.vz * dt;
  const px = shell.x - tank.x;
  const pz = shell.z - tank.z;
  const r = TANK_RADIUS + SHELL_RADIUS;

  const a = dx * dx + dz * dz;
  if (a < 1e-12) return null;

  const c = px * px + pz * pz - r * r;
  if (c <= 0) return 0; // снаряд уже внутри круга

  const b = 2 * (px * dx + pz * dz);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : null;
}

/** Достаточно ли полого снаряд задел грань, чтобы отскочить, а не взорваться. */
export function canRicochet(shell: ShellState, hit: ShellHit): boolean {
  if (hit.stuck || shell.bounces >= MAX_BOUNCES) return false;

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

/**
 * Расталкивание танков между собой. Вызывается только на сервере, после того как
 * все танки сделали свой шаг, — это глобальная фаза, а не часть stepTank.
 */
export function resolveTankCollisions(tanks: TankState[]): void {
  const minDist = TANK_RADIUS * 2;
  for (let i = 0; i < tanks.length; i++) {
    for (let j = i + 1; j < tanks.length; j++) {
      const a = tanks[i];
      const b = tanks[j];
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      let dist2 = dx * dx + dz * dz;
      if (dist2 >= minDist * minDist) continue;

      let dist = Math.sqrt(dist2);
      if (dist < 1e-6) {
        // Идеально совпали — разводим по произвольной оси.
        dx = 1;
        dz = 0;
        dist = 1;
      }
      const overlap = (minDist - dist) / 2;
      const nx = (dx / dist) * overlap;
      const nz = (dz / dist) * overlap;
      a.x -= nx;
      a.z -= nz;
      b.x += nx;
      b.z += nz;
      a.speed *= 0.6;
      b.speed *= 0.6;
    }
  }
}
