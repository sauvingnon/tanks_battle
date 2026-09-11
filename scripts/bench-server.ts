/**
 * Эталонный нагрузочный замер серверной симуляции без WebSocket.
 * Запуск: npm run bench:server
 * Опции: RUNS=5 TICKS=450
 */
import { performance } from 'node:perf_hooks';
import { MODE_ROYALE, ROYALE_START_COUNTDOWN_S, TICK_HZ } from '../src/shared/constants.js';
import { Room } from '../src/server/room.js';

const runs = Math.max(1, Number(process.env.RUNS ?? 5));
const ticks = Math.max(30, Number(process.env.TICKS ?? Math.round(TICK_HZ * 15)));
const countdownTicks = Math.round(ROYALE_START_COUNTDOWN_S * TICK_HZ) + 1;

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function run(): {
  elapsedMs: number;
  tps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  botsStart: number;
  botsEnd: number;
} {
  const room = new Room(() => {});
  room.add('benchmark', () => {});
  room.setup(MODE_ROYALE, 3, true);

  for (let i = 0; i < countdownTicks; i++) room.update();
  const botsStart = room.botCount;
  const samples: number[] = [];
  const started = performance.now();

  for (let i = 0; i < ticks; i++) {
    const tickStarted = performance.now();
    room.update();
    samples.push(performance.now() - tickStarted);
  }

  const elapsedMs = performance.now() - started;
  return {
    elapsedMs,
    tps: (ticks * 1000) / elapsedMs,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    max: Math.max(...samples),
    botsStart,
    botsEnd: room.botCount,
  };
}

const results = Array.from({ length: runs }, run);
const average = (key: keyof Omit<ReturnType<typeof run>, 'botsStart' | 'botsEnd'>) =>
  results.reduce((sum, result) => sum + result[key], 0) / results.length;

console.log(
  JSON.stringify(
    {
      scenario: 'royale-diff3-1human-39bots',
      runs,
      ticks,
      tickBudgetMs: 1000 / TICK_HZ,
      average: {
        tps: average('tps'),
        elapsedMs: average('elapsedMs'),
        p50Ms: average('p50'),
        p95Ms: average('p95'),
        p99Ms: average('p99'),
        maxMs: average('max'),
      },
      bots: {
        start: results.map((result) => result.botsStart),
        end: results.map((result) => result.botsEnd),
      },
      measurements: results,
    },
    null,
    2,
  ),
);
