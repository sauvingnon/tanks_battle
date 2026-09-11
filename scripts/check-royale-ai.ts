/**
 * Проверка BR-слоя ИИ (src/server/royaleBrain.ts). Запуск: npm run check:royale
 *
 * Решения политики проверяются напрямую, на собранном руками мире, а не «по
 * факту боя»: ровно по той же причине, по какой в check-bots.ts так проверяют
 * реакцию прицела — в живом матче на карте со случайным центром зоны, зданиями
 * и сорока танками любой замер «подъехал ближе» плавает от запуска к запуску и
 * проверяет уже не логику, а везение с геометрией. Отдельно — интеграционный
 * блок на настоящем Room: он доказывает, что комната в BR действительно
 * ходит через новый слой, а не мимо него.
 *
 * Вне BR поведение ботов не тронуто; доказательство этого — не здесь, а в том,
 * что check:bots, check:combat, check:team и check:expedition проходят без
 * единого изменения (policy туда не передаётся вовсе).
 */
import {
  BOT_HP,
  MODE_ROYALE,
  ROYALE_SIGHT_RANGE,
  ROYALE_SQUAD_SIZES,
  ROYALE_START_COUNTDOWN_S,
  SHELL_DAMAGE,
  SHELL_DAMAGE_SPREAD,
  TICK_HZ,
} from '../src/shared/constants.js';
import { buildMap, bushBoxes } from '../src/shared/map.js';
import { createTankState, type Box } from '../src/shared/types.js';
import { BOT_TIERS, createBrain, type BotSelf, type BotTarget, type BotWorld, type BotZone } from '../src/server/bot.js';
import { royaleThink, RoyaleIntel, RoyalePolicy } from '../src/server/royaleBrain.js';
import { Room, type Player } from '../src/server/room.js';

const checks: Array<[string, boolean]> = [];
const check = (label: string, ok: boolean) => checks.push([label, ok]);

const noop = () => {};

/** Те же пороги, что и в политике, — считаем их так же, а не переписываем числами. */
const CRITICAL_HP = Math.ceil(SHELL_DAMAGE * (1 + SHELL_DAMAGE_SPREAD));
const WOUNDED_HP = CRITICAL_HP * 2;

type Foe = BotTarget & { hp: number };

function foe(id: number, team: number, x: number, z: number, hp = BOT_HP): Foe {
  return { id, team, dead: false, stealth: false, state: createTankState(x, z, 0), hp };
}

function me(id: number, team: number, x: number, z: number, hp = BOT_HP): BotSelf {
  return { ...foe(id, team, x, z, hp), brain: createBrain(2, 0, id), suppressed: false };
}

function bush(x: number, z: number): Box {
  return { x, z, w: 10, d: 10, h: 1 };
}

function zoneAt(x: number, z: number, r: number): BotZone {
  return { x, z, r, nextR: r, until: 60, phase: 'safe' };
}

function worldOf(tanks: BotTarget[], extra: Partial<BotWorld> = {}): BotWorld {
  return { tick: 0, obstacles: [], cover: [], tanks, ...extra };
}

/** Мир, в котором один боец сквада уже видит врага и потому «назначил» его отряду. */
function withCallout(self: BotSelf, mate: BotSelf, target: Foe, extra: Partial<BotWorld> = {}): BotWorld {
  mate.brain.targetId = target.id;
  mate.brain.engaged = true;
  return worldOf([self, mate, target], extra);
}

