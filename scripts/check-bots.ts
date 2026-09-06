/**
 * Проверка режима «все против ботов» на настоящем классе Room, без сети и браузера.
 * Запуск: npm run check:bots
 *
 * Волны, одна жизнь на волну, выбывание, смена режима и хоста, бонусные ящики —
 * плюс замер того, во сколько обходится полный тик с двенадцатью ботами на карте.
 */
import {
  BONUS_DAMAGE,
  BONUS_HEAL,
  BONUS_HEAL_HP,
  BONUS_RELOAD,
  BONUS_SPEED,
  BONUS_STEALTH,
  BOT_HP,
  BOTS_PER_HUMAN,
  MAX_HP,
  MAX_TIER,
  STANCE_NAMES,
  MODE_DM,
  MODE_PVE,
  RESPAWN_S,
  SHELL_DAMAGE,
  SHELL_LIFETIME,
  SHELL_SPEED,
  TANK_RADIUS,
  TICK_HZ,
  WAVE_BREAK_S,
  waveConcurrent,
  waveQuota,
} from '../src/shared/constants.js';
import { buildMap, MAP_NAMES, spawnPoint } from '../src/shared/map.js';
import { sweepShell } from '../src/shared/sim.js';
import { createTankState, type ShellState } from '../src/shared/types.js';
import { createBrain, findBankShot, think } from '../src/server/bot.js';
import { Room, type Player } from '../src/server/room.js';

const checks: Array<[string, boolean]> = [];
const check = (label: string, ok: boolean) => checks.push([label, ok]);

const noop = () => {};

/** Прогоняет комнату N тиков. Люди стоят на месте, боты живут своим умом. */
function run(room: Room, ticks: number, firing: Player[] = []): void {
  for (let i = 0; i < ticks; i++) {
    for (const player of room.players.values()) {
      if (player.brain) continue;
      room.pushInput(player, {
        seq: room.tickCount + i + 1,
        throttle: 0,
        steer: 0,
        turret: player.state.turret,
        fire: firing.includes(player),
      });
    }
    room.update();
  }
}

function bots(room: Room): Player[] {
  return [...room.players.values()].filter((p) => p.brain);
}

/**
 * Выбивает волну целиком. Просто снять ботов с карты уже мало: одновременно их
 * выходит не больше трёх на игрока, и остаток квоты ждёт очереди — поэтому
 * чистим карту каждый тик, пока волна не засчитается.
 */
function wipeWave(room: Room): void {
  for (let i = 0; i < 120 * TICK_HZ; i++) {
    for (const bot of bots(room)) room.players.delete(bot.id);
    run(room, 1);
    if (room.waveState().phase !== 'fight') return;
  }
}

/**
 * Ставит двоих в чистом коридоре на z = 35 стволами друг к другу и оставляет
 * жертве ровно на один снаряд здоровья: так проверка не зависит от перезарядки.
 */
function duel(victim: Player, shooter: Player): void {
  victim.state = createTankState(-15, 35, Math.PI / 2);
  shooter.state = createTankState(-32, 35, Math.PI / 2);
  victim.hp = SHELL_DAMAGE;
}

// --- Волна выходит порциями и не превышает потолок ---

{
  const room = new Room();
  const player = room.add('Игрок', noop);
  room.setup(MODE_PVE, 1, false);

  run(room, 2);
  check('волна 1 начинается сразу, как в комнате появился человек', room.waveState().wave === 1);
  const opening = bots(room).length;
  check('в начале волны на карте не вся квота, а первые боты', opening > 0 && opening < waveQuota(1));

  run(room, 8 * TICK_HZ);
  check(
    'на одного игрока выходит столько ботов, сколько разрешает сложность',
    bots(room).length === waveConcurrent(1, 1, 0) && bots(room).length === BOTS_PER_HUMAN[0],
  );
  check('остальная квота волны ждёт своей очереди', room.waveState().left === waveQuota(1));
  check('хост — первый вошедший', room.hostId === player.id);

  const moved = bots(room).some(
    (b) => Math.abs(b.state.x) < 60 || Math.abs(b.state.z) < 60,
  );
  check('боты поехали со спавна к центру', moved);
  check('боты и человек в разных командах', bots(room).every((b) => b.team !== player.team));
}

