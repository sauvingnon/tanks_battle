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
  BOT_HP,
  STANCE_COUNT,
  STANCE_NEUTRAL,
  MAX_BOUNCES,
  RELOAD_S,
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
import { bushBlockers, spawnCount, spawnPoint } from '../shared/map.js';
import { createTankState, type Box, type Input, type ShellState, type TankState } from '../shared/types.js';

/** Что тир меняет в поведении. Характеристики самого танка одинаковы у всех. */
export interface BotTier {
  /**
   * Реакция, с. Это не пауза, а возраст картинки: бот наводится не туда, где
   * цель есть, а туда, где он её видел в последний раз, и обновляет это место
   * раз в reaction. По стоящему танку такой бот не промахнётся никогда — оба
   * места совпадают; по едущему новичок стреляет туда, где тот был секунду
   * назад, а это семнадцать метров мимо. Заодно тем же числом откладывается
   * выстрел при смене цели.
   *
   * Раньше здесь была только эта отсрочка, а ствол всё остальное время держал
   * цель идеально — и «Новичок» вёл огонь с точностью, которой не бывает.
   */
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
   * Ближе этого не подходит тот, кому не досталось слота наседающего. Дистанция
   * и есть половина сложности: ошибка прицела в радианах на 45 м промахивается
   * вдвое дальше, чем на 25, поэтому «робкий» бот и мажет заметно чаще.
   */
  keep: number;
  /**
   * Пауза сверх перезарядки, с. Орудие готово — но новичок ещё возит стволом,
   * прежде чем выстрелить. Единственный способ развести уровни по темпу огня:
   * перезарядка у всех общая, а втроём по тебе стреляют втрое чаще, и никакая
   * точность этого перевеса не отыгрывает.
   */
  hesitate: number;
  /** Сколько ботов одного отряда может одновременно вести прямой огонь по цели. */
  focusers: number;
  /**
   * Сколько ботов одновременно имеют право идти на сближение с одной целью.
   * Остальные держат дистанцию. Один наседающий — это дуэль, в которой надо
   * мансить; четверо разом — это уже не бой, а раздавили числом. Поэтому
   * право на ближний бой и есть главная разница между уровнями.
   */
  pressers: number;
  /**
   * Дальность, на которой бот вообще способен заметить цель в конусе обзора
   * корпуса (см. SIGHT_FOV), м, — и, отдельно, вплотную видит и за его
   * пределами (см. NEAR_SIGHT_FRAC, общий для всех тиров): гусеницы и мотор
   * слышно спиной не хуже, чем видно глазами. Плюс то и другое ещё должно
   * быть не закрыто препятствием (hasShot). Дальше конуса и не вплотную, или
   * за стеной — цели для бота просто не существует.
   */
  sight: number;
  /**
   * Сколько секунд бот ещё едет и целится туда, где видел цель в последний
   * раз, после того как она пропала (вышла за sight, скрылась за укрытием или
   * ушла под «Маскировку»). Кончилось — цель забыта совсем, дальше обычный
   * патруль.
   */
  memory: number;
}

// Ошибка прицела в радианах разворачивается в метры промаха на дистанции:
// на 30 м 0.14 рад — это 4 м мимо при радиусе танка 2.4, то есть чаще мимо, чем в цель.
export const BOT_TIERS: BotTier[] = [
  { reaction: 1.3, aimError: 0.26, lead: 0, fireGate: 1.7, cover: false, ricochet: false, range: 52, keep: 46, hesitate: 2.6, focusers: 1, pressers: 1, sight: 58, memory: 2.5 },
  { reaction: 0.6, aimError: 0.17, lead: 0, fireGate: 1.25, cover: true, ricochet: false, range: 42, keep: 36, hesitate: 1.4, focusers: 1, pressers: 1, sight: 72, memory: 3.5 },
  { reaction: 0.25, aimError: 0.085, lead: 0.6, fireGate: 0.95, cover: true, ricochet: true, range: 40, keep: 30, hesitate: 0.6, focusers: 2, pressers: 2, sight: 86, memory: 5 },
  { reaction: 0.11, aimError: 0.018, lead: 1, fireGate: 0.7, cover: true, ricochet: true, range: 44, keep: 26, hesitate: 0, focusers: 2, pressers: 3, sight: 100, memory: 6.5 },
];

/**
 * Манера боя: надстройка над тиром, общая для всей комнаты. Тир говорит, как
 * хорошо бот играет, манера — как именно. Отдельная ручка нужна потому, что
 * «толпа в упор» и «точный огонь издали» давят игрока совершенно по-разному,
 * и лечится это тоже по-разному.
 */
export interface BotStance {
  /** Множитель дистанции, на которой бот держится. */
  keep: number;
  /** Сдвиг числа слотов наседающих; итог не опускается ниже нуля. */
  pressers: number;
}