// --- shouldRetreat: когда бот считает бой невыгодным ---
{
  const intel = new RoyaleIntel();
  const policy = new RoyalePolicy(intel);

  const dying = me(1, 0, 0, 0, CRITICAL_HP - 1);
  const worldDying = worldOf([dying]);
  intel.refreshIfNeeded(worldDying);
  check('на критическом HP бот отступает даже в одиночку', policy.shouldRetreat(dying, worldDying));

  const healthy = me(1, 0, 0, 0, BOT_HP);
  const closeFoe = foe(2, 1, 10, 0);
  const worldHealthy = worldOf([healthy, closeFoe]);
  intel.refreshIfNeeded(worldHealthy);
  check('на полном HP бот не отступает', !policy.shouldRetreat(healthy, worldHealthy));

  const woundedFair = me(1, 0, 0, 0, WOUNDED_HP - 1);
  const worldFair = worldOf([woundedFair, foe(2, 1, 10, 0)]);
  const fairIntel = new RoyaleIntel();
  const fairPolicy = new RoyalePolicy(fairIntel);
  fairIntel.refreshIfNeeded(worldFair);
  check('раненый бот один на один остаётся в бою', !fairPolicy.shouldRetreat(woundedFair, worldFair));

  const woundedOut = me(1, 0, 0, 0, WOUNDED_HP - 1);
  const worldOut = worldOf([woundedOut, foe(2, 1, 10, 0), foe(3, 1, 12, 4)]);
  const outIntel = new RoyaleIntel();
  const outPolicy = new RoyalePolicy(outIntel);
  outIntel.refreshIfNeeded(worldOut);
  check('раненый бот против двоих отступает', outPolicy.shouldRetreat(woundedOut, worldOut));

  const woundedBacked = me(1, 0, 0, 0, WOUNDED_HP - 1);
  const worldBacked = worldOf([
    woundedBacked,
    foe(2, 1, 10, 0),
    foe(3, 1, 12, 4),
    foe(4, 0, -8, 0),
    foe(5, 0, -6, 5),
  ]);
  const backedIntel = new RoyaleIntel();
  const backedPolicy = new RoyalePolicy(backedIntel);
  backedIntel.refreshIfNeeded(worldBacked);
  check('раненый бот с прикрытием сквада бой не бросает', !backedPolicy.shouldRetreat(woundedBacked, worldBacked));
}

// --- Обзор BR: тот же радиус и круговой обзор, что у игрока в третьем лице ---
{
  const intel = new RoyaleIntel();
  const policy = new RoyalePolicy(intel);
  const scout = me(1, 0, 0, 0);
  const behind = foe(2, 1, 0, -120);
  scout.brain.rethinkAt = 0;
  // BR идёт на большой карте: без half() синтетический мир по умолчанию
  // имеет исторические 140 м и край корпуса почти касается границы.
  const world = worldOf([scout, behind], { half: 450 });
  royaleThink(scout, world, intel, policy);
  check('BR-бот замечает врага за корпусом на дистанции обзора игрока', scout.brain.targetId === behind.id);

  const nearLimit = foe(3, 1, 0, -ROYALE_SIGHT_RANGE + 0.1);
  const far = foe(4, 1, 0, -ROYALE_SIGHT_RANGE - 0.1);
  check('BR-обзор обрывается ровно на серверной дальности игрока',
    policy.canSee(scout, nearLimit, BOT_TIERS[scout.brain.tier], ROYALE_SIGHT_RANGE - 0.1, world) &&
    !policy.canSee(scout, far, BOT_TIERS[scout.brain.tier], ROYALE_SIGHT_RANGE + 0.1, world),
  );
}

// --- Пассивное преследование: обход под стволом и атака после выхода из сектора ---
{
  const intel = new RoyaleIntel();
  const policy = new RoyalePolicy(intel);
  const hunter = me(1, 0, 0, 0);
  const watched = foe(2, 1, 0, 78);
  watched.state.turret = Math.PI; // противник смотрит прямо на охотника
  hunter.brain.orbit = 1;
  const world = worldOf([hunter, watched], { half: 450 });
  const shadow = policy.stalkPoint(hunter, watched, 78, world);
  check(
    'под стволом на средней дистанции BR-бот заходит к корме по флангу',
    shadow !== null && shadow.z > watched.state.z && Math.abs(shadow.x) > 1,
  );

  watched.state.turret = 0; // отвернулся — момент для атаки уже наступил
  check('вышел из сектора башни цели — скрытный заход прекращается', policy.stalkPoint(hunter, watched, 78, world) === null);

  watched.state.turret = Math.PI;
  hunter.brain.targetId = watched.id;
  hunter.brain.rethinkAt = 0;
  hunter.brain.readyAt = 0;
  hunter.brain.aimFor = watched.id;
  hunter.brain.aimAt = 100;
  hunter.brain.aimX = watched.state.x;
  hunter.brain.aimZ = watched.state.z;
  world.tick = 10;
  const stalking = royaleThink(hunter, world, intel, policy);
  check('во время обхода бот не выдаёт себя выстрелом', !stalking.fire);

  watched.state.turret = 0;
  world.tick++;
  const opportunity = royaleThink(hunter, world, intel, policy);
  check('после выхода из сектора бот открывает огонь при готовом прицеле', opportunity.fire);
}

// --- targetScore: кого бот предпочитает при равной дистанции ---
{
  const intel = new RoyaleIntel();
  const policy = new RoyalePolicy(intel);
  const hunter = me(1, 0, 0, 0);
  const weak = foe(2, 1, 40, 0, BOT_HP * 0.3);
  const strong = foe(3, 2, -40, 0, BOT_HP);
  const world = worldOf([hunter, weak, strong]);
  intel.refreshIfNeeded(world);
  check(
    'при равной дистанции выбирается подранок',
    policy.targetScore(hunter, weak, 40, world) < policy.targetScore(hunter, strong, 40, world),
  );
}

