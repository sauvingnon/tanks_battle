/**
 * Стенд для настройки волн: чем на самом деле отличаются уровни сложности.
 * Запуск: npm run bench:pve
 *
 * Меряется не «ощущение», а входящий урон и время жизни. В комнату сажается
 * «герой» — человек, которого водит тот же think() тира «Ас»: это верхняя планка
 * того, как вообще можно играть. Если волну не проходит даже он, живому игроку
 * там делать нечего.
 *
 * Переменные окружения: MAP (индекс карты, по умолчанию все), STANCE (манера боя,
 * по умолчанию нейтральная), HERO (тир героя), RUNS, LIMIT.
 */
import { DIFFICULTY_NAMES, MAX_HP, MODE_PVE, STANCE_NAMES, STANCE_NEUTRAL, TICK_HZ } from '../src/shared/constants.js';
import { MAP_NAMES } from '../src/shared/map.js';
import { createBrain, think, type BotSelf } from '../src/server/bot.js';
import { Room, type Player } from '../src/server/room.js';

const noop = () => {};

function bots(room: Room): Player[] {
  return [...room.players.values()].filter((p) => p.brain);
}

interface Result {
  /** Секунд прожил на первой волне. */
  life: number;
  /** Входящий урон в секунду. */
  dps: number;
  /** Сколько ботов успел подбить за забег. */
  frags: number;
  /** Сколько раз успел выстрелить. */
  shots: number;
  /** Средняя толпа на карте. */
  crowd: number;
  /** До какой волны дошёл забег. */
  wave: number;
}

function runGame(mapId: number, difficulty: number, stance: number): Result {
  const room = new Room(noop);
  room.setup(MODE_PVE, difficulty, false, mapId, stance);
  const hero = room.add('Герой', noop);
  const brain = createBrain(heroTier, 0, 0);
  // Именно объект, а не players.values(): think() проходит по танкам несколько раз
  // за тик, и одноразовый итератор он вычерпает на выборе цели.
  const tanks: Iterable<Player> = { [Symbol.iterator]: () => room.players.values() };

  let ticks = 0;
  let taken = 0;
  let crowd = 0;
  let firstWaveLife = 0;
  let hp = MAX_HP;
  let shots = 0;
  let heroReady = 0;

  for (; ticks < limitTicks; ticks++) {
    const self: BotSelf = {
      id: hero.id,
      team: hero.team,
      dead: hero.dead,
      stealth: false,
      state: hero.state,
      hp: hero.hp,
      brain,
      suppressed: room.tickCount < hero.suppressedUntil,
    };
    const input = think(self, {
      tick: room.tickCount,
      obstacles: room.obstacles,
      cover: room.cover,
      bushes: room.bushes,
      tanks,
      shells: room.liveShells,
      stance,
      // В тех же стенах: с чужим размером карты герой на большой карте не видел
      // бы ни одного выстрела — свип гасил бы луч о стену, которой там нет.
      half: room.half,
    });
    room.pushInput(hero, { ...input, seq: room.tickCount + 1 });
    room.update();

    // Выстрел виден по прыжку readyAt: своего счётчика у комнаты нет.
    if (hero.readyAt > heroReady) shots++;
    heroReady = hero.readyAt;

    if (hero.hp < hp) taken += hp - hero.hp;
    hp = hero.hp;
    crowd += bots(room).length;

    const wave = room.waveState();
    if (wave.wave <= 1 && !hero.dead) firstWaveLife = ticks;
    if (wave.phase === 'over') break;
  }

  return {
    life: firstWaveLife / TICK_HZ,
    dps: taken / Math.max(ticks / TICK_HZ, 1e-6),
    frags: hero.kills,
    shots,
    crowd: crowd / Math.max(ticks, 1),
    wave: room.waveState().best || room.waveState().wave,
  };
}

function average(list: Result[]): Result {
  const sum = (pick: (r: Result) => number) => list.reduce((a, r) => a + pick(r), 0) / list.length;
  return {
    life: sum((r) => r.life),
    dps: sum((r) => r.dps),
    frags: sum((r) => r.frags),
    shots: sum((r) => r.shots),
    crowd: sum((r) => r.crowd),
    wave: sum((r) => r.wave),
  };
}

const heroTier = Number(process.env.HERO ?? 3);
const stance = Number(process.env.STANCE ?? STANCE_NEUTRAL);
const runs = Number(process.env.RUNS ?? 6);
const limitTicks = Math.round(Number(process.env.LIMIT ?? 240) * TICK_HZ);
const onlyMap = process.env.MAP === undefined ? -1 : Number(process.env.MAP);

console.log(
  `Герой играет на уровне «${DIFFICULTY_NAMES[heroTier]}», манера боя «${STANCE_NAMES[stance]}», ` +
    `${runs} забегов на клетку.\n`,
);

for (let mapId = 0; mapId < MAP_NAMES.length; mapId++) {
  if (onlyMap >= 0 && mapId !== onlyMap) continue;
  console.log(`--- ${MAP_NAMES[mapId]} ---`);
  console.log('сложность      волна   жизнь-1   вх.урон/с   фрагов   выстрелов   толпа');
  for (let d = 0; d < DIFFICULTY_NAMES.length; d++) {
    const list: Result[] = [];
    for (let i = 0; i < runs; i++) list.push(runGame(mapId, d, stance));
    const a = average(list);
    console.log(
      DIFFICULTY_NAMES[d].padEnd(12) +
        a.wave.toFixed(1).padStart(6) +
        a.life.toFixed(1).padStart(10) +
        a.dps.toFixed(1).padStart(12) +
        a.frags.toFixed(1).padStart(9) +
        a.shots.toFixed(1).padStart(12) +
        a.crowd.toFixed(1).padStart(8),
    );
  }
  console.log('');
}
