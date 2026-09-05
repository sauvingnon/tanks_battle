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
}

export function createTankState(x = 0, z = 0, angle = 0): TankState {
  return { x, z, angle, speed: 0, turret: angle };
}