export const BOT_STANCES: BotStance[] = [
  // Дистанция: в упор не идёт никто, работают только с рабочего расстояния.
  { keep: 1.45, pressers: -4 },
  { keep: 1, pressers: 0 },
  // Напор: лезут все и вплотную. Самый честный способ сделать больно.
  { keep: 0.55, pressers: 4 },
];

function stanceOf(id: number | undefined): BotStance {
  return BOT_STANCES[id !== undefined && id >= 0 && id < STANCE_COUNT ? id : STANCE_NEUTRAL];
}

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
  /** Последнее увиденное (уже с упреждением) место цели: в него и наводится ствол. */
  aimX: number;
  aimZ: number;
  /** По какой цели запомнено место и на каком тике оно устареет. */
  aimFor: number;
  aimAt: number;
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
  /** Тик, на котором цель в последний раз реально видели (в sight и без укрытия). */
  lastSeenAt: number;
  /** Последняя увиденная точка цели: пока видно — обновляется каждый тик, забыл — стоит на месте. */
  lastX: number;
  lastZ: number;
  /** До какого тика бот ещё едет к lastX/lastZ, забыв цель, прежде чем вернуться к обычному патрулю. */
  searchUntil: number;
  /** Текущая точка патруля — куда идёт, пока цели нет вовсе. */
  patrolX: number;
  patrolZ: number;
  /** Тик, на котором пора выбрать новую точку патруля. */
  patrolAt: number;
  /**
   * Видел ли цель прямо сейчас (итог think() за последний тик). Читает только
   * room.ts при попадании: если бот уже реально дерётся, случайный обстрел
   * издали от третьего не должен сдёргивать его на розыски того, кто попал.
   */
  engaged: boolean;
}

