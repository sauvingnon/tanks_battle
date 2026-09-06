/**
 * ИИ бота. Бот — обычный игрок комнаты, только вместо сетевых инпутов ему раз в тик
 * пишет think(). Из-за этого он ездит и стреляет по тем же правилам, что и человек:
 * та же stepTank, та же перезарядка, та же скорость доворота башни.
 *
 * Вся «сложность» — в таблице BOT_TIERS: она меняет не характеристики танка,
 * а качество игры (реакция, точность, упреждение, отход, рикошеты).
 */
import {
  BONUS_STEALTH_RANGE,
  MAX_BOUNCES,
  MAX_HP,
  SHELL_LIFETIME,
  SHELL_SPEED,
  TANK_RADIUS,
  TICK_HZ,
} from '../shared/constants.js';
import {
  angleDiff,
  bounceShell,
  canRicochet,
  clamp,
  spawnShell,
  stepShell,
  sweepShell,
  sweepTank,
} from '../shared/sim.js';
import { spawnCount, spawnPoint } from '../shared/map.js';
import { createTankState, type Box, type Input, type ShellState, type TankState } from '../shared/types.js';

/** Что тир меняет в поведении. Характеристики самого танка одинаковы у всех. */
export interface BotTier {
  /** Задержка на смену цели и на осознание нового положения прицела, с. */
  reaction: number;
  /** Постоянный увод ствола, рад; пересчитывается раз в reaction. */
  aimError: number;
  /**
   * Доля упреждения по скорости цели: 0 — стреляет в точку, где цель стоит сейчас.
   * Упреждение — навык верхних тиров: от него сильнее всего зависит, попадёт ли бот
   * по едущему танку, а значит, работает ли вообще уклонение как приём.
   */
  lead: number;
  /**
   * Терпение на спуске, в долях углового размера цели. Меньше единицы — ждёт, пока
   * башня точно сядет на цель; больше — жмёт, едва довернув. В радианах этот порог
   * задавать нельзя: на 20 и на 80 метрах один и тот же угол значит разное.
   */
  fireGate: number;
  /** Отходит и разрывает линию огня на низком HP. */
  cover: boolean;
  /** Ищет выстрел с отскоком, когда цель за укрытием. */
  ricochet: boolean;
  /** Дистанция, на которой предпочитает драться, м. */
  range: number;
  /**
   * Сколько ботов одновременно имеют право идти на сближение с одной целью.
   * Остальные держат дистанцию. Один наседающий — это дуэль, в которой надо
   * мансить; четверо разом — это уже не бой, а раздавили числом. Поэтому
   * право на ближний бой и есть главная разница между уровнями.
   */
  pressers: number;
}

// Ошибка прицела в радианах разворачивается в метры промаха на дистанции:
// на 30 м 0.14 рад — это 4 м мимо при радиусе танка 2.4, то есть чаще мимо, чем в цель.
export const BOT_TIERS: BotTier[] = [
  { reaction: 0.9, aimError: 0.17, lead: 0, fireGate: 1.6, cover: false, ricochet: false, range: 32, pressers: 1 },
  { reaction: 0.45, aimError: 0.125, lead: 0, fireGate: 1.2, cover: true, ricochet: false, range: 36, pressers: 2 },
  { reaction: 0.22, aimError: 0.075, lead: 0.6, fireGate: 0.9, cover: true, ricochet: true, range: 40, pressers: 3 },
  { reaction: 0.11, aimError: 0.018, lead: 1, fireGate: 0.7, cover: true, ricochet: true, range: 44, pressers: 4 },
];

/** Позывные ботов. Кончились — дальше идут с номером. */
const BOT_NAMES = [
  'Гром', 'Вихрь', 'Кремень', 'Барс', 'Обух', 'Клык', 'Штырь', 'Тайфун',
  'Молот', 'Ржавый', 'Дозор', 'Картечь', 'Зубр', 'Оскол', 'Тень', 'Гарпун',
];