// --- Зачистка волны: пауза, потом следующая, крупнее ---

{
  const room = new Room();
  room.add('Игрок', noop);
  room.setup(MODE_PVE, 0, false);
  run(room, 8 * TICK_HZ);

  wipeWave(room);
  check('квота выбита — волна засчитана, идёт передышка', room.waveState().phase === 'break');
  check('рекорд обновился', room.waveState().best === 1);

  run(room, Math.round(WAVE_BREAK_S * TICK_HZ) + 2);
  check('после передышки началась волна 2', room.waveState().wave === 2);

  run(room, 12 * TICK_HZ);
  check('квота волны 2 больше первой', room.waveState().left === waveQuota(2));
  check('одновременно на карте не больше лимита волны', bots(room).length <= waveConcurrent(2, 1, MAX_TIER));
}

// --- Потолок ботов растёт вместе с числом игроков ---

{
  const room = new Room();
  room.add('Первый', noop);
  room.add('Второй', noop);
  room.setup(MODE_PVE, 0, false);
  run(room, 8 * TICK_HZ);
  check('вдвоём на карте помещается больше ботов', bots(room).length > BOTS_PER_HUMAN[0]);
  check('но не больше положенного на каждого', bots(room).length <= 2 * BOTS_PER_HUMAN[0]);
}

// --- Сложность вступает в силу на границе волн ---

{
  const room = new Room();
  room.add('Игрок', noop);
  room.setup(MODE_PVE, 0, false);
  run(room, 4 * TICK_HZ);

  room.setup(undefined, 3, undefined);
  run(room, 2);
  check('выбор хоста записан', room.difficulty === 3);
  check('волна доигрывается на прежней сложности', room.runDifficulty === 0);
  check('клиенту видно, что в силе пока старая', room.config().active === 0);

  wipeWave(room);
  run(room, Math.round(WAVE_BREAK_S * TICK_HZ) + 4);
  check('следующая волна пошла по новой сложности', room.runDifficulty === 3);
  check('пометка ожидания снята', room.config().active === 3);
}

// --- Выпущенный снаряд живёт своей жизнью ---

{
  // Стрелка убивают, пока его снаряд в воздухе. Снаряд обязан долететь и попасть.
  const room = new Room();
  const victim = room.add('Жертва', noop);
  const shooter = room.add('Стрелок', noop);
  room.setup(MODE_DM, undefined, false);
  run(room, 1);

  duel(victim, shooter);
  victim.hp = MAX_HP;

  run(room, 1, [shooter]);
  check('снаряд стрелка в воздухе', room.shellCount === 1);

  // Сносим стрелка вручную: важно, что он выбыл, а не кто его достал.
  shooter.hp = 0;
  shooter.dead = true;
  shooter.respawnAt = room.tickCount + 10 * TICK_HZ;
  run(room, Math.round(0.6 * TICK_HZ));
  check('стрелок уничтожен, пока снаряд летел', shooter.dead);
  check('снаряд мёртвого стрелка всё равно попал', victim.hp < MAX_HP);
}

{
  // Стрелок отключается, пока снаряд в воздухе: его Player пропадает из комнаты
  // насовсем — ровно как у погибшего бота. Фраг всё равно должен быть именным.
  const room = new Room();
  const victim = room.add('Жертва', noop);
  const shooter = room.add('Стрелок', noop);
  room.setup(MODE_DM, undefined, false);
  run(room, 1);

  duel(victim, shooter);
  run(room, 1, [shooter]);
  check('снаряд ушедшего стрелка в воздухе', room.shellCount === 1);

  const name = shooter.name;
  room.remove(shooter.id);
  run(room, Math.round(0.6 * TICK_HZ));

  check('снаряд отключившегося стрелка попал', victim.dead);
  const feed = room.drainKills();
  check(
    `фраг записан на имя стрелявшего, а не на «Неизвестный» (${feed[0]?.killer ?? '—'})`,
    feed.length > 0 && feed[0].killer === name,
  );

  run(room, Math.round(SHELL_LIFETIME * TICK_HZ) + 2);
  check('имя ушедшего не держится в памяти дольше его снарядов', room.ghostCount === 0);
}