export function createBrain(tier: number, tick: number, index: number): BotBrain {
  return {
    tier,
    targetId: 0,
    // Сдвиг фазы: боты пересматривают цель в разные тики, а не все разом.
    rethinkAt: tick + (index % RETHINK_TICKS),
    readyAt: tick + Math.round(BOT_TIERS[tier].reaction * TICK_HZ),
    aimBias: 0,
    aimX: 0,
    aimZ: 0,
    aimFor: 0,
    aimAt: tick,
    bank: null,
    press: false,
    orbit: Math.random() < 0.5 ? 1 : -1,
    orbitUntil: tick,
    stuckFor: 0,
    unstickUntil: 0,
    unstickSteer: 1,
    lastSeenAt: tick,
    lastX: 0,
    lastZ: 0,
    searchUntil: tick,
    patrolX: 0,
    patrolZ: 0,
    patrolAt: tick,
    engaged: false,
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
  /** Недавно рядом разорвался снаряд (или сам зацепило) — рука дрожит сильнее. */
  suppressed: boolean;
}

export interface BotWorld {
  tick: number;
  /** Всё, обо что можно удариться: по нему бот прокладывает объезд. */
  obstacles: Box[];
  /** Только то, что держит снаряд. Низкое укрытие бот простреливает насквозь. */
  cover: Box[];
  /**
   * Кусты карты — рвут луч обзора бота (см. hasShot), снаряд не держат. Только
   * для ИИ: на то, что видит на экране человек, кусты не влияют. Не заданы —
   * кустов нет.
   */
  bushes?: Box[];
  tanks: Iterable<BotTarget>;
  /** Летящие снаряды — для уклонения (см. dodge()). Не заданы — уклонения нет. */
  shells?: Iterable<ShellState>;
  /** Манера боя комнаты; не задана — нейтральная. */
  stance?: number;
  /**
   * Половина стороны карты, м. Не задана — исторические 140×140. Щупы объезда
   * упираются в ту же стену, что и танк, поэтому размер им обязателен: с чужим
   * бот на большой карте видел бы стену там, где чистое поле, и уезжал в сторону.
   */
  half?: number;
  /** Состояние BR-зоны; вне неё движение к безопасности важнее патруля. */
  zone?: BotZone;
}

export interface BotZone {
  x: number;
  z: number;
  r: number;
  nextR: number;
  until: number;
  phase: 'safe' | 'shrinking' | 'final' | 'over';
}

/** Раз в столько тиков бот пересматривает цель — полсекунды. */
const RETHINK_TICKS = Math.round(TICK_HZ / 2);
/** Сколько бот едет к точке, где забытую цель видели в последний раз, прежде чем сдаться, с. */
const SEARCH_S = 4;
/** Раз в столько бот выбирает новую точку патруля, с. */
const PATROL_S = 9;
/** Горизонт предсказания для уклонения от снаряда, с — см. dodge(). */
const DODGE_HORIZON_S = 0.55;
/**
 * Полуугол обзора от направления корпуса, рад. Не половина «спереди»: боевой
 * heading() на рабочей дистанции ведёт бота чистым боком к цели (орбита), то
 * есть корпус смотрит перпендикулярно ей же — при полуугле меньше 90° бот в
 * своей обычной стойке терял бы цель из виду сам у себя за кормой. 110°
 * оставляет реальный слепой сектор строго сзади (140°), не ломая при этом
 * штатное кружение боком. Башню не считаю: это про то, куда обращена машина
 * целиком (экипаж, приборы), а не куда сейчас довёрнут ствол.
 */
const SIGHT_FOV = (110 * Math.PI) / 180;
/**
 * Доля tier.sight, в которой цель видно вообще без учёта конуса — вплотную
 * видно и боком, и спиной. За этой дальностью и до самого tier.sight решает
 * уже только курс корпуса (см. SIGHT_FOV).
 */
const NEAR_SIGHT_FRAC = 0.35;
/** Длина щупов объезда, м. */
const FEELER = 13;

/** Рабочая дистанция и предел сближения для того, кто занял слот наседающего. */
const PRESS_RANGE = 15;
const PRESS_MIN = 10;

/** С какого расстояния боты начинают расталкивать друг друга, м. */
const SPREAD = 18;
/** Дальше этого бот не стреляет: снаряд живёт 3.5 с и по дороге его собьёт стена. */
const MAX_ENGAGE = 95;
/** За сколько секунд до нового сжатия боты начинают заранее занимать безопасный край. */
const ZONE_PREP_S = 10;
/** Запас внутри круга: бот не должен ехать по самой границе и получать урон от округления. */
const ZONE_MARGIN = 24;

/** Во сколько раз шире увод ствола, пока бот подавлен (см. BotSelf.suppressed). */
const SUPPRESS_AIM_MULT = 2.2;

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

  const zoneMove = zoneHeading(self, world);

  const target = findTank(world, brain.targetId);
  if (!target || target.dead) {
    brain.targetId = 0;
    brain.engaged = false;
    // Цель мертва или уже вышла — искать её незачем, но если до этого бот уже
    // ехал доразведать другую потерянную цель, доедет: searchUntil про это,
    // а не про то, что случилось с target прямо сейчас.
    if (zoneMove !== null) return driveTo(self, world, zoneMove, 1);
    if (world.tick < brain.searchUntil) return search(self, world, brain.lastX, brain.lastZ);
    return patrol(self, world);
  }

  // Реальная дистанция до цели — только для того, чтобы решить, видно ли её
  // вообще (см. tier.sight). Дальше бот работает не с ней, а с тем, что «знает».
  const realDist = Math.hypot(target.state.x - me.x, target.state.z - me.z) || 1e-6;
  // Чистая линия огня, без предела дальности: ею тактика объезда решает, есть
  // ли смысл довернуть в обход препятствия. Дальность восприятия сюда не
  // подмешана нарочно — иначе на длинных коридорах бот жал бы вперёд просто
  // потому, что цель дальше tier.sight, хотя видно её прекрасно, и толпа
  // забивала бы единственные ворота на карте.
  const shot = hasShot(me, target.state, world.cover, world.bushes, world.half);
  // Загородил именно куст, а не стена: за стеной цель прячется по праву и её
  // логично обходить искать угол, а спрятавшегося в листве нужно не обходить,
  // а решительно подъехать вплотную — вблизи куст переставит слепить (см.
  // bushBlockers), и охота вообще имеет смысл только так.
  const bushOnly = !shot && hasShot(me, target.state, world.cover, undefined, world.half);
  const visible =
    inSight(me, tier, target.state.x, target.state.z, realDist) &&
    shot &&
    !(target.stealth && realDist > BONUS_STEALTH_RANGE);
  brain.engaged = visible;

  if (visible) {
    brain.lastSeenAt = world.tick;
    brain.lastX = target.state.x;
    brain.lastZ = target.state.z;
  } else if (world.tick - brain.lastSeenAt > Math.round(tier.memory * TICK_HZ)) {
    // Не видно дольше tier.memory — забыл. Едет туда, где видел в последний
    // раз, вместо того чтобы сразу вернуться к пустому патрулю.
    brain.targetId = 0;
    brain.searchUntil = world.tick + Math.round(SEARCH_S * TICK_HZ);
    return search(self, world, brain.lastX, brain.lastZ);
  }

  // Точка, на которую бот реально ориентируется: живая, если видит цель,
  // иначе — та, где видел её в последний раз.
  const trackX = visible ? target.state.x : brain.lastX;
  const trackZ = visible ? target.state.z : brain.lastZ;
  const dist = Math.hypot(trackX - me.x, trackZ - me.z) || 1e-6;

  // --- Прицел ---
  // Место цели бот освежает раз в tier.reaction и только пока видит её —
  // остальное время держит ствол там, где видел в последний раз. Из этого
  // сама собой выходит вся разница уровней по едущей цели: наводится он
  // идеально, но не туда.
  if (visible && (brain.aimFor !== target.id || world.tick >= brain.aimAt)) {
    brain.aimFor = target.id;
    brain.aimAt = world.tick + Math.max(1, Math.round(tier.reaction * TICK_HZ));
    // Упреждение считается в момент взгляда: оно поправляет ту картинку, которую
    // бот видит, а не ту, которой он не видит.
    const flight = (dist / SHELL_SPEED) * tier.lead;
    brain.aimX = target.state.x + Math.sin(target.state.angle) * target.state.speed * flight;
    brain.aimZ = target.state.z + Math.cos(target.state.angle) * target.state.speed * flight;
  }

  const aim = brain.bank ?? Math.atan2(brain.aimX - me.x, brain.aimZ - me.z);
  const turret = aim + brain.aimBias;

  const clear = visible || brain.bank !== null;
  // Порог наводки — угловой размер танка на этой дистанции, растянутый терпением тира.
  const gate = Math.atan2(TANK_RADIUS, Math.max(dist, TANK_RADIUS)) * tier.fireGate;
  const aimed = Math.abs(angleDiff(me.turret, turret)) < gate;
  // Толпа может видеть одну цель одновременно, но не должна превращать это в
  // очередь из нескольких стволов. Лишние боты всё ещё едут, обходят и ищут
  // угол — просто ждут своей очереди на прямой выстрел.
  const focusShot =
    (visible || brain.bank !== null) && focusAllowed(self, target, world, tier.focusers);
  const fire =
    clear && aimed && dist < MAX_ENGAGE && world.tick >= brain.readyAt && !self.dead && focusShot;
  // Свой таймер бот держит длиннее перезарядки ровно на hesitate, поэтому комната
  // его выстрел никогда не отклонит: она готова раньше, чем он решится.
  if (fire) brain.readyAt = world.tick + Math.round((RELOAD_S + tier.hesitate) * TICK_HZ);

  // --- Ход ---
  // На низком HP разрывает дистанцию: подставляться под добивание невыгодно.
  const retreat = tier.cover && self.hp <= BOT_HP * 0.35;
  const want =
    dodge(self, world) ??
    zoneMove ??
    heading(self, createTankState(trackX, trackZ), dist, tier, world, retreat, shot, bushOnly);
  const drive = unstick(brain, me, world.tick, steerTo(me, want, world.obstacles, world.half));

  return { seq: 0, throttle: drive.throttle, steer: drive.steer, turret, fire };
}