{
  const intel = new RoyaleIntel();
  const policy = new RoyalePolicy(intel);
  const hunter = me(1, 0, 0, 0);
  const lone = foe(2, 1, 40, 0);
  const covered = foe(3, 2, -40, 0);
  const coveredMate = foe(4, 2, -44, 4);
  const world = worldOf([hunter, lone, covered, coveredMate]);
  intel.refreshIfNeeded(world);
  check(
    'при равном HP выбирается одиночка, а не прикрытый союзником',
    policy.targetScore(hunter, lone, 40, world) < policy.targetScore(hunter, covered, 40, world),
  );
}

{
  const intel = new RoyaleIntel();
  const policy = new RoyalePolicy(intel);
  const hunter = me(1, 0, 0, 0);
  const mate = me(4, 0, 38, 2);
  const called = foe(2, 1, 40, 0);
  const other = foe(3, 2, -40, 0);
  const world = withCallout(hunter, mate, called);
  world.tanks = [hunter, mate, called, other];
  intel.refreshIfNeeded(world);
  check(
    'цель, назначенная сквадом, перевешивает равную по прочему',
    policy.targetScore(hunter, called, 40, world) < policy.targetScore(hunter, other, 40, world),
  );
}

// --- retreatTo: куда именно бот уходит прятаться ---
{
  const intel = new RoyaleIntel();
  const policy = new RoyalePolicy(intel);
  const hurt = me(1, 0, 0, 0, CRITICAL_HP - 1);
  const world = worldOf([hurt], {
    bushes: [bush(120, 0), bush(60, 0), bush(-200, 0)],
    zone: zoneAt(0, 0, 300),
  });
  intel.refreshIfNeeded(world);
  const spot = policy.retreatTo(hurt, world);
  check('бот уходит в ближайший куст', spot !== null && spot.x === 60 && spot.z === 0);
}

{
  const intel = new RoyaleIntel();
  const policy = new RoyalePolicy(intel);
  const hurt = me(1, 0, 0, 0, CRITICAL_HP - 1);
  // Ближний куст — за кругом, дальний внутри: прятаться под урон зоны нельзя.
  const world = worldOf([hurt], {
    bushes: [bush(260, 0), bush(-90, 0)],
    zone: zoneAt(0, 0, 100),
  });
  intel.refreshIfNeeded(world);
  const spot = policy.retreatTo(hurt, world);
  check('куст за кругом зоны не выбирается', spot !== null && spot.x === -90);
}

{
  const intel = new RoyaleIntel();
  const policy = new RoyalePolicy(intel);
  const hurt = me(1, 0, 0, 0, CRITICAL_HP - 1);
  const world = worldOf([hurt], { zone: zoneAt(0, 0, 300) });
  intel.refreshIfNeeded(world);
  check('без кустов отход остаётся прежним (null — решает heading)', policy.retreatTo(hurt, world) === null);
}

// --- Эндгейм: малый круг не отменяет ценность укрытия ---
{
  const intel = new RoyaleIntel();
  const policy = new RoyalePolicy(intel);
  const hunter = me(1, 0, -30, 0, CRITICAL_HP - 1);
  const lastEnemy = foe(2, 1, 30, 0);
  const world = worldOf([hunter, lastEnemy], { zone: zoneAt(12, -8, 80) });
  intel.refreshIfNeeded(world);
  const point = policy.regroupPoint(hunter, world);
  check('в финальной дуэли критический бот сохраняет право спрятаться', policy.shouldRetreat(hunter, world));
  check('без контакта в финальной дуэли бот не выдаёт себя походом в центр', point === null);
}

// --- regroupPoint и вызовы сквада ---
{
  const intel = new RoyaleIntel();
  const policy = new RoyalePolicy(intel);
  const idle = me(1, 0, -300, 0);
  const mate = me(4, 0, 38, 2);
  const target = foe(2, 1, 40, 0, BOT_HP * 0.4);
  const world = withCallout(idle, mate, target);
  intel.refreshIfNeeded(world);

  const point = policy.regroupPoint(idle, world);
  check('боец без своей цели идёт на вызов союзника', point !== null && point.x === 40 && point.z === 0);

  idle.brain.targetId = target.id;
  check('на свою же цель повторно не «стягиваются»', policy.regroupPoint(idle, world) === null);
}

