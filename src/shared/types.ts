/** Прямоугольное препятствие, выровненное по осям (вид сверху) + высота. */
export interface Box {
  x: number;
  z: number;
  w: number; // размер по X
  d: number; // размер по Z
  h: number; // высота над собственным основанием
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
  /** id стрелявшего: пока снаряд не срикошетил, в своего не попадаем. */
  owner: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Остаток жизни в секундах. */
  life: number;
  /** Сколько раз уже отскочил. */
  bounces: number;
  /**
   * Урон, с которым снаряд вышел из ствола. Фиксируется на выстреле: пока он летит,
   * стрелок может погибнуть, выйти из игры или потерять бонус на урон — на уже
   * выпущенный снаряд это не влияет. У пробных лучей поля нет.
   */
  dmg?: number;
}

/** Что показать в месте попадания. */
export const BOOM_GROUND = 0; // снаряд разбился о препятствие или стену
export const BOOM_HIT = 1; // попадание в танк
export const BOOM_KILL = 2; // танк уничтожен
export const BOOM_RICOCHET = 3; // снаряд чиркнул по стене и полетел дальше
export const BOOM_NEAR = 4; // снаряд прошёл рядом с танком, не задев — подавление
export type BoomKind =
  | typeof BOOM_GROUND
  | typeof BOOM_HIT
  | typeof BOOM_KILL
  | typeof BOOM_RICOCHET
  | typeof BOOM_NEAR;

/** Событие взрыва за тик (короткие ключи — трафик). */
export interface Boom {
  x: number;
  z: number;
  k: BoomKind;
  /** id стрелявшего — по нему клиент рисует себе отметку о попадании. */
  o: number;
}

/** Команды. Огонь по своим включён, так что команда — это только «за кого играешь». */
export const TEAM_PLAYERS = 0;
export const TEAM_BOTS = 1;

export interface PlayerInfo {
  id: number;
  name: string;
  /** Индекс цвета в палитре клиента. */
  color: number;
  team: number;
  /** Есть только у ботов — клиент по нему подписывает танк иначе. */
  bot?: 1;
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
  /** Маска активных бонусов; шлём, только когда она не пуста. */
  f?: number;
  /** Монотонный счётчик подтверждённых выстрелов; нужен владельцу для отдачи. */
  q?: number;
}

/** Ящик с бонусом на карте. */
export interface BonusState {
  id: number;
  kind: number;
  x: number;
  z: number;
  /** Тик, на котором неподобранный ящик исчезнет. */
  until: number;
}

/** Ящик в снапшоте. */
export interface SnapshotBonus {
  i: number; // id
  k: number; // вид
  x: number;
  z: number;
}

/** Снаряд в снапшоте. Угол нужен клиенту для разворота меша и меняется на отскоках. */
export interface SnapshotShell {
  i: number; // id
  o: number; // owner
  x: number;
  z: number;
  a: number; // направление полёта
  /** Счётчик отскоков: по его изменению клиент понимает, что интерполировать нельзя. */
  b: number;
}

export function createTankState(x = 0, z = 0, angle = 0): TankState {
  return { x, z, angle, speed: 0, turret: angle };
}