/** Возвращает направление к безопасной точке или null, если бот уже в порядке. */
function zoneHeading(self: BotSelf, world: BotWorld): number | null {
  const zone = world.zone;
  if (!zone || zone.phase === 'over' || zone.r <= 0) return null;

  const me = self.state;
  const dx = me.x - zone.x;
  const dz = me.z - zone.z;
  const distance = Math.hypot(dx, dz);
  const outside = distance > zone.r - ZONE_MARGIN;
  const preparing =
    zone.phase === 'shrinking' ||
    (zone.phase === 'safe' && zone.until <= ZONE_PREP_S);
  if (!outside && !preparing) return null;

  const targetRadius = preparing
    ? Math.max(0, Math.min(zone.r, zone.nextR) - ZONE_MARGIN)
    : Math.max(0, zone.r - ZONE_MARGIN);
  if (distance <= targetRadius) return null;

  const scale = distance > 1e-3 ? targetRadius / distance : 0;
  const targetX = zone.x + dx * scale;
  const targetZ = zone.z + dz * scale;
  const base = Math.atan2(targetX - me.x, targetZ - me.z);
  const { vx, vz } = spread(self, world, Math.sin(base), Math.cos(base));
  return avoid(me, Math.atan2(vx, vz), world.obstacles, world.half);
}

/** Движение к зоне, когда цели нет: сохраняет расталкивание и выход из упора. */
function driveTo(self: BotSelf, world: BotWorld, want: number, throttle: number): Input {
  const drive = steerTo(self.state, want, world.obstacles, world.half);
  const move = unstick(self.brain, self.state, world.tick, {
    throttle: drive.throttle * throttle,
    steer: drive.steer,
  });
  return { seq: 0, throttle: move.throttle, steer: move.steer, turret: self.state.turret };
}

/**
 * Разрешает фокусированный огонь только ограниченному числу ботов. Приоритет
 * получают те, кто ближе к цели, а при равной дистанции — тот, кто уже занял
 * слот наседающего; id оставляет порядок стабильным и не даёт стволам
 * хаотично перескакивать каждый тик.
 */