{
  // Бонус на урон снаряд уносит с собой: он выстрелен усиленным, и то, что эффект
  // кончился за время полёта, попадание уже не ослабляет.
  const room = new Room();
  const victim = room.add('Жертва', noop);
  const shooter = room.add('Стрелок', noop);
  room.setup(MODE_DM, undefined, true);
  run(room, 1);

  duel(victim, shooter);
  victim.hp = MAX_HP;
  dropOn(room, shooter, BONUS_DAMAGE);
  run(room, 1, [shooter]);

  // Снимаем усиление сразу после выстрела — снаряд ещё летит.
  shooter.fx.fill(0);
  run(room, Math.round(0.6 * TICK_HZ));
  check('усиленный снаряд не слабеет в полёте', victim.hp <= MAX_HP - Math.round(SHELL_DAMAGE * 1.5));
}

// --- Смена карты ---

{
  const room = new Room();
  const player = room.add('Игрок', noop);
  const sent: string[] = [];
  const watched = new Room((msg) => sent.push(msg.t));
  watched.add('Игрок', noop);

  check('стартовая карта — первая', room.mapId === 0);
  const before = room.obstacles;

  room.setup(undefined, undefined, undefined, 2);
  check('карта переключилась', room.mapId === 2);
  check('геометрия пересобрана', room.obstacles !== before);
  check('это действительно другая карта', room.obstacles.length === buildMap(2).length);

  watched.setup(undefined, undefined, undefined, 2);
  check('клиентам ушла новая геометрия', sent.includes('map'));

  run(room, 2);
  const spot = spawnPoint(0, 2);
  check(
    'игрок перенесён на спавн новой карты',
    room.obstacles.every(
      (box) =>
        Math.abs(player.state.x - box.x) > box.w / 2 ||
        Math.abs(player.state.z - box.z) > box.d / 2,
    ) && Number.isFinite(spot.x),
  );

  room.setup(undefined, undefined, undefined, 99);
  check('несуществующая карта игнорируется', room.mapId === 2);
}

// --- Боты не застревают в блоках, и так на каждой карте ---

for (let id = 0; id < MAP_NAMES.length; id++) {
  const room = new Room();
  const heroes = [room.add('Первый', noop), room.add('Второй', noop)];
  room.setup(MODE_PVE, 2, false, id);
  run(room, 6 * TICK_HZ);

  let samples = 0;
  let stalled = 0;
  for (let i = 0; i < 25 * TICK_HZ; i++) {
    // Людей держим в строю: без них забег кончится и мерить будет нечего.
    for (const hero of heroes) {
      hero.hp = MAX_HP;
      hero.dead = false;
      hero.waiting = false;
    }
    run(room, 1);
    for (const bot of bots(room)) {
      if (bot.dead) continue;
      samples++;
      if (Math.abs(bot.state.speed) < 1.5) stalled++;
    }
  }

  const share = (stalled / Math.max(1, samples)) * 100;
  check(`«${MAP_NAMES[id]}»: боты едут, а не упираются (в упоре ${share.toFixed(0)}%)`, share < 40);
  check(`«${MAP_NAMES[id]}»: боты на карте живы`, samples > 0);
}

// --- Одна жизнь на волну ---

{
  const room = new Room();
  const victim = room.add('Жертва', noop);
  const shooter = room.add('Стрелок', noop);
  room.setup(MODE_PVE, 0, false);
  run(room, 2);
  duel(victim, shooter);

  run(room, Math.round(1.2 * TICK_HZ), [shooter]);
  check('огонь по своим работает: союзник уничтожен', victim.dead);
  check('выбывший ждёт конца волны', victim.waiting);

  run(room, Math.round((RESPAWN_S + 1) * TICK_HZ));
  check('во время волны выбывший не возрождается', victim.dead && victim.waiting);

  wipeWave(room);
  run(room, Math.round(WAVE_BREAK_S * TICK_HZ) + 4);
  check('следующая волна вернула его в строй', !victim.dead && !victim.waiting);
}