export function botName(index: number): string {
  const base = BOT_NAMES[index % BOT_NAMES.length];
  const lap = Math.floor(index / BOT_NAMES.length);
  return lap === 0 ? base : `${base}-${lap + 1}`;
}

/** Долгоживущее состояние ИИ между тиками. */
export interface BotBrain {
  tier: number;
  /** id выбранной цели; 0 — цели нет. */
  targetId: number;
  /** Тик следующего пересмотра цели и рикошета. */
  rethinkAt: number;
  /** Тик, раньше которого бот не стреляет: имитация реакции на смену обстановки. */
  readyAt: number;
  /** Текущий увод ствола. */
  aimBias: number;
  /** Найденный угол выстрела с отскоком; null — стреляем напрямую. */
  bank: number | null;
  /** Занял слот наседающего: этому боту разрешён ближний бой. */
  press: boolean;
  /** Направление обхода цели: +1 или -1, изредка меняется. */
  orbit: number;
  /** Тик, до которого держим текущее направление обхода. */
  orbitUntil: number;
  /** Сколько тиков подряд танк газует, а с места не двигается. */
  stuckFor: number;
  /** Тик, до которого выбираемся из упора задним ходом. */
  unstickUntil: number;
  /** Руль на время выезда: назад по своей же колее смысла нет. */
  unstickSteer: number;
}

export function createBrain(tier: number, tick: number, index: number): BotBrain {
  return {
    tier,
    targetId: 0,
    // Сдвиг фазы: боты пересматривают цель в разные тики, а не все разом.
    rethinkAt: tick + (index % RETHINK_TICKS),
    readyAt: tick + Math.round(BOT_TIERS[tier].reaction * TICK_HZ),
    aimBias: 0,
    bank: null,
    press: false,
    orbit: Math.random() < 0.5 ? 1 : -1,
    orbitUntil: tick,
    stuckFor: 0,
    unstickUntil: 0,
    unstickSteer: 1,
  };
}

/** Минимум, что ИИ должен знать о танке на карте. */
export interface BotTarget {
  id: number;
  team: number;
  dead: boolean;
  /** Под «Маскировкой»: издали в цель не берётся. */
  stealth: boolean;
  state: TankState;
}

export interface BotSelf extends BotTarget {
  hp: number;
  brain: BotBrain;
}

export interface BotWorld {
  tick: number;
  obstacles: Box[];
  tanks: Iterable<BotTarget>;
}

/** Раз в столько тиков бот пересматривает цель — полсекунды. */
const RETHINK_TICKS = Math.round(TICK_HZ / 2);
/** Длина щупов объезда, м. */
const FEELER = 13;

/**
 * Дистанция, ближе которой не подходит бот без слота наседающего. Толпа, разом
 * доехавшая до игрока, побеждает не игрой, а тем, что её много: на карте 140 м
 * от четверых в упор не увернуться. Поэтому лезет в ближний бой только тот,
 * кому это разрешил тир, а остальные работают с дистанции.
 */
const KEEP_MIN = 26;

/** Рабочая дистанция и предел сближения для того, кто занял слот наседающего. */
const PRESS_RANGE = 15;
const PRESS_MIN = 10;

/** С какого расстояния боты начинают расталкивать друг друга, м. */
const SPREAD = 18;
/** Дальше этого бот не стреляет: снаряд живёт 3.5 с и по дороге его собьёт стена. */
const MAX_ENGAGE = 95;

/** Ниже этой скорости считаем, что танк никуда не едет, м/с. */
const STUCK_SPEED = 1.5;
/** Столько тиков упора подряд — и бот признаёт, что застрял. */
const STUCK_TICKS = Math.round(TICK_HZ * 0.5);
/** Сколько выезжаем задним ходом, тиков. */
const UNSTICK_TICKS = Math.round(TICK_HZ * 0.8);

/**
 * Один шаг мышления. Возвращает инпут, который комната скормит stepTank —
 * ровно как инпут живого игрока.
 */
