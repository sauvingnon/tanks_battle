/**
 * Measures per-snapshot fan-out without a WebSocket.
 * Run: npm run bench:snapshots
 * Options: SAMPLES=100 CLIENTS=1,4,8,16
 */
import { performance } from 'node:perf_hooks';
import { MODE_ROYALE, ROYALE_START_COUNTDOWN_S, TICK_HZ } from '../src/shared/constants.js';
import { encodeSnapshot, type SnapshotPayload } from '../src/shared/protocol.js';
import { Room, type Player } from '../src/server/room.js';

const samples = Math.max(20, Number(process.env.SAMPLES ?? 100));
const clientCounts = (process.env.CLIENTS ?? '1,4,8,16')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const countdownTicks = Math.round(ROYALE_START_COUNTDOWN_S * TICK_HZ) + 1;

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function measure(clientCount: number) {
  const room = new Room(() => {});
  const clients: Player[] = [];
  for (let i = 0; i < clientCount; i++) clients.push(room.add(`snapshot-${i}`, () => {}));
  room.setup(MODE_ROYALE, 3, true);
  for (let i = 0; i < countdownTicks; i++) room.update();

  const buildSamples: number[] = [];
  const encodeSamples: number[] = [];
  const totalSamples: number[] = [];
  let bytes = 0;

  for (let i = 0; i < samples + 5; i++) {
    const buildStarted = performance.now();
    const zone = room.royaleZoneState();
    const payloads: { player: Player; payload: SnapshotPayload }[] = [];
    for (const player of clients) {
      const payload: SnapshotPayload = {
        tick: room.tickCount,
        ack: player.ack,
        players: room.snapshotEntries(player),
      };
      if (room.shellCount > 0) payload.shells = room.snapshotShells(player);
      if (room.boomEvents.length > 0) payload.booms = room.boomEvents;
      const hits = room.snapshotHits(player);
      if (hits.length > 0) payload.hits = hits;
      if (room.bonusCount > 0) payload.bonuses = room.snapshotBonuses();
      if (zone) payload.zone = zone;
      payload.contacts = room.snapshotContacts(player);
      payloads.push({ player, payload });
    }
    const buildMs = performance.now() - buildStarted;

    const encodeStarted = performance.now();
    let packetBytes = 0;
    for (const entry of payloads) packetBytes += encodeSnapshot(entry.payload).byteLength;
    const encodeMs = performance.now() - encodeStarted;
    if (i >= 5) {
      buildSamples.push(buildMs);
      encodeSamples.push(encodeMs);
      totalSamples.push(buildMs + encodeMs);
      bytes = packetBytes;
    }
  }

  return {
    clients: clientCount,
    bots: room.botCount,
    bytesPerSnapshot: bytes,
    buildMs: { p50: percentile(buildSamples, 0.5), p95: percentile(buildSamples, 0.95), avg: buildSamples.reduce((a, b) => a + b, 0) / buildSamples.length },
    encodeMs: { p50: percentile(encodeSamples, 0.5), p95: percentile(encodeSamples, 0.95), avg: encodeSamples.reduce((a, b) => a + b, 0) / encodeSamples.length },
    totalMs: { p50: percentile(totalSamples, 0.5), p95: percentile(totalSamples, 0.95), avg: totalSamples.reduce((a, b) => a + b, 0) / totalSamples.length },
  };
}

console.log(JSON.stringify({ scenario: 'royale-snapshot-fanout', samples, results: clientCounts.map(measure) }, null, 2));