// --- Все пали: конец забега и рестарт с первой волны ---

{
  const room = new Room();
  const victim = room.add('Жертва', noop);
  const shooter = room.add('Стрелок', noop);
  room.setup(MODE_PVE, 0, false);
  run(room, 2);

  duel(victim, shooter);
  run(room, Math.round(1.2 * TICK_HZ), [shooter]);

  // Стрелок выходит из игры — живых людей не осталось.
  room.remove(shooter.id);
  run(room, 2);
  check('все выбыли — забег окончен', room.waveState().phase === 'over');
  check('карта очищена от ботов', bots(room).length === 0);
  check('хост передан оставшемуся игроку', room.hostId === victim.id);

  run(room, 9 * TICK_HZ);
  check('после экрана итогов забег начался с первой волны', room.waveState().wave === 1);
  check('павший снова в бою', !victim.dead);
}

// --- Смена режима ---

{
  const room = new Room();
  const player = room.add('Игрок', noop);
  room.setup(MODE_PVE, 3, false);
  // Игрок неподвижен, а боты здесь тира «Ас»: за восемь секунд они его дожимают,
  // забег кончается и карта чистится. Проверяем-то мы не это, поэтому держим
  // его в строю — иначе проверка падала бы примерно раз в десять запусков.
  for (let i = 0; i < 8 * TICK_HZ; i++) {
    run(room, 1);
    player.hp = MAX_HP;
    player.dead = false;
    player.waiting = false;
  }
  check('сложность применилась', room.difficulty === 3);
  check('боты на карте есть', bots(room).length > 0);

  room.setup(MODE_DM, undefined, false);
  run(room, 2);
  check('в режиме «все против всех» ботов нет', bots(room).length === 0);
  check('волны остановлены', room.waveState().wave === 0);

  player.hp = 25;
  run(room, 2);
  check('в DM игрок остаётся в бою', !player.dead);
}

// --- Рикошетный выстрел находится и действительно попадает ---

{
  const obstacles = buildMap();
  // По разные стороны блока (0, 48) и близко к северной стене: прямой наводкой
  // цели нет, зато вдоль стены снаряд уходит под пологим углом и возвращается.
  const me = createTankState(-35, 48, 0);
  const target = createTankState(35, 48, 0);

  const direct = Math.atan2(target.x - me.x, target.z - me.z);
  const shooter: ShellState = {
    id: 0,
    owner: -1,
    x: me.x,
    z: me.z,
    vx: target.x - me.x,
    vz: target.z - me.z,
    life: 1,
    bounces: 0,
  };
  check('прямой наводкой цель закрыта укрытием', sweepShell(shooter, 1, obstacles) !== null);

  const angle = findBankShot(me, target, obstacles);
  check('за укрытием найден выстрел с отскоком', angle !== null);
  check('найденный угол — не прямой выстрел', angle === null || Math.abs(angle - direct) > 0.05);
}

// --- Бонусы ---

/** Кладёт ящик нужного вида прямо под гусеницы игроку. */
function dropOn(room: Room, player: Player, kind: number): void {
  room.bonuses.length = 0;
  room.bonuses.push({
    id: 9000 + kind,
    kind,
    x: player.state.x,
    z: player.state.z,
    until: room.tickCount + 10 * TICK_HZ,
  });
}

{
  const room = new Room();
  const hero = room.add('Игрок', noop);
  room.setup(MODE_DM, undefined, true);

  run(room, 2);
  check('бонусы включены — ящик появился на карте', room.bonusCount > 0);
  const spot = room.bonuses[0];
  const inWall = buildMap().some(
    (box) => Math.abs(spot.x - box.x) < box.w / 2 && Math.abs(spot.z - box.z) < box.d / 2,
  );
  check('ящик не лежит внутри препятствия', !inWall);

  // Ремонт.
  hero.hp = 30;
  dropOn(room, hero, BONUS_HEAL);
  run(room, 1);
  check('ремонт подобран', room.bonusCount === 0);
  check('ремонт вернул здоровье', hero.hp === 30 + BONUS_HEAL_HP);

  hero.hp = MAX_HP - 10;
  dropOn(room, hero, BONUS_HEAL);
  run(room, 1);
  check('ремонт не поднимает выше максимума', hero.hp === MAX_HP);
}