export function think(self: BotSelf, world: BotWorld): Input {
  const brain = self.brain;
  const tier = BOT_TIERS[brain.tier];
  const me = self.state;

  if (world.tick >= brain.rethinkAt) {
    brain.rethinkAt = world.tick + RETHINK_TICKS;
    retarget(self, world, tier);
  }

  const target = findTank(world, brain.targetId);
  if (!target || target.dead) {
    brain.targetId = 0;
    return patrol(self, world);
  }

  const dx = target.state.x - me.x;
  const dz = target.state.z - me.z;
  const dist = Math.hypot(dx, dz) || 1e-6;

  // Цель ушла под «Маскировку» — бот теряет её из виду до следующего пересмотра.
  if (target.stealth && dist > BONUS_STEALTH_RANGE) {
    brain.targetId = 0;
    return patrol(self, world);
  }

  // --- Прицел ---
  const aim = brain.bank ?? leadAngle(me, target.state, dist, tier.lead);
  const turret = aim + brain.aimBias;

  const shot = hasShot(me, target.state, world.obstacles);
  const clear = shot || brain.bank !== null;
  // Порог наводки — угловой размер танка на этой дистанции, растянутый терпением тира.
  const gate = Math.atan2(TANK_RADIUS, Math.max(dist, TANK_RADIUS)) * tier.fireGate;
  const aimed = Math.abs(angleDiff(me.turret, turret)) < gate;
  const fire =
    clear && aimed && dist < MAX_ENGAGE && world.tick >= brain.readyAt && !self.dead;

  // --- Ход ---
  // На низком HP разрывает дистанцию: подставляться под добивание невыгодно.
  const retreat = tier.cover && self.hp <= MAX_HP * 0.35;
  const want = heading(self, target.state, dist, tier, world, retreat, shot);
  const drive = unstick(brain, me, world.tick, steerTo(me, want, world.obstacles));

  return { seq: 0, throttle: drive.throttle, steer: drive.steer, turret, fire };
}

/** Выбор цели: ближайший видимый противник, иначе просто ближайший. */
function retarget(self: BotSelf, world: BotWorld, tier: BotTier): void {
  const brain = self.brain;
  const me = self.state;

  let best: BotTarget | null = null;
  let bestScore = Infinity;

  for (const tank of world.tanks) {
    if (tank.dead || tank.team === self.team || tank.id === self.id) continue;
    const d = Math.hypot(tank.state.x - me.x, tank.state.z - me.z);
    // Замаскированного издали бот не видит вовсе; вплотную — уже да.
    if (tank.stealth && d > BONUS_STEALTH_RANGE) continue;
    // Видимую цель предпочитаем даже если она вдвое дальше укрытой.
    const score = hasShot(me, tank.state, world.obstacles) ? d : d * 2.5 + 40;
    if (score < bestScore) {
      bestScore = score;
      best = tank;
    }
  }

  if (!best) {
    brain.targetId = 0;
    brain.bank = null;
    return;
  }

  // Смена цели стоит боту реакции: мгновенно переносить огонь умеет только Ас.
  if (best.id !== brain.targetId) {
    brain.targetId = best.id;
    brain.readyAt = world.tick + Math.round(tier.reaction * TICK_HZ);
  }
  brain.aimBias = (Math.random() * 2 - 1) * tier.aimError;

  // Слот наседающего раздаётся без всякого сговора: если между мной и целью уже
  // столько соседей, сколько тир разрешает пустить в ближний бой, — я держу
  // дистанцию. Правило чисто локальное, а строй из него получается общий.
  const myGap = Math.hypot(best.state.x - me.x, best.state.z - me.z);
  let closer = 0;
  for (const tank of world.tanks) {
    if (tank.id === self.id || tank.dead || tank.team !== self.team) continue;
    if (Math.hypot(best.state.x - tank.state.x, best.state.z - tank.state.z) < myGap) closer++;
  }
  brain.press = closer < tier.pressers;

  // Рикошет ищем только когда прямого выстрела нет — иначе он и не нужен.
  brain.bank =
    tier.ricochet && !hasShot(me, best.state, world.obstacles)
      ? findBankShot(me, best.state, world.obstacles)
      : null;

  if (world.tick > brain.orbitUntil) {
    brain.orbit = Math.random() < 0.5 ? 1 : -1;
    brain.orbitUntil = world.tick + TICK_HZ * (2 + Math.random() * 3);
  }
}

