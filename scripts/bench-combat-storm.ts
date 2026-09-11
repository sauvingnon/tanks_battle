/**
 * Пиковый стенд сервера: 40 живых игроков в DM непрерывно стреляют попарно.
 * Включает полный путь комнаты, урон/смерти и сборку+бинарное кодирование
 * снапшота каждому клиенту — ровно ту нагрузку, которой нет в bench:server.
 * Запуск: npm run bench:combat. Опции: RUNS=5 TICKS=450.
 */
import { performance } from 'node:perf_hooks';
import { MODE_DM, TICK_HZ } from '../src/shared/constants.js';
import { encode, encodeSnapshot, type SnapshotPayload } from '../src/shared/protocol.js';
import { Room, type Player } from '../src/server/room.js';

const playersPerStorm = 40;
const runs = Math.max(1, Number(process.env.RUNS ?? 5));
const ticks = Math.max(60, Number(process.env.TICKS ?? Math.round(TICK_HZ * 15)));
const warmupTicks = TICK_HZ * 3;

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function pushFire(room: Room, players: Player[], seq: number): void {
  for (const player of players) {
    room.pushInput(player, {
      seq,
      throttle: 0,
      steer: 0,
      turret: player.state.turret,
      fire: true,
    });
  }
}

/** Повторяет серверный fan-out из main.ts, но без сокета: меряем CPU и размер пакетов. */
function snapshotFanout(room: Room, players: Player[]): number {
  let bytes = 0;
  // Соответствует оптимизированной ветке main.ts для обычных режимов.
  const entries = room.snapshotEntries();
  const shells = room.shellCount > 0 ? room.snapshotShells() : undefined;
  for (const player of players) {
    const payload: SnapshotPayload = {
      tick: room.tickCount,
      ack: player.ack,
      players: entries,
    };
    if (shells) payload.shells = shells;
    if (room.boomEvents.length > 0) payload.booms = room.boomEvents;
    const hits = room.snapshotHits(player);
    if (hits.length > 0) payload.hits = hits;
    bytes += encodeSnapshot(payload).byteLength;
  }
  return bytes;
}

function prepare(): { room: Room; players: Player[] } {
  const room = new Room(() => {});
  const players = Array.from({ length: playersPerStorm }, (_, index) => room.add(`storm-${index}`, () => {}));
  // Дюны дают достаточно открытых длинных коридоров для параллельных дуэлей.
  room.setup(MODE_DM, 3, false, 6);

  for (let pair = 0; pair < players.length / 2; pair++) {
    const x = (pair % 5) * 24 - 48;
    const z = Math.floor(pair / 5) * 22 - 33;
    const first = players[pair * 2];
    const second = players[pair * 2 + 1];
    first.state.x = x;
    first.state.z = z - 9;
    first.state.angle = 0;
    first.state.turret = 0;
    first.state.speed = 0;
    second.state.x = x;
    second.state.z = z + 9;
    second.state.angle = Math.PI;
    second.state.turret = Math.PI;
    second.state.speed = 0;
  }
  return { room, players };
}

function measure() {
  const { room, players } = prepare();
  let seq = 0;
  for (let tick = 0; tick < warmupTicks; tick++) {
    pushFire(room, players, ++seq);
    room.update();
    room.drainKills();
  }

  const updateSamples: number[] = [];
  const fanoutSamples: number[] = [];
  const totalSamples: number[] = [];
  let hits = 0;
  let booms = 0;
  let kills = 0;
  let bytes = 0;
  const started = performance.now();

  for (let tick = 0; tick < ticks; tick++) {
    pushFire(room, players, ++seq);
    const updateStarted = performance.now();
    room.update();
    const updateMs = performance.now() - updateStarted;

    const killed = room.drainKills();
    kills += killed.length;
    for (const kill of killed) encode({ t: 'kill', killer: kill.killer, victim: kill.victim });
    const fanoutStarted = performance.now();
    bytes += snapshotFanout(room, players);
    const fanoutMs = performance.now() - fanoutStarted;

    hits += room.snapshotHits(players[0]).length;
    booms += room.boomEvents.length;
    updateSamples.push(updateMs);
    fanoutSamples.push(fanoutMs);
    totalSamples.push(updateMs + fanoutMs);
  }

  const elapsedMs = performance.now() - started;
  const metric = (samples: number[]) => ({
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
    maxMs: Math.max(...samples),
  });
  return {
    tps: (ticks * 1000) / elapsedMs,
    elapsedMs,
    update: metric(updateSamples),
    fanout: metric(fanoutSamples),
    total: metric(totalSamples),
    events: { hits, booms, kills, avgBytesPerTick: Math.round(bytes / ticks) },
  };
}

const results = Array.from({ length: runs }, measure);
const average = (path: 'tps' | 'elapsedMs') => results.reduce((sum, result) => sum + result[path], 0) / results.length;
console.log(JSON.stringify({
  scenario: 'dm-40-human-combat-storm',
  runs,
  ticks,
  tickBudgetMs: 1000 / TICK_HZ,
  average: { tps: average('tps'), elapsedMs: average('elapsedMs') },
  results,
}, null, 2));