{
  // Ход: тот же газ за то же время должен унести дальше. Едем по чистому коридору
  // z = 35, иначе оба танка упрутся в блок и разницы не будет видно.
  const drive = (withBonus: boolean): number => {
    const room = new Room();
    const tank = room.add('Ездок', noop);
    if (withBonus) {
      room.setup(MODE_DM, undefined, true);
      tank.state = createTankState(-32, 35, Math.PI / 2);
      dropOn(room, tank, BONUS_SPEED);
      room.update();
    } else {
      tank.state = createTankState(-32, 35, Math.PI / 2);
    }
    const from = tank.state.x;
    for (let i = 0; i < 40; i++) {
      room.pushInput(tank, {
        seq: room.tickCount + 1,
        throttle: 1,
        steer: 0,
        turret: tank.state.turret,
      });
      room.update();
    }
    return Math.abs(tank.state.x - from);
  };

  check('бонус «Ход» реально ускоряет танк', drive(true) > drive(false) * 1.15);
}

{
  // Урон.
  const room = new Room();
  const victim = room.add('Жертва', noop);
  const shooter = room.add('Стрелок', noop);
  room.setup(MODE_DM, undefined, true);
  run(room, 1);

  duel(victim, shooter);
  victim.hp = MAX_HP;
  dropOn(room, shooter, BONUS_DAMAGE);
  run(room, Math.round(1.2 * TICK_HZ), [shooter]);
  check('бонус «Урон» бьёт сильнее обычного', victim.hp < MAX_HP - SHELL_DAMAGE);
}

{
  // Заряжание: считаем сделанные выстрелы, а не снаряды в воздухе — первый
  // за две секунды успевает долететь до стены и исчезнуть.
  const shots = (withBonus: boolean): number => {
    const room = new Room();
    const gunner = room.add('Стрелок', noop);
    if (withBonus) {
      room.setup(MODE_DM, undefined, true);
      gunner.state = createTankState(-32, 35, Math.PI / 2);
      dropOn(room, gunner, BONUS_RELOAD);
      room.update();
    } else {
      gunner.state = createTankState(-32, 35, Math.PI / 2);
    }

    const seen = new Set<number>();
    for (let i = 0; i < 2 * TICK_HZ; i++) {
      room.pushInput(gunner, {
        seq: room.tickCount + 1,
        throttle: 0,
        steer: 0,
        turret: gunner.state.turret,
        fire: true,
      });
      room.update();
      for (const shell of room.snapshotShells()) seen.add(shell.i);
    }
    return seen.size;
  };

  const fast = shots(true);
  const plain = shots(false);
  check(`бонус «Заряжание» даёт выстрелить чаще (${fast} против ${plain})`, fast > plain);
}

{
  // Ящики — только людям, и выключение чистит карту вместе с эффектами.
  const room = new Room();
  const hero = room.add('Игрок', noop);
  room.setup(MODE_PVE, 0, true);
  run(room, 4 * TICK_HZ);

  const bot = bots(room)[0];
  room.bonuses.length = 0;
  room.bonuses.push({
    id: 1,
    kind: BONUS_SPEED,
    x: bot.state.x,
    z: bot.state.z,
    until: room.tickCount + 10 * TICK_HZ,
  });
  run(room, 1);
  check('бот ящик не подбирает', room.bonusCount === 1);

  dropOn(room, hero, BONUS_STEALTH);
  // Два тика: флаг маскировки для ботов кэшируется в начале тика, то есть
  // становится виден им со следующего после подбора.
  run(room, 2);
  check('маскировка отмечена на игроке', hero.stealth);

  room.setup(undefined, undefined, false);
  run(room, 1);
  check('выключение бонусов чистит карту', room.bonusCount === 0);
  check('выключение бонусов снимает эффекты', !hero.stealth && hero.fx.every((v) => v === 0));
}

