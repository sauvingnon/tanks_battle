import {
  ACCEL,
  BRAKE,
  BUMP_DAMPING,
  FRICTION,
  MAP_HALF,
  MAX_REVERSE,
  MAX_SPEED,
  MUZZLE_OFFSET,
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
  };
}

/** Один шаг снаряда: прямая, без гравитации. */
export function stepShell(shell: ShellState, dt: number): void {
  shell.x += shell.vx * dt;
  shell.z += shell.vz * dt;
  shell.life -= dt;
}

/** Снаряд задел прямоугольник (вид сверху; все препятствия выше траектории). */
export function shellHitsBox(shell: ShellState, box: Box): boolean {
  return (
    Math.abs(shell.x - box.x) <= box.w / 2 + SHELL_RADIUS &&
    Math.abs(shell.z - box.z) <= box.d / 2 + SHELL_RADIUS
  );
}

/** Снаряд задел корпус танка. */
export function shellHitsTank(shell: ShellState, tank: TankState): boolean {
  const dx = tank.x - shell.x;
  const dz = tank.z - shell.z;
  const r = TANK_RADIUS + SHELL_RADIUS;
  return dx * dx + dz * dz <= r * r;
}

/** Снаряд дошёл до стены по периметру карты. */
export function shellOutOfMap(shell: ShellState): boolean {
  const limit = MAP_HALF - SHELL_RADIUS;
  return Math.abs(shell.x) >= limit || Math.abs(shell.z) >= limit;
}

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
