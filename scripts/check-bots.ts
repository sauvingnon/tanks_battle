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
  BOTS_PER_HUMAN,
  MAX_HP,
  MODE_DM,
  MODE_PVE,
  RESPAWN_S,
  SHELL_DAMAGE,
  SHELL_LIFETIME,
  TICK_HZ,
  WAVE_BREAK_S,
  waveConcurrent,
  waveQuota,
} from '../src/shared/constants.js';
import { buildMap, MAP_NAMES, spawnPoint } from '../src/shared/map.js';
import { sweepShell } from '../src/shared/sim.js';
import { createTankState, type ShellState } from '../src/shared/types.js';
import { findBankShot } from '../src/server/bot.js';
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
    'на одного игрока на карте не больше трёх ботов',
    bots(room).length === waveConcurrent(1, 1) && bots(room).length === BOTS_PER_HUMAN,
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
  check('одновременно на карте не больше лимита волны', bots(room).length <= waveConcurrent(2, 1));
}

// --- Потолок ботов растёт вместе с числом игроков ---

{
  const room = new Room();
  room.add('Первый', noop);
  room.add('Второй', noop);
  room.setup(MODE_PVE, 0, false);
  run(room, 8 * TICK_HZ);
  check('вдвоём на карте помещается больше ботов', bots(room).length > BOTS_PER_HUMAN);
  check('но не больше трёх на каждого', bots(room).length <= 2 * BOTS_PER_HUMAN);
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
  run(room, 8 * TICK_HZ);
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

// --- Цена тика с полной картой ботов ---

{
  const room = new Room();
  const heroes = [
    room.add('Первый', noop),
    room.add('Второй', noop),
    room.add('Третий', noop),
    room.add('Четвёртый', noop),
  ];
  room.setup(MODE_PVE, 2, false);

  // Замер должен идти при полной карте, поэтому людей держим бессмертными:
  // иначе боты дожмут их, забег кончится и мерить будет нечего.
  const revive = () => {
    for (const hero of heroes) {
      hero.hp = MAX_HP;
      hero.dead = false;
      hero.waiting = false;
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

// --- Итог ---

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? '  ok' : 'FAIL'}  ${label}`);
}
console.log(`\n${checks.length - failed} из ${checks.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