{
  // Смерть сжигает набранные усиления.
  const room = new Room();
  const victim = room.add('Жертва', noop);
  const shooter = room.add('Стрелок', noop);
  room.setup(MODE_DM, undefined, true);
  run(room, 1);

  duel(victim, shooter);
  dropOn(room, victim, BONUS_SPEED);
  run(room, 1);
  check('бонус подобран перед смертью', victim.fx[BONUS_SPEED] > 0);

  run(room, Math.round(1.2 * TICK_HZ), [shooter]);
  check('уничтоженный танк теряет эффекты', victim.dead && victim.fx.every((v) => v === 0));
}

// --- Бот тоньше игрока: три попадания вместо четырёх ---

{
  const room = new Room();
  room.add('Игрок', noop);
  room.setup(MODE_PVE, 0, false);
  run(room, 8 * TICK_HZ);

  const bot = bots(room)[0];
  check('бот вышел с уменьшенным запасом здоровья', bot !== undefined && bot.hp === BOT_HP);
  check('бота убивают три попадания, а игрока четыре', Math.ceil(BOT_HP / SHELL_DAMAGE) === 3 && Math.ceil(MAX_HP / SHELL_DAMAGE) === 4);
  // Спрашиваем у того, кто только что зашёл: первый простоял под огнём восемь
  // секунд, и его текущее здоровье говорит об удаче ботов, а не о запасе людей.
  check('у человека запас прежний', room.add('Второй', noop).hp === MAX_HP);
}

// --- Манера боя: та же выучка, другая дистанция ---

/**
 * Средняя дистанция, на которой боты держатся от игрока. Человек стоит на месте,
 * поэтому число зависит только от манеры, а не от того, кто кого переехал.
 */
function holdDistance(stance: number): number {
  const room = new Room();
  const hero = room.add('Игрок', noop);
  room.setup(MODE_PVE, 1, false, 0, stance);
  hero.state = createTankState(0, 0, 0);

  // Первые секунды боты едут от спавнов на краю карты — это дорога, а не манера.
  const warmup = 10 * TICK_HZ;
  let sum = 0;
  let samples = 0;
  for (let i = 0; i < warmup + 40 * TICK_HZ; i++) {
    // Держим человека живым и на месте: меряем поведение ботов, а не бой.
    hero.hp = MAX_HP;
    hero.dead = false;
    hero.state = createTankState(0, 0, 0);
    // И ботов тоже: их промахи прилетают друг в друга, квота волны утекает,
    // и к концу прогона замер шёл бы по двум выжившим вместо полной карты.
    for (const bot of bots(room)) {
      bot.hp = BOT_HP;
      bot.dead = false;
    }
    run(room, 1);
    if (i < warmup) continue;
    for (const bot of bots(room)) {
      sum += Math.hypot(bot.state.x, bot.state.z);
      samples++;
    }
  }
  return samples > 0 ? sum / samples : 0;
}

{
  const far = holdDistance(0);
  const neutral = holdDistance(1);
  const close = holdDistance(2);
  console.log(
    `
Средняя дистанция до игрока: ${STANCE_NAMES[0]} ${far.toFixed(1)} м, ` +
      `${STANCE_NAMES[1]} ${neutral.toFixed(1)} м, ${STANCE_NAMES[2]} ${close.toFixed(1)} м`,
  );
  check('«Дистанция» держит ботов дальше нейтральной манеры', far > neutral + 3);
  check('«Напор» подводит ботов ближе нейтральной манеры', close < neutral - 3);
  check('на «Дистанции» боты не подходят вплотную', far > 30);

  const room = new Room();
  room.add('Игрок', noop);
  room.setup(MODE_PVE, 1, false, 0, 2);
  check('манера доезжает до настроек комнаты', room.config().stance === 2);
  room.setup(undefined, undefined, undefined, undefined, 0);
  check('манера переключается отдельно от сложности', room.config().stance === 0 && room.config().difficulty === 1);
}

// --- Цена тика с полной картой ботов ---