function focusAllowed(
  self: BotSelf,
  target: BotTarget,
  world: BotWorld,
  limit: number,
): boolean {
  const priority = (bot: BotTarget & { brain: BotBrain }): [number, number, number] => [
    Math.hypot(target.state.x - bot.state.x, target.state.z - bot.state.z) - (bot.brain.press ? 4 : 0),
    -bot.brain.tier,
    bot.id,
  ];
  const before = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));

  const mine = priority(self);
  let ahead = 0;
  for (const tank of world.tanks) {
    if (tank.id === self.id || tank.dead || tank.team !== self.team) continue;
    const bot = tank as BotTarget & { brain?: BotBrain | null };
    if (!bot.brain || bot.brain.targetId !== target.id || (!bot.brain.engaged && bot.brain.bank === null)) continue;
    if (before(priority({ ...tank, brain: bot.brain }), mine)) ahead++;
  }
  return ahead < Math.max(1, limit);
}

/**
 * Выбор цели среди тех, кого видно прямо сейчас: в радиусе обзора тира и без
 * препятствий на линии огня. Потерянную из виду цель этот перебор не трогает —
 * когда её забыть, решает think() по tier.memory, а не рестарт раз в полсекунды.
 */
function retarget(self: BotSelf, world: BotWorld, tier: BotTier): void {
  const brain = self.brain;
  const me = self.state;

  let spotted: BotTarget | null = null;
  let spottedDist = Infinity;

  for (const tank of world.tanks) {
    if (tank.dead || tank.team === self.team || tank.id === self.id) continue;
    const d = Math.hypot(tank.state.x - me.x, tank.state.z - me.z);
    // Замаскированного издали бот не видит вовсе; вплотную — уже да.
    if (tank.stealth && d > BONUS_STEALTH_RANGE) continue;
    // Дальше sight, вне зоны восприятия (см. inSight) или за укрытием/кустом —
    // кандидат на смену цели не участвует: это ровно тот же тест, что think()
    // гоняет каждый тик.
    if (
      !inSight(me, tier, tank.state.x, tank.state.z, d) ||
      !hasShot(me, tank.state, world.cover, world.bushes, world.half)
    )
      continue;
    if (d < spottedDist) {
      spottedDist = d;
      spotted = tank;
    }
  }

  if (spotted) {
    // Смена цели стоит боту реакции: мгновенно переносить огонь умеет только Ас.
    if (spotted.id !== brain.targetId) {
      brain.targetId = spotted.id;
      // Только откладываем выстрел, но никогда не приближаем: иначе смена цели
      // обнуляла бы паузу hesitate и новичок стрелял бы чаще ветерана.
      brain.readyAt = Math.max(brain.readyAt, world.tick + Math.round(tier.reaction * TICK_HZ));
    }
    // Подавлен — рука дрожит заметно сильнее, пока не отпустило.
    const wobble = self.suppressed ? tier.aimError * SUPPRESS_AIM_MULT : tier.aimError;
    brain.aimBias = (Math.random() * 2 - 1) * wobble;

    // Слот наседающего раздаётся без всякого сговора: если между мной и целью
    // уже столько соседей, сколько тир разрешает пустить в ближний бой, — я
    // держу дистанцию. Правило чисто локальное, а строй из него получается общий.
    let closer = 0;
    for (const tank of world.tanks) {
      if (tank.id === self.id || tank.dead || tank.team !== self.team) continue;
      if (Math.hypot(spotted.state.x - tank.state.x, spotted.state.z - tank.state.z) < spottedDist)
        closer++;
    }
    brain.press = closer < Math.max(0, tier.pressers + stanceOf(world.stance).pressers);
    // Видимость есть по определению spotted — обходной рикошет не нужен.
    brain.bank = null;
  } else if (tier.ricochet && brain.targetId !== 0) {
    // Никого не видно, но старая цель ещё в памяти — пробуем закинуть снаряд
    // рикошетом туда, где её видели в последний раз.
    brain.bank = findBankShot(me, createTankState(brain.lastX, brain.lastZ), world.cover, world.half);
  } else {
    brain.bank = null;
  }

  if (world.tick > brain.orbitUntil) {
    brain.orbit = Math.random() < 0.5 ? 1 : -1;
    // В бою виляет чаще — так труднее подгадать упреждение под едущую цель;
    // вне боя резкие рывки ни к чему, патруль должен выглядеть спокойным.
    const span = spotted ? 1.2 + Math.random() * 1.3 : 3 + Math.random() * 3;
    brain.orbitUntil = world.tick + TICK_HZ * span;
  }
}

function findTank(world: BotWorld, id: number): BotTarget | null {
  if (id === 0) return null;
  for (const tank of world.tanks) if (tank.id === id) return tank;
  return null;
}