function findTank(world: BotWorld, id: number): BotTarget | null {
  if (id === 0) return null;
  for (const tank of world.tanks) if (tank.id === id) return tank;
  return null;
}

/** Угол на упреждённую точку: цель успеет проехать, пока летит снаряд. */
function leadAngle(me: TankState, target: TankState, dist: number, lead: number): number {
  const flight = (dist / SHELL_SPEED) * lead;
  const px = target.x + Math.sin(target.angle) * target.speed * flight;
  const pz = target.z + Math.cos(target.angle) * target.speed * flight;
  return Math.atan2(px - me.x, pz - me.z);
}

/**
 * Куда бот хочет ехать корпусом. Складывается из трёх составляющих: радиальной
 * (держать рабочую дистанцию), тангенциальной (обходить, а не переть в лоб) и
 * расталкивающей (не сбиваться с соседями в один кулак). Последние две важнее,
 * чем кажется: без них дюжина ботов просто съезжается в точку и давит числом.
 */
function heading(
  self: BotSelf,
  target: TankState,
  dist: number,
  tier: BotTier,
  world: BotWorld,
  retreat: boolean,
  shot: boolean,
): number {
  const me = self.state;

  // Единичный вектор на цель; перпендикуляр к нему — направление обхода.
  const tx = (target.x - me.x) / dist;
  const tz = (target.z - me.z) / dist;

  // Наседающему разрешён ближний бой, остальным — только работа с дистанции.
  const range = self.brain.press ? PRESS_RANGE : tier.range;
  const floor = self.brain.press ? PRESS_MIN : KEEP_MIN;

  let radial: number;
  if (retreat || dist < floor) radial = -1; // подбит или слишком близко — назад
  else if (dist > range * 1.15) radial = 1;
  else if (dist < range * 0.8) radial = -0.6;
  else radial = 0;

  // Цель за укрытием: ищем угол, но не ближе своего предела сближения.
  if (!shot && radial <= 0 && dist > floor) radial = 0.35;

  // На рабочей дистанции идёт чистым боком, на подходе — заметно сносит вбок.
  const tangent = (radial === 0 ? 1 : 0.45) * self.brain.orbit;

  let vx = tx * radial - tz * tangent;
  let vz = tz * radial + tx * tangent;

  for (const other of world.tanks) {
    if (other.id === self.id || other.dead || other.team !== self.team) continue;
    const dx = me.x - other.state.x;
    const dz = me.z - other.state.z;
    const gap = Math.hypot(dx, dz);
    if (gap > SPREAD || gap < 1e-3) continue;
    // Чем ближе сосед, тем сильнее толчок в сторону.
    const push = (1 - gap / SPREAD) * 1.4;
    vx += (dx / gap) * push;
    vz += (dz / gap) * push;
  }

  return avoid(me, Math.atan2(vx, vz), world.obstacles);
}

/** Если цели нет — едем к центру карты, объезжая блоки. */
function patrol(self: BotSelf, world: BotWorld): Input {
  const me = self.state;
  const want = avoid(me, Math.atan2(-me.x, -me.z), world.obstacles);
  const drive = steerTo(me, want, world.obstacles);
  // Газ убавлен, но выезд из упора идёт на полном: иначе бот так и останется в блоке.
  const move = unstick(self.brain, me, world.tick, {
    throttle: drive.throttle * 0.6,
    steer: drive.steer,
  });
  return { seq: 0, throttle: move.throttle, steer: move.steer, turret: me.turret };
}

/**
 * Углы объезда: сначала прямо, потом всё круче в обе стороны. Тремя щупами
 * обойтись не выходило — на ±0.6 рад упирался и второй щуп, бот выбирал
 * «менее плохую» сторону и всё равно приезжал в угол.
 */
const AVOID_FAN = [0, 0.4, -0.4, 0.8, -0.8, 1.25, -1.25];

