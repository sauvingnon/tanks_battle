/**
 * Проверка боевой логики на настоящем классе Room, без сети и браузера.
 * Запуск: npm run check:combat
 *
 * Танки расставляются вручную: нас интересуют попадания, урон, перезарядка,
 * укрытия и респавн, а не то, куда игрока закинул спавн.
 */
import {
  MAX_HP,
  RELOAD_S,
  RESPAWN_S,
  SHELL_DAMAGE,
  SHELL_SPEED,
  TICK_HZ,
} from '../src/shared/constants.js';
import { BOOM_GROUND, BOOM_HIT, BOOM_KILL, type BoomKind } from '../src/shared/types.js';
import { Room, type Player } from '../src/server/room.js';

const checks: Array<[string, boolean]> = [];
const check = (label: string, ok: boolean) => checks.push([label, ok]);

/** Ставит танк в заданную точку и разворачивает корпус и башню по углу. */
function place(player: Player, x: number, z: number, angle: number): void {
  player.state.x = x;
  player.state.z = z;
  player.state.angle = angle;
  player.state.turret = angle;
  player.state.speed = 0;
}

let seq = 0;

/** Прогоняет комнату N тиков, всё это время держа игроков неподвижно. */
function run(room: Room, ticks: number, firing: Player[] = []): BoomKind[] {
  const seen: BoomKind[] = [];
  for (let i = 0; i < ticks; i++) {
    seq++;
    for (const player of room.players.values()) {
      room.pushInput(player, {
        seq,
        throttle: 0,
        steer: 0,
        turret: player.state.turret,
        fire: firing.includes(player),
      });
    }
    room.update();
    for (const boom of room.boomEvents) seen.push(boom.k);
  }
  return seen;
}

const noop = () => {};

// --- 1. Прямое попадание ---
{
  const room = new Room();
  const shooter = room.add('Стрелок', noop);
  const target = room.add('Мишень', noop);
  // Свободный коридор: на x = 30 между z = 40 и z = 55 препятствий нет.
  place(shooter, 30, 40, 0); // угол 0 смотрит в +Z
  place(target, 30, 58, Math.PI);

  const booms = run(room, 1, [shooter]);
  check('выстрел рождает снаряд', room.shellCount === 1);
  check('в момент выстрела взрыва нет', booms.length === 0);

  // 18 м на 62 м/с — примерно 9 тиков; берём с запасом.
  const flight = run(room, 15);
  check('снаряд снял 25 HP', target.hp === MAX_HP - SHELL_DAMAGE);
  check('было событие попадания', flight.includes(BOOM_HIT));
  check('снаряд исчез после попадания', room.shellCount === 0);
  check('стрелявший цел', shooter.hp === MAX_HP);
}

// --- 2. Перезарядка ---
{
  const room = new Room();
  const shooter = room.add('Стрелок', noop);
  // Колонна x = 30 свободна на всю карту: снаряд летит долго и не мешает счёту.
  place(shooter, 30, -20, 0);

  run(room, 1, [shooter]);
  run(room, 2, [shooter]); // жмём на спуск сразу же
  check('перезарядка не даёт стрелять очередью', room.shellCount === 1);

  const reloadTicks = Math.round(RELOAD_S * TICK_HZ);
  run(room, reloadTicks);
  run(room, 1, [shooter]);
  // Первый снаряд к этому моменту долетел до стены и взорвался.
  check('после перезарядки выстрел проходит', room.shellCount === 1);
}

// --- 3. Четыре попадания убивают, дальше респавн ---
{
  const room = new Room();
  const shooter = room.add('Стрелок', noop);
  const target = room.add('Мишень', noop);

  let kills: Array<{ killer: string; victim: string }> = [];
  const reloadTicks = Math.round(RELOAD_S * TICK_HZ);

  for (let shot = 0; shot < 4; shot++) {
    // Танки могли сдвинуться от расталкивания — возвращаем на позиции.
    place(shooter, 30, 40, 0);
    place(target, 30, 58, Math.PI);
    run(room, 1, [shooter]);
    run(room, reloadTicks);
    kills = kills.concat(room.drainKills());
  }

  check('четыре попадания = 0 HP', target.hp === 0);
  check('танк помечен уничтоженным', target.dead);
  check('фраг записан стрелявшему', shooter.kills === 1 && target.deaths === 1);
  check(
    'фраг ушёл в ленту с именами',
    kills.length === 1 && kills[0].killer === 'Стрелок' && kills[0].victim === 'Мишень',
  );

  // Уничтоженный танк не двигается, даже если клиент шлёт газ.
  const frozenX = target.state.x;
  seq++;
  room.pushInput(target, { seq, throttle: 1, steer: 1, turret: 0, fire: true });
  room.update();
  check('подбитый танк не едет', target.state.x === frozenX);
  check('подбитый танк не стреляет', room.shellCount === 0);

  run(room, Math.round(RESPAWN_S * TICK_HZ) + 2);
  check('танк вернулся в бой', !target.dead && target.hp === MAX_HP);
}

// --- 4. Укрытие держит снаряд ---
{
  const room = new Room();
  const shooter = room.add('Стрелок', noop);
  const target = room.add('Мишень', noop);
  // Между ними блок из buildMap(): add(0, 48, 10, 6, 3).
  place(shooter, 0, 40, 0);
  place(target, 0, 58, Math.PI);

  // Блок стоит в 1 м от дульного среза, поэтому взрыв успевает произойти
  // в тот же тик, что и выстрел, — собираем события обоих прогонов.
  const booms = [...run(room, 1, [shooter]), ...run(room, 15)];
  check('препятствие остановило снаряд', target.hp === MAX_HP);
  check('взрыв произошёл о препятствие', booms.includes(BOOM_GROUND));
}

// --- 5. Снаряд не проскакивает сквозь тонкий блок ---
{
  // За тик снаряд пролетает SHELL_SPEED / TICK_HZ метров: это должно быть заметно
  // меньше самого тонкого препятствия, иначе подшагов не хватит.
  const perTick = SHELL_SPEED / TICK_HZ;
  check(`шаг снаряда ${perTick.toFixed(1)} м меньше тонкого блока (4 м)`, perTick < 4);
}

// --- 6. Уничтожение видно как отдельное событие ---
{
  const room = new Room();
  const shooter = room.add('Стрелок', noop);
  const target = room.add('Мишень', noop);
  target.hp = SHELL_DAMAGE; // добиваем с одного выстрела
  place(shooter, 30, 40, 0);
  place(target, 30, 58, Math.PI);

  run(room, 1, [shooter]);
  const booms = run(room, 15);
  check('смерть приходит событием BOOM_KILL', booms.includes(BOOM_KILL));
  check('обычного попадания при добивании нет', !booms.includes(BOOM_HIT));
}

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
}
console.log(failed === 0 ? 'COMBAT OK' : `COMBAT FAILED: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