{
  const intel = new RoyaleIntel();
  const policy = new RoyalePolicy(intel);
  const solo = me(1, 7, 0, 0);
  const world = worldOf([solo, foe(2, 1, 300, 0)]);
  intel.refreshIfNeeded(world);
  check('в соло вызовов нет и стягиваться некуда', policy.regroupPoint(solo, world) === null);
}

{
  const intel = new RoyaleIntel();
  const scout = me(1, 0, 0, 0);
  const weak = foe(2, 1, 30, 0, BOT_HP * 0.2);
  const strong = foe(3, 1, 25, 0, BOT_HP);
  scout.brain.targetId = strong.id;
  scout.brain.engaged = true;
  const mate = me(4, 0, 4, 0);
  mate.brain.targetId = weak.id;
  mate.brain.engaged = true;
  const world = worldOf([scout, mate, weak, strong]);
  intel.refreshIfNeeded(world);
  const call = intel.calloutFor(0, world.tick);
  check('сквад назначает целью самого слабого из видимых', call !== null && call.targetId === weak.id);

  // Никто больше цель не держит — вызов должен истечь по сроку.
  scout.brain.engaged = false;
  mate.brain.engaged = false;
  const later = { ...world, tick: world.tick + Math.round(10 * TICK_HZ) };
  intel.refreshIfNeeded(later);
  check('вызов истекает, если его никто не подтверждает', intel.calloutFor(0, later.tick) === null);
}

// --- Интеграция: комната в BR действительно ходит через новый слой ---
{
  const room = new Room();
  const player = room.add('Игрок', noop);
  room.setup(MODE_ROYALE, 1, true);
  runRoom(room, ROYALE_START_COUNTDOWN_S * TICK_HZ + 1);

  const royaleBushes = bushBoxes(buildMap(room.mapId));
  const wounded = roomBots(room);
  const before = new Map<number, number>();
  for (const bot of wounded) {
    bot.hp = 40; // ниже CRITICAL_HP — политика обязана увести всех в укрытие
    before.set(bot.id, nearestBushDist(royaleBushes, bot.state.x, bot.state.z));
  }

  runRoom(room, TICK_HZ * 4);

  let hiding = 0;
  for (const bot of wounded) {
    if (bot.dead) continue;
    const now = nearestBushDist(royaleBushes, bot.state.x, bot.state.z);
    // Либо стал ближе к кусту, либо уже сидит в нём — обе ситуации это «спрятался».
    if (now < (before.get(bot.id) ?? Infinity) || now < 12) hiding++;
  }
  const alive = wounded.filter((b) => !b.dead).length;
  check('в живом матче раненые боты идут в укрытие', alive > 0 && hiding > alive * 0.6);
  check('раненые боты при этом не разъезжаются наружу зоны', roomOutsideZone(room) === 0);
}

{
  let crashed = false;
  try {
    const room = new Room();
    room.add('Одиночка', noop);
    room.setup(MODE_ROYALE, 1, true, undefined, undefined, undefined, undefined, ROYALE_SQUAD_SIZES[0]);
    runRoom(room, ROYALE_START_COUNTDOWN_S * TICK_HZ + TICK_HZ * 3);
    for (const bot of roomBots(room)) bot.hp = 40;
    runRoom(room, TICK_HZ * 2);
  } catch (err) {
    crashed = true;
    console.error(err);
  }
  check('соло BR (сквад из одного) работает без исключений', !crashed);
}

// --- Итог ---

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? '  ok' : 'FAIL'}  ${label}`);
}
console.log(`\n${checks.length - failed} из ${checks.length} проверок пройдено`);
if (failed > 0) process.exit(1);

// --- Помощники для интеграционного блока ---

function runRoom(room: Room, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    for (const player of room.players.values()) {
      if (player.brain) continue;
      room.pushInput(player, {
        seq: room.tickCount + i + 1,
        throttle: 0,
        steer: 0,
        turret: player.state.turret,
        fire: false,
      });
    }
    room.update();
  }
}

function roomBots(room: Room): Player[] {
  return [...room.players.values()].filter((p) => p.brain);
}

function roomOutsideZone(room: Room): number {
  const zone = room.royaleZoneState();
  if (!zone) return 0;
  let outside = 0;
  for (const bot of roomBots(room)) {
    if (bot.dead) continue;
    if (Math.hypot(bot.state.x - zone.x, bot.state.z - zone.z) > zone.r) outside++;
  }
  return outside;
}

function nearestBushDist(bushes: Box[], x: number, z: number): number {
  let best = Infinity;
  for (const b of bushes) best = Math.min(best, Math.hypot(x - b.x, z - b.z));
  return best;
}