/**
 * Объезд препятствий веером щупов: берём направление, где до преграды дальше
 * всего, со штрафом за отклонение от нужного курса. Прямой путь свободен —
 * никаких лишних щупов, это самый частый случай.
 */
function avoid(me: TankState, want: number, obstacles: Box[]): number {
  const ahead = free(me.x, me.z, want, FEELER, obstacles);
  if (ahead > 0.85) return want;

  let bestAngle = want;
  let bestScore = ahead;
  for (const offset of AVOID_FAN) {
    if (offset === 0) continue;
    const angle = want + offset;
    // Отклонение штрафуем, иначе бот уезжает вбок при малейшем камешке.
    const score = free(me.x, me.z, angle, FEELER, obstacles) - Math.abs(offset) * 0.2;
    if (score > bestScore) {
      bestScore = score;
      bestAngle = angle;
    }
  }
  return bestAngle;
}

/**
 * Доля пути до преграды по направлению angle, 0..1. Используется тот же свип,
 * что и для снарядов; щуп сдвинут на радиус танка, чтобы не цеплять углы бортом.
 */
function free(x: number, z: number, angle: number, dist: number, obstacles: Box[]): number {
  const dx = Math.sin(angle);
  const dz = Math.cos(angle);
  // Смещаем начало щупа вбок на пол-корпуса поочерёдно: узкую щель бот не примет за проезд.
  let worst = 1;
  for (const side of [-TANK_RADIUS * 0.9, TANK_RADIUS * 0.9]) {
    const probe = ray(x - dz * side, z + dx * side, dx * dist, dz * dist);
    const hit = sweepShell(probe, 1, obstacles);
    if (hit) worst = Math.min(worst, hit.stuck ? 0 : hit.t);
  }
  return worst;
}

/** Свободна ли линия огня до цели. */
function hasShot(me: TankState, target: TankState, obstacles: Box[]): boolean {
  const dx = target.x - me.x;
  const dz = target.z - me.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-3) return true;
  if (dist > MAX_ENGAGE) return false;

  // Останавливаемся у борта цели, а не в её центре, иначе сама цель считается стеной.
  const shorten = Math.max(0, dist - TANK_RADIUS) / dist;
  const hit = sweepShell(ray(me.x, me.z, dx * shorten, dz * shorten), 1, obstacles);
  return hit === null;
}

/**
 * Перебор углов в поисках выстрела с отскоком. Траектория считается тем же кодом,
 * что и настоящий полёт снаряда, поэтому найденный угол действительно сработает.
 */
export function findBankShot(me: TankState, target: TankState, obstacles: Box[]): number | null {
  const direct = Math.atan2(target.x - me.x, target.z - me.z);
  // Шире 70 градусов от цели рикошет уже уводит снаряд за карту.
  for (let step = 1; step <= 12; step++) {
    for (const side of [1, -1]) {
      const angle = direct + side * step * 0.1;
      if (bankHits(me, angle, target, obstacles)) return angle;
    }
  }
  return null;
}

/** Прогон одного пробного выстрела до попадания, взрыва или конца жизни снаряда. */
function bankHits(me: TankState, angle: number, target: TankState, obstacles: Box[]): boolean {
  const muzzle = createTankState(me.x, me.z, me.angle);
  muzzle.turret = angle;
  const shell = spawnShell(0, -1, muzzle);

  let time = SHELL_LIFETIME;
  for (let segment = 0; segment < MAX_BOUNCES + 2 && time > 1e-4; segment++) {
    const wall = sweepShell(shell, time, obstacles);
    const limit = wall ? wall.t : 1;

    const hit = sweepTank(shell, time, target);
    // Прямое попадание засчитываем только после отскока: без него это не рикошет.
    if (hit !== null && hit <= limit) return shell.bounces > 0;

    if (!wall) return false;
    const travel = time * wall.t;
    stepShell(shell, travel);
    time -= travel;
    if (!canRicochet(shell, wall)) return false;
    bounceShell(shell, wall);
  }
  return false;
}

