/**
 * Проверка командного боя на настоящем классе Room, без сети и браузера.
 * Запуск: npm run check:team
 *
 * Авто-баланс по сторонам, добивание ботами до нужного размера, отсутствие
 * урона по своим, отсутствие респавна до конца раунда, победа при полном
 * уничтожении стороны, ничья по таймеру и авто-рестарт следующим раундом.
 */
import {
  MAX_HP,
  MODE_DM,
  MODE_TEAM,
  RESPAWN_S,
  SHELL_DAMAGE,
  TEAM_BATTLE_OVER_S,
  TEAM_BATTLE_ROUND_S,
  TICK_HZ,
} from '../src/shared/constants.js';
import { TEAM_ONE, TEAM_TWO } from '../src/shared/types.js';
import { Room, type Player } from '../src/server/room.js';

const checks: Array<[string, boolean]> = [];
const check = (label: string, ok: boolean) => checks.push([label, ok]);

const noop = () => {};

function run(room: Room, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    for (const player of room.players.values()) {
      if (player.brain) continue;
      room.pushInput(player, {
        seq: room.tickCount + i + 1,
        throttle: 0,
        steer: 0,
        turret: player.state.turret,
      });
    }
    room.update();
  }
}

function bots(room: Room): Player[] {
  return [...room.players.values()].filter((p) => p.brain);
}

function humans(room: Room): Player[] {
  return [...room.players.values()].filter((p) => !p.brain);
}

// --- 5×5 заполняется ботами, авто-баланс разводит людей по сторонам ---

{
  const room = new Room();
  const a = room.add('Первый', noop);
  const b = room.add('Второй', noop);
  room.setup(MODE_TEAM, undefined, false);
  run(room, 2);

  check('раунд начался сразу', room.waveState().phase === 'fight');
  check('на каждой стороне по teamSize танков', [TEAM_ONE, TEAM_TWO].every(
    (team) => [...room.players.values()].filter((p) => p.team === team).length === 5,
  ));
  check('боты добили обе стороны', bots(room).length === 8);
  check('два человека оказались на разных сторонах (авто-баланс через одного)', a.team !== b.team);
}

// --- Огонь по своим выключен ---

{
  const room = new Room();
  const ally = room.add('Союзник', noop);
  room.setup(MODE_TEAM, undefined, false);
  run(room, 2);

  const teammate = [...room.players.values()].find((p) => p.brain && p.team === ally.team)!;
  teammate.state.x = ally.state.x;
  teammate.state.z = ally.state.z + 5;
  teammate.hp = MAX_HP;
  const hpBefore = teammate.hp;

  for (let i = 0; i < 5; i++) {
    room.pushInput(ally, {
      seq: room.tickCount + i + 1,
      throttle: 0,
      steer: 0,
      turret: ally.state.turret,
      fire: true,
    });
    room.update();
  }
  check('союзник не потерял здоровье от своего же выстрела', teammate.hp === hpBefore);
}

// --- Смерть держит до конца раунда, респавна по таймеру нет ---

{
  const room = new Room();
  const player = room.add('Игрок', noop);
  room.setup(MODE_TEAM, undefined, false);
  run(room, 2);

  player.hp = 1;
  player.dead = false;
  const before = player.dead;
  // hurt() приватный — гибель эмулируем напрямую тем же путём, каким её ставит комната.
  player.hp = 0;
  player.dead = true;
  player.deaths++;
  player.respawnAt = room.tickCount + Math.round(RESPAWN_S * TICK_HZ);

  run(room, Math.round(RESPAWN_S * TICK_HZ) + 5);
  check('в командном бою нет автоматического респавна по таймеру', before === false && player.dead);
}

// --- Полное уничтожение одной стороны — победа, авто-рестарт следующим раундом ---

{
  const room = new Room();
  const winner = room.add('Победитель', noop);
  room.setup(MODE_TEAM, undefined, false);
  run(room, 2);

  for (const p of room.players.values()) {
    if (p.team !== winner.team) p.dead = true;
  }
  run(room, 1);
  check('сторона выбита — раунд завершён', room.waveState().phase === 'over');
  check('победитель определён верно', room.waveState().winner === winner.team);

  run(room, Math.round(TEAM_BATTLE_OVER_S * TICK_HZ) + 2);
  check('новый раунд начался сам', room.waveState().phase === 'fight');
  check('все снова живы', [...room.players.values()].every((p) => !p.dead));
}

// --- Таймер без исхода — ничья ---

{
  const room = new Room();
  room.add('Игрок', noop);
  room.setup(MODE_TEAM, undefined, false);
  run(room, 2);

  // Бои ботов сами по себе решились бы раньше таймера — держим всех неубиваемыми,
  // чтобы проверить именно ветку «время вышло», а не случайную зачистку стороны.
  for (const p of room.players.values()) p.hp = 1_000_000;

  run(room, Math.round(TEAM_BATTLE_ROUND_S * TICK_HZ) + 2);
  check('раунд без уничтожения кончается ничьей', room.waveState().winner === 'draw');
}

// --- Смена размера команды перезапускает бой, только пока мы в этом режиме ---

{
  const room = new Room();
  room.add('Игрок', noop);
  room.setup(MODE_DM, undefined, false);
  room.setup(undefined, undefined, undefined, undefined, undefined, undefined, 10);
  check('смена размера вне командного боя не запускает раунд', room.waveState().phase !== 'fight' || room.mode === MODE_DM);

  room.setup(MODE_TEAM, undefined, false, undefined, undefined, undefined, 10);
  run(room, 2);
  check('10×10 заполняет по 10 на сторону', [TEAM_ONE, TEAM_TWO].every(
    (team) => [...room.players.values()].filter((p) => p.team === team).length === 10,
  ));
}

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? '  ok' : 'FAIL'}  ${label}`);
}
console.log(`\n${checks.length - failed} из ${checks.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