/**
 * Настоящее уклонение: не «чаще меняет сторону обхода», а реакция на конкретный
 * снаряд. Перебирает world.shells тем же sweepTank, каким комната считает
 * попадание, — если снаряд чужой команды придёт в бота в ближайшие
 * DODGE_HORIZON_S секунд, возвращает угол резко в сторону от линии его полёта
 * (не пересекая её — усиливая тот боковой отступ, на котором бот и так уже
 * стоит от этой линии, чтобы уклонение никогда не заводило под снаряд).
 * Снарядов нет совсем (world.shells не задан) или угрозы нет — null, вызывающая
 * сторона сама решает, что делать вместо этого.
 */
function dodge(self: BotSelf, world: BotWorld): number | null {
  if (!world.shells) return null;
  const me = self.state;

  let threat: ShellState | null = null;
  let soonest = Infinity;
  for (const shell of world.shells) {
    if (shell.owner === self.id) continue;
    const owner = findTank(world, shell.owner);
    if (owner && owner.team === self.team) continue;
    const t = sweepTank(shell, DODGE_HORIZON_S, me);
    if (t === null || t > soonest) continue;
    soonest = t;
    threat = shell;
  }
  if (!threat) return null;

  const speed = Math.hypot(threat.vx, threat.vz) || 1e-6;
  // Перпендикуляр к линии полёта снаряда.
  const px = -threat.vz / speed;
  const pz = threat.vx / speed;
  // На какой стороне от линии снаряда я сейчас — усиливаю именно этот отступ.
  const side = Math.sign((me.x - threat.x) * px + (me.z - threat.z) * pz) || 1;
  return Math.atan2(px * side, pz * side);
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
  bushOnly: boolean,
): number {
  const me = self.state;

  // Единичный вектор на цель; перпендикуляр к нему — направление обхода.
  const tx = (target.x - me.x) / dist;
  const tz = (target.z - me.z) / dist;

  // Наседающему разрешён ближний бой, остальным — только работа с дистанции.
  // Манера растягивает или сжимает обе дистанции разом, чтобы строй не рвался.
  const stance = stanceOf(world.stance);
  const range = (self.brain.press ? PRESS_RANGE : tier.range) * stance.keep;
  const floor = (self.brain.press ? PRESS_MIN : tier.keep) * stance.keep;

  let radial: number;
  if (retreat || dist < floor) radial = -1; // подбит или слишком близко — назад
  else if (dist > range * 1.15) radial = 1;
  else if (dist < range * 0.8) radial = -0.6;
  else radial = 0;

  // Прямого выстрела нет (загорожено): ищем угол, но не ближе предела сближения.
  // Загородил куст, а не стена — это не про обход, а про то, что до цели надо
  // доехать: жмём решительно, а не просто подруливаем.
  if (!shot && radial <= 0 && dist > floor) radial = bushOnly ? 0.7 : 0.35;

  // На рабочей дистанции идёт чистым боком, на подходе — заметно сносит вбок.
  const tangent = (radial === 0 ? 1 : 0.45) * self.brain.orbit;

  const { vx, vz } = spread(self, world, tx * radial - tz * tangent, tz * radial + tx * tangent);
  return avoid(me, Math.atan2(vx, vz), world.obstacles, world.half);
}

/**
 * Расталкивание с соседями по команде: чем ближе сосед, тем сильнее толчок в
 * сторону. Нужно не только в бою (heading), но и вне его (patrol/search) —
 * без этого толпа, идущая не по цели, а просто к одной точке (центр карты или
 * место поиска), сбивается в один узкий проход и там стоит.
 */
function spread(
  self: BotSelf,
  world: BotWorld,
  vx: number,
  vz: number,
): { vx: number; vz: number } {
  const me = self.state;
  for (const other of world.tanks) {
    if (other.id === self.id || other.dead || other.team !== self.team) continue;
    const dx = me.x - other.state.x;
    const dz = me.z - other.state.z;
    const gap = Math.hypot(dx, dz);
    if (gap > SPREAD || gap < 1e-3) continue;
    const push = (1 - gap / SPREAD) * 1.4;
    vx += (dx / gap) * push;
    vz += (dz / gap) * push;
  }
  return { vx, vz };
}

/**
 * Пока цели нет вовсе — бродит по случайным точкам карты, а не едет вечно в
 * одну и ту же (например, в центр). Фиксированная точка притяжения на
 * симметричной карте с симметричным спавном может свести двух патрулирующих
 * в замкнутую орбиту друг напротив друга, где они никогда не встретятся
 * взглядом — так и было, пока патруль целился строго в центр.
 */