/**
 * Газ и руль, чтобы корпус смотрел в want. Разворот назад делаем задним ходом.
 *
 * Газ приходится дозировать по двум причинам сразу. Первая — поворот: на полном
 * ходу корпус вращается вдвое медленнее, чем на месте (TURN_RATE_FULL против
 * TURN_RATE_STILL), поэтому танк, который жмёт в пол и одновременно доворачивает,
 * описывает дугу и срезает угол блока. Вторая — стена по курсу: подъезжать к ней
 * на полной скорости незачем, удар всё равно погасит 75% хода.
 */
function steerTo(me: TankState, want: number, obstacles: Box[]): { throttle: number; steer: number } {
  const err = angleDiff(me.angle, want);
  if (Math.abs(err) > 2.2) {
    // Цель почти за кормой: сдавать назад быстрее, чем разворачиваться на месте.
    const back = angleDiff(me.angle + Math.PI, want);
    return { throttle: -0.9, steer: clamp(-back * 2, -1, 1) };
  }

  // Щуп берём по курсу корпуса, а не по желаемому: едет танк всё-таки туда, куда смотрит.
  const room = free(me.x, me.z, me.angle, FEELER, obstacles);
  const byWall = 0.4 + room * 0.6;
  const byTurn = Math.max(0.35, 1 - Math.abs(err) * 0.45);
  return {
    throttle: Math.min(byWall, byTurn),
    steer: clamp(err * 2, -1, 1),
  };
}

/**
 * Танк уперся: газ есть, а с места не двигается — значит встал в блок, в угол
 * карты или в борт соседа (удар о препятствие оставляет от скорости четверть).
 * Тогда на восемь десятых секунды сдаём назад с вывернутым рулём: этого хватает,
 * чтобы съехать с грани и зайти иначе. Башня при этом работает как работала —
 * отползающий бот всё ещё стреляет.
 */
function unstick(
  brain: BotBrain,
  me: TankState,
  tick: number,
  drive: { throttle: number; steer: number },
): { throttle: number; steer: number } {
  if (tick < brain.unstickUntil) return { throttle: -0.85, steer: brain.unstickSteer };

  const pushing = Math.abs(drive.throttle) > 0.15;
  // Списываем по два за каждый нормальный тик: случайный контакт в счёт не идёт.
  if (pushing && Math.abs(me.speed) < STUCK_SPEED) brain.stuckFor++;
  else brain.stuckFor = Math.max(0, brain.stuckFor - 2);

  if (brain.stuckFor >= STUCK_TICKS) {
    brain.stuckFor = 0;
    brain.unstickUntil = tick + UNSTICK_TICKS;
    // Руль в сторону обхода: назад по своей же колее — снова в тот же угол.
    brain.unstickSteer = brain.orbit;
  }
  return drive;
}

/** Одноразовый «снаряд» для свипа: dt = 1, поэтому смещение равно (dx, dz). */
function ray(x: number, z: number, dx: number, dz: number): ShellState {
  return { id: 0, owner: -1, x, z, vx: dx, vz: dz, life: 1, bounces: 0 };
}

/**
 * Точка появления бота: спавн карты подальше от игроков, чтобы не выйти в упор.
 * Берём готовые точки карты, а не кольцо: на «Городе» кольцо прошло бы прямо
 * сквозь кварталы, и бот появлялся бы внутри блока.
 */
export function botSpawn(
  tanks: Iterable<BotTarget>,
  team: number,
  index: number,
  mapId: number,
): { x: number; z: number; angle: number } {
  const total = spawnCount(mapId);
  let best = spawnPoint(index, mapId);
  let bestDist = -1;

  for (let i = 0; i < total; i++) {
    const spot = spawnPoint(i + index, mapId);

    let nearest = Infinity;
    for (const tank of tanks) {
      if (tank.dead || tank.team === team) continue;
      nearest = Math.min(nearest, Math.hypot(tank.state.x - spot.x, tank.state.z - spot.z));
    }
    if (nearest > bestDist) {
      bestDist = nearest;
      best = spot;
    }
  }
  return best;
}
