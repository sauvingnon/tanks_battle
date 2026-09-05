/** Прямоугольное препятствие, выровненное по осям (вид сверху) + высота для отрисовки. */
export interface Box {
  x: number;
  z: number;
  w: number; // размер по X
  d: number; // размер по Z
  h: number; // высота (только для рендера)
}

/** Полное состояние танка в симуляции. */
export interface TankState {
  x: number;
  z: number;
  /** Угол корпуса. 0 = направление +Z, растёт против часовой стрелки. */
  angle: number;
  /** Текущая скорость вдоль корпуса, м/с (может быть отрицательной). */
  speed: number;
  /** Мировой угол башни. */
  turret: number;
}

/** То, что клиент отправляет серверу каждый тик. */
export interface Input {
  seq: number;
  /** -1..1, газ вперёд/назад. */
  throttle: number;
  /** -1..1, поворот корпуса. +1 = влево. */
  steer: number;
  /** Желаемый мировой угол башни (куда смотрит камера). */
  turret: number;
  /** Нажат ли огонь в этот тик. Выстрел — не часть stepTank: он рождает сущность. */
  fire?: boolean;
}

/** Снаряд в полёте. Живёт только на сервере, клиенту приходит уже в снапшоте. */
export interface ShellState {
  id: number;
  /** id стрелявшего: в своего не попадаем. */
  owner: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Остаток жизни в секундах. */
  life: number;
}

/** Что показать в месте попадания. */
export const BOOM_GROUND = 0; // снаряд разбился о препятствие, стену или землю
export const BOOM_HIT = 1; // попадание в танк
export const BOOM_KILL = 2; // танк уничтожен
export type BoomKind = typeof BOOM_GROUND | typeof BOOM_HIT | typeof BOOM_KILL;

/** Событие взрыва за тик (короткие ключи — трафик). */
export interface Boom {
  x: number;
  z: number;
  k: BoomKind;
  /** id стрелявшего — по нему клиент рисует себе отметку о попадании. */
  o: number;
}

export interface PlayerInfo {
  id: number;
  name: string;
  /** Индекс цвета в палитре клиента. */
  color: number;
}

/** Состояние игрока внутри снапшота (короткие ключи — трафик). */
export interface SnapshotEntry {
  i: number; // id
  x: number;
  z: number;
  a: number; // angle
  t: number; // turret
  s: number; // speed
  h: number; // hp
  d: 0 | 1; // уничтожен
}

/** Снаряд в снапшоте. Угол постоянный, но нужен клиенту для разворота меша. */
export interface SnapshotShell {
  i: number; // id
  o: number; // owner
  x: number;
  z: number;
  a: number; // направление полёта
}

export function createTankState(x = 0, z = 0, angle = 0): TankState {
  return { x, z, angle, speed: 0, turret: angle };
}
