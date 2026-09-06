/**
 * Проверка боевой логики на настоящем классе Room, без сети и браузера.
 * Запуск: npm run check:combat
 *
 * Танки расставляются вручную: нас интересуют попадания, урон, перезарядка,
 * укрытия и респавн, а не то, куда игрока закинул спавн.
 */
import {
  DT,
  MAX_BOUNCES,
  MAX_HP,
  RELOAD_S,
  RESPAWN_S,
  RICOCHET_SPEED_KEEP,
  SHELL_DAMAGE,
  SHELL_LIFETIME,
  SHELL_SPEED,
  TICK_HZ,
} from '../src/shared/constants.js';
import { bounceShell, canRicochet, sweepShell } from '../src/shared/sim.js';
import { coverBoxes } from '../src/shared/map.js';
import {
  BOOM_GROUND,
  BOOM_HIT,
  BOOM_KILL,
  BOOM_RICOCHET,
  type BoomKind,
  type ShellState,
} from '../src/shared/types.js';
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

// --- 4б. Низкое укрытие держит танк, но не снаряд ---
{
  const room = new Room();
  const shooter = room.add('Стрелок', noop);
  const target = room.add('Мишень', noop);

  // Своя геометрия вместо карты: один низкий блок ровно между стволом и целью.
  room.obstacles = [{ x: 0, z: 49, w: 20, d: 6, h: 1.5 }];
  room.cover = coverBoxes(room.obstacles);
  check('низкий блок не попал в список укрытий', room.cover.length === 0);

  place(shooter, 0, 40, 0);
  place(target, 0, 58, Math.PI);
  run(room, 1, [shooter]);
  run(room, 15);
  check('снаряд прошёл над низким укрытием', target.hp === MAX_HP - SHELL_DAMAGE);

  // А проехать сквозь него по-прежнему нельзя: столкновения считаются по всем блокам.
  place(shooter, 0, 40, 0);
  for (let i = 0; i < 60; i++) {
    room.pushInput(shooter, {
      seq: room.tickCount + 1,
      throttle: 1,
      steer: 0,
      turret: 0,
    });
    room.update();
  }
  check('через низкое укрытие не проехать', shooter.state.z < 49);
}

// --- 5. Свип находит препятствие и не даёт проскочить сквозь него ---
{
  const obstacles = new Room().obstacles;
  // Блок add(0, 22, 20, 4, 3) занимает z от 20 до 24; с радиусом снаряда — от 19.7.
  const ahead = (): ShellState => ({
    id: 1,
    owner: 1,
    x: 0,
    z: 19,
    vx: 0,
    vz: SHELL_SPEED,
    life: SHELL_LIFETIME,
    bounces: 0,
  });

  const hit = sweepShell(ahead(), DT, obstacles);
  check('свип видит блок впереди', hit !== null);
  check('свип нашёл переднюю грань', hit !== null && hit.nz === -1 && hit.nx === 0);
  // 0.7 м до грани при шаге SHELL_SPEED * DT метров.
  const expected = 0.7 / (SHELL_SPEED * DT);
  check('доля шага до касания посчитана точно', hit !== null && Math.abs(hit.t - expected) < 0.01);

  // Тройной шаг перелетает блок насквозь — свип обязан всё равно найти вход.
  check('свип не проскакивает сквозь тонкий блок', sweepShell(ahead(), DT * 3, obstacles) !== null);
}

// --- 6. Правила рикошета на чистой геометрии ---
{
  // Угол 0 смотрит в +Z, то есть в лоб северной стене; π/2 — вдоль неё.
  const shell = (angle: number, bounces = 0): ShellState => ({
    id: 1,
    owner: 1,
    x: 0,
    z: 0,
    vx: Math.sin(angle) * SHELL_SPEED,
    vz: Math.cos(angle) * SHELL_SPEED,
    life: SHELL_LIFETIME,
    bounces,
  });
  const grazing = Math.PI / 2 - 0.05;
  const northFace = { t: 0, nx: 0, nz: -1, stuck: false };

  check('в лоб рикошета нет', !canRicochet(shell(0), northFace));
  check('под 45° рикошета нет', !canRicochet(shell(Math.PI / 4), northFace));
  check('вдоль стены рикошет есть', canRicochet(shell(grazing), northFace));
  check(
    'исчерпанные отскоки запрещают рикошет',
    !canRicochet(shell(grazing, MAX_BOUNCES), northFace),
  );
  check(
    'изнутри препятствия рикошета нет',
    !canRicochet(shell(grazing), { ...northFace, stuck: true }),
  );

  const s = shell(grazing);
  const speedBefore = Math.hypot(s.vx, s.vz);
  const alongBefore = s.vx;
  bounceShell(s, northFace);
  check('отскок разворачивает только нормальную составляющую', s.vz < 0 && s.vx === alongBefore * RICOCHET_SPEED_KEEP);
  check(
    'отскок гасит скорость',
    Math.abs(Math.hypot(s.vx, s.vz) - speedBefore * RICOCHET_SPEED_KEEP) < 1e-9,
  );
  check('отскок посчитан', s.bounces === 1);
}

// --- 7. Рикошет в бою: пологий выстрел вдоль северной стены ---
{
  const room = new Room();
  const shooter = room.add('Стрелок', noop);
  // Танк прижат к северной стене и стреляет почти вдоль неё: полоса z ≈ 68 пуста.
  place(shooter, -30, 68, Math.PI / 2 - 0.05);

  const booms = [...run(room, 1, [shooter]), ...run(room, 25)];
  check('пологий удар в стену даёт рикошет', booms.includes(BOOM_RICOCHET));
  check('рикошет не взрывает снаряд', !booms.includes(BOOM_GROUND));
  check('после рикошета снаряд летит дальше', room.shellCount === 1);
}

// --- 8. Выстрел в стену в лоб взрывается ---
{
  const room = new Room();
  const shooter = room.add('Стрелок', noop);
  // Колонна x = -30 к северу от z = 60 свободна до самой стены.
  place(shooter, -30, 60, 0);

  const booms = [...run(room, 1, [shooter]), ...run(room, 8)];
  check('удар в лоб взрывает снаряд', booms.includes(BOOM_GROUND));
  check('в лоб рикошета нет и в бою', !booms.includes(BOOM_RICOCHET));
  check('снаряд снят после взрыва', room.shellCount === 0);
}

// --- 9. Уничтожение видно как отдельное событие ---
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