function patrol(self: BotSelf, world: BotWorld): Input {
  const brain = self.brain;
  const me = self.state;

  if (world.tick >= brain.patrolAt || Math.hypot(brain.patrolX - me.x, brain.patrolZ - me.z) < 8) {
    const half = world.half ?? 70;
    brain.patrolX = (Math.random() * 2 - 1) * half * 0.8;
    brain.patrolZ = (Math.random() * 2 - 1) * half * 0.8;
    brain.patrolAt = world.tick + Math.round(PATROL_S * TICK_HZ);
  }

  const base = dodge(self, world) ?? Math.atan2(brain.patrolX - me.x, brain.patrolZ - me.z);
  const { vx, vz } = spread(self, world, Math.sin(base), Math.cos(base));
  const want = avoid(me, Math.atan2(vx, vz), world.obstacles, world.half);
  const drive = steerTo(me, want, world.obstacles, world.half);
  // Газ убавлен, но выезд из упора идёт на полном: иначе бот так и останется в блоке.
  const move = unstick(self.brain, me, world.tick, {
    throttle: drive.throttle * 0.6,
    steer: drive.steer,
  });
  return { seq: 0, throttle: move.throttle, steer: move.steer, turret: me.turret };
}

/**
 * Цель забыта, но точка, где её видели, ещё свежа: едем туда — это и есть
 * «искал». Доехали и никого не нашли — дальше стоять незачем, отдаём ход
 * обычному патрулю; searchUntil в think() всё равно оборвёт поиск по таймеру,
 * даже если бот застрял и до точки так и не добрался.
 */