{
  const room = new Room();
  // Четверо людей: потолок одновременных ботов считается от их числа.
  for (const name of ['Первый', 'Второй', 'Третий', 'Четвёртый']) room.add(name, noop);
  room.setup(MODE_PVE, 2, false);

  // Замер должен идти при полной карте, поэтому бессмертны здесь все. Люди —
  // иначе боты дожмут их, забег кончится и мерить будет нечего. Боты — потому
  // что промахи прилетают друг в друга: за минуту прогона квота волны утекала
  // в чужие фраги, и на карте оставалось меньше десятка.
  const revive = () => {
    for (const tank of room.players.values()) {
      tank.hp = MAX_HP;
      tank.dead = false;
      tank.waiting = false;
    }
  };

  // Быстро добираемся до крупных волн: пока идёт перемотка, каждый вышедший бот
  // тут же снимается с карты, иначе квота упрётся в потолок одновременных.
  let guard = 0;
  while (room.waveState().wave < 8 && guard++ < 60_000) {
    run(room, 1);
    revive();
    for (const bot of bots(room)) room.players.delete(bot.id);
  }
  for (let i = 0; i < 40 * TICK_HZ; i++) {
    run(room, 1);
    revive();
  }
  const count = bots(room).length;
  check('к восьмой волне карта заполнена под потолок', count >= 10);

  const started = performance.now();
  for (let i = 0; i < 600; i++) {
    run(room, 1);
    revive();
  }
  const perTick = (performance.now() - started) / 600;
  const budget = 1000 / TICK_HZ;
  console.log(
    `\nТик с ${count} ботами: ${perTick.toFixed(3)} мс при бюджете ${budget.toFixed(1)} мс ` +
      `(${((perTick / budget) * 100).toFixed(1)}% ядра)`,
  );
  check('тик укладывается в десятую часть бюджета', perTick < budget / 10);
}

// --- Реакция: бот наводится на устаревшее место цели ---
//
// Это и есть вся разница уровней по едущей цели, и проверять её надо прямо на
// think(): в бою она видна только как «мажет чаще», а такую метрику стенд
// измерял бы часами и всё равно плавал бы от случая к случаю.
{
  const RANGE = 40;
  const CROSS = 12; // цель идёт поперёк линии огня, м/с

  /** Насколько мимо смотрит ствол: расстояние до точки, где цель будет к подлёту. */
  const missOf = (tier: number, speed: number): number => {
    const brain = createBrain(tier, 0, 0);
    const me = { id: 1, team: 0, dead: false, stealth: false, state: createTankState(0, 0, 0), hp: BOT_HP, brain };
    const foe = { id: 2, team: 1, dead: false, stealth: false, state: createTankState(0, RANGE, Math.PI / 2) };
    foe.state.speed = speed;
    const world = { tick: 0, obstacles: [], cover: [], tanks: [me, foe] };

    // Полсекунды: столько цель успевает проехать между двумя мыслями новичка.
    for (let i = 0; i <= Math.round(TICK_HZ / 2); i++) {
      world.tick = i;
      if (i > 0) foe.state.x += speed / TICK_HZ;
      think(me, world);
    }

    // Куда снаряд придёт, если выстрелить сейчас, — с этим и сравниваем прицел.
    const flight = Math.hypot(foe.state.x, foe.state.z) / SHELL_SPEED;
    return Math.hypot(brain.aimX - (foe.state.x + speed * flight), brain.aimZ - foe.state.z);
  };

  const rookie = missOf(0, CROSS);
  const ace = missOf(MAX_TIER, CROSS);
  check('новичок наводится в устаревшее место', rookie > TANK_RADIUS * 2);
  check('ас держит цель точно', ace < TANK_RADIUS);
  check('чем выше тир, тем меньше промах', rookie > ace);
  // По стоящей цели устаревшее место совпадает с настоящим: реакция наказывает
  // только за движение, и стоять на месте от неё выгоднее не становится.
  check('по стоящей цели промаха от реакции нет', missOf(0, 0) < 1e-9);
  console.log(
    `\nПрицел мимо точки подлёта при цели на ${CROSS} м/с: новичок ${rookie.toFixed(1)} м, ` +
      `ас ${ace.toFixed(1)} м (радиус танка ${TANK_RADIUS} м)`,
  );
}

// --- Итог ---

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? '  ok' : 'FAIL'}  ${label}`);
}
console.log(`\n${checks.length - failed} из ${checks.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
