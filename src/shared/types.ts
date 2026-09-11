/** Препятствие карты, обычно прямоугольное, с высотой над землёй. */
export interface Box {
  x: number;
  z: number;
  w: number; // размер по X
  d: number; // размер по Z
  /** Размер физического основания по X; если не задан, совпадает с w. */
  collisionW?: number;
  /** Размер физического основания по Z; если не задан, совпадает с d. */
  collisionD?: number;
  /** Круглая коллизия вокруг центра; используется для стволов деревьев. */
  collisionRadius?: number;
  /** Радиус танка для этой коллизии; нужен объектам с более точным силуэтом. */
  collisionTankRadius?: number;
  /** Выпуклый контур основания в локальных координатах относительно x/z. */
  collisionPolygon?: Array<[number, number]>;
  h: number; // высота над собственным основанием
  /** Высота основания для чисто визуальных деталей (по умолчанию 0). */
  y?: number;
  /** false — деталь рисуется, но не участвует в физике. */
  solid?: boolean;
  /** Визуальный материал для деталей карты; solid=false означает отсутствие физики. */
  style?:
    | 'roof'
    | 'gate'
    | 'road'
    | 'sidewalk'
    | 'pole'
    | 'car'
    | 'tree'
    | 'barrel'
    | 'pipe'
    | 'wreck';
}

/** Размеры, которыми Box участвует в физике, а не его визуальный силуэт. */
export function boxCollisionSize(box: Box): { w: number; d: number } {
  return {
    w: box.collisionW ?? box.w,
    d: box.collisionD ?? box.d,
  };
}

/** Многоугольник коллизии в мировых координатах; для обычных Box — прямоугольник. */
export function worldCollisionPolygon(box: Box): Array<[number, number]> {
  if (box.collisionPolygon && box.collisionPolygon.length >= 3) {
    return box.collisionPolygon.map(([x, z]) => [box.x + x, box.z + z]);
  }
  const { w, d } = boxCollisionSize(box);
  const hw = w / 2;
  const hd = d / 2;
  return [
    [box.x - hw, box.z - hd],
    [box.x + hw, box.z - hd],
    [box.x + hw, box.z + hd],
    [box.x - hw, box.z + hd],
  ];
}

/** Точка внутри выпуклого многоугольника. Вершины могут быть по часовой стрелке. */
export function pointInPolygon(x: number, z: number, polygon: Array<[number, number]>): boolean {
  let sign = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, az] = polygon[i];
    const [bx, bz] = polygon[(i + 1) % polygon.length];
    const cross = (bx - ax) * (z - az) - (bz - az) * (x - ax);
    if (Math.abs(cross) < 1e-9) continue;
    const current = Math.sign(cross);
    if (sign === 0) sign = current;
    else if (current !== sign) return false;
  }
  return true;
}

/** Квадрат расстояния от точки до отрезка. */
export function distanceSquaredToSegment(
  x: number,
  z: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const length2 = dx * dx + dz * dz;
  const t = length2 > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / length2)) : 0;
  const px = ax + dx * t;
  const pz = az + dz * t;
  return (x - px) ** 2 + (z - pz) ** 2;
}

/** Пересекается ли круг с выпуклым многоугольником. */
export function circleIntersectsPolygon(
  x: number,
  z: number,
  radius: number,
  polygon: Array<[number, number]>,
): boolean {
  if (pointInPolygon(x, z, polygon)) return true;
  const radius2 = radius * radius;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, az] = polygon[i];
    const [bx, bz] = polygon[(i + 1) % polygon.length];
    if (distanceSquaredToSegment(x, z, ax, az, bx, bz) <= radius2) return true;
  }
  return false;
}

/** Расстояние от точки до многоугольника; внутри расстояние равно нулю. */
export function distanceToPolygon(x: number, z: number, polygon: Array<[number, number]>): number {
  if (pointInPolygon(x, z, polygon)) return 0;
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, az] = polygon[i];
    const [bx, bz] = polygon[(i + 1) % polygon.length];
    best = Math.min(best, distanceSquaredToSegment(x, z, ax, az, bx, bz));
  }
  return Math.sqrt(best);
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
export type BoomKind =
  | typeof BOOM_GROUND
  | typeof BOOM_HIT
  | typeof BOOM_KILL
  | typeof BOOM_RICOCHET;

/** Событие взрыва за тик (короткие ключи — трафик). */
export interface Boom {
  x: number;
  z: number;
  k: BoomKind;
  /** id стрелявшего — по нему клиент рисует себе отметку о попадании. */
  o: number;
}

/** Событие попадания за тик: сколько именно урона снял этот удар. */
export interface HitFx {
  x: number;
  z: number;
  amount: number;
}

/** Команды. Огонь по своим включён, так что команда — это только «за кого играешь». */
export const TEAM_PLAYERS = 0;
export const TEAM_BOTS = 1;

/**
 * Две стороны командного боя (MODE_TEAM). Число то же самое поле team, что и
 * везде — смысл ему придаёт только режим: в DM это «просто ярлык», здесь —
 * настоящий союз без урона по своим (см. isSquadMode/alliedTeams).
 */
export const TEAM_ONE = 0;
export const TEAM_TWO = 1;

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
  /** Максимальное здоровье с учётом постоянного BR-модуля брони. */
  m?: number;
  /** Монотонный счётчик подтверждённых выстрелов; нужен владельцу для отдачи. */
  q?: number;
}

/** Последняя известная позиция скрытого врага в королевской битве. */
export interface SnapshotContact {
  i: number; // id цели
  x: number;
  z: number;
  /** Сколько секунд маркер ещё живёт. */
  u: number;
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