function search(self: BotSelf, world: BotWorld, x: number, z: number): Input {
  const me = self.state;
  if (Math.hypot(x - me.x, z - me.z) < 6) return patrol(self, world);

  const base = dodge(self, world) ?? Math.atan2(x - me.x, z - me.z);
  const { vx, vz } = spread(self, world, Math.sin(base), Math.cos(base));
  const want = avoid(me, Math.atan2(vx, vz), world.obstacles, world.half);
  const drive = steerTo(me, want, world.obstacles, world.half);
  const move = unstick(self.brain, me, world.tick, {
    throttle: drive.throttle * 0.75,
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
function avoid(me: TankState, want: number, obstacles: Box[], half?: number): number {
  const ahead = free(me.x, me.z, want, FEELER, obstacles, half);
  if (ahead > 0.85) return want;

  let bestAngle = want;
  let bestScore = ahead;
  for (const offset of AVOID_FAN) {
    if (offset === 0) continue;
    const angle = want + offset;
    // Отклонение штрафуем, иначе бот уезжает вбок при малейшем камешке.
    const score = free(me.x, me.z, angle, FEELER, obstacles, half) - Math.abs(offset) * 0.2;
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
function free(
  x: number,
  z: number,
  angle: number,
  dist: number,
  obstacles: Box[],
  half?: number,
): number {
  const dx = Math.sin(angle);
  const dz = Math.cos(angle);
  // Смещаем начало щупа вбок на пол-корпуса поочерёдно: узкую щель бот не примет за проезд.
  let worst = 1;
  for (const side of [-TANK_RADIUS * 0.9, TANK_RADIUS * 0.9]) {
    const probe = ray(x - dz * side, z + dx * side, dx * dist, dz * dist);
    const hit = sweepShell(probe, 1, obstacles, half);
    if (hit) worst = Math.min(worst, hit.stuck ? 0 : hit.t);
  }
  return worst;
}

/** В конусе обзора корпуса ли точка (x, z) — см. SIGHT_FOV. */
function facing(me: TankState, x: number, z: number): boolean {
  if (Math.abs(x - me.x) < 1e-3 && Math.abs(z - me.z) < 1e-3) return true;
  const bearing = Math.atan2(x - me.x, z - me.z);
  return Math.abs(angleDiff(me.angle, bearing)) <= SIGHT_FOV;
}

/**
 * В зоне восприятия ли точка на расстоянии dist от корпуса: либо вплотную
 * (см. NEAR_SIGHT_FRAC — тогда курс корпуса не важен), либо дальше, но в
 * конусе обзора и не за пределами tier.sight.
 */
function inSight(me: TankState, tier: BotTier, x: number, z: number, dist: number): boolean {
  if (dist > tier.sight) return false;
  return dist <= tier.sight * NEAR_SIGHT_FRAC || facing(me, x, z);
}

/**
 * Свободен ли путь от (me.x, me.z) до точки (x, z), не ближе чем pullback к
 * самой точке — иначе цель у самого конца луча считалась бы сама себе стеной.
 * bushes — уже отфильтрованный для позиции me список (см. bushBlockers):
 * собственный куст смотрящего в него не входит.
 */
function rayClear(
  me: TankState,
  x: number,
  z: number,
  pullback: number,
  cover: Box[],
  bushes: Box[],
  half?: number,
): boolean {
  const dx = x - me.x;
  const dz = z - me.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-3) return true;
  const shorten = Math.max(0, dist - pullback) / dist;
  const probe = ray(me.x, me.z, dx * shorten, dz * shorten);
  if (sweepShell(probe, 1, cover, half) !== null) return false;
  return bushes.length === 0 || sweepShell(probe, 1, bushes, half) === null;
}

/**
 * Доля TANK_RADIUS, на которую от центра цели отступают пробные точки по
 * краю корпуса — чуть меньше радиуса, чтобы точка не садилась ровно на угол
 * укрытия и не давала ложных «вижу» из-за погрешности геометрии.
 */
const EDGE_PROBE = TANK_RADIUS * 0.85;
/**
 * Насколько короче до края корпуса, чем до его центра: луч на край почти
 * параллелен лучу на центр (при обычных боевых дистанциях это хорошее
 * приближение), а сама тестовая точка лежит внутри окружности танка —
 * теорема Пифагора для хорды на расстоянии EDGE_PROBE от центра.
 */
const EDGE_PULLBACK = Math.sqrt(Math.max(0, TANK_RADIUS * TANK_RADIUS - EDGE_PROBE * EDGE_PROBE));

/**
 * Свободна ли линия огня до цели. Танк — круг, а не точка: пробуем не только
 * центр, но и оба края корпуса (перпендикулярно линии стрелок→цель) — торчащая
 * из-за угла четверть танка тоже считается видимой, а не только его середина.
 * Укрытия держат снаряд и рвут обзор всегда; кусты (bushes, необязательны) —
 * только обзор, и не для смотрящего, который сам сейчас в этом кусте (см.
 * bushBlockers): его собственная листва не слепит его самого на выходе.
 */
export function hasShot(
  me: TankState,
  target: TankState,
  cover: Box[],
  bushes: Box[] = [],
  half?: number,
  maxDistance = MAX_ENGAGE,
): boolean {
  const dx = target.x - me.x;
  const dz = target.z - me.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-3) return true;
  if (dist > maxDistance) return false;

  const blockers = bushBlockers(bushes, me.x, me.z);
  if (rayClear(me, target.x, target.z, TANK_RADIUS, cover, blockers, half)) return true;
  const nx = (-dz / dist) * EDGE_PROBE;
  const nz = (dx / dist) * EDGE_PROBE;
  return (
    rayClear(me, target.x + nx, target.z + nz, EDGE_PULLBACK, cover, blockers, half) ||
    rayClear(me, target.x - nx, target.z - nz, EDGE_PULLBACK, cover, blockers, half)
  );
}

/**
 * Перебор углов в поисках выстрела с отскоком. Траектория считается тем же кодом,
 * что и настоящий полёт снаряда, поэтому найденный угол действительно сработает.
 */
export function findBankShot(
  me: TankState,
  target: TankState,
  obstacles: Box[],
  half?: number,
): number | null {
  const direct = Math.atan2(target.x - me.x, target.z - me.z);
  // Шире 70 градусов от цели рикошет уже уводит снаряд за карту.
  for (let step = 1; step <= 12; step++) {
    for (const side of [1, -1]) {
      const angle = direct + side * step * 0.1;
      if (bankHits(me, angle, target, obstacles, half)) return angle;
    }
  }
  return null;
}

/** Прогон одного пробного выстрела до попадания, взрыва или конца жизни снаряда. */
function bankHits(
  me: TankState,
  angle: number,
  target: TankState,
  obstacles: Box[],
  half?: number,
): boolean {
  const muzzle = createTankState(me.x, me.z, me.angle);
  muzzle.turret = angle;
  const shell = spawnShell(0, -1, muzzle);

  let time = SHELL_LIFETIME;
  for (let segment = 0; segment < MAX_BOUNCES + 2 && time > 1e-4; segment++) {
    const wall = sweepShell(shell, time, obstacles, half);
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
function steerTo(
  me: TankState,
  want: number,
  obstacles: Box[],
  half?: number,
): { throttle: number; steer: number } {
  const err = angleDiff(me.angle, want);
  if (Math.abs(err) > 2.2) {
    // Цель почти за кормой: сдавать назад быстрее, чем разворачиваться на месте.
    // Руль на задней передаче инвертирован (см. stepTank), поэтому знак здесь
    // прямой: нос всё так же доворачивается к want, пока танк пятится.
    const back = angleDiff(me.angle + Math.PI, want);
    return { throttle: -0.9, steer: clamp(back * 2, -1, 1) };
  }

  // Щуп берём по курсу корпуса, а не по желаемому: едет танк всё-таки туда, куда смотрит.
  const room = free(me.x, me.z, me.angle, FEELER, obstacles, half);
  const byWall = 0.4 + room * 0.6;
  const byTurn = Math.max(0.35, 1 - Math.abs(err) * 0.45);
  return {
    throttle: Math.min(byWall, byTurn),
    steer: clamp(err * 2, -1, 1),
  };
}

/**
 * Танк уперся: газ есть, а с места не двигается — значит встал в блок, в угол
 * карты или в борт соседа (лобовой упор в грань гасит ход за полторы десятых).
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
    // Минус — та же инверсия заднего хода: корпус должен довернуться как раньше.
    brain.unstickSteer = -brain.orbit;
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
