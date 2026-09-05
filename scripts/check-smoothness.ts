/**
 * Численная проверка плавности предсказания: клиент и сервер крутятся с независимыми
 * часами, сеть с задержкой и джиттером. Меряем то, что видит игрок, — рывки скорости
 * и дёрганье башни от кадра к кадру.
 *
 * Запуск: npm run check:smoothness
 *
 * Режим legacy воспроизводит математику до исправления, чтобы разница была видна
 * в числах, а не на глаз.
 */
import { DT, MAX_INPUT_QUEUE, TICK_HZ } from '../src/shared/constants.js';
import { angleDiff, clamp, lerpAngle, stepTank, wrapAngle } from '../src/shared/sim.js';
import type { Box, Input, TankState } from '../src/shared/types.js';
import { SelfPrediction } from '../src/client/prediction.js';

const OBSTACLES: Box[] = []; // столкновения тут только мешали бы измерению
const DURATION_S = 12;
const CLIENT_FPS = 144;
const SERVER_HZ = TICK_HZ;
/** Часы сервера чуть отличаются от клиентских — именно из-за этого копится расхождение. */
const SERVER_CLOCK_SKEW = 1.0007;
const LATENCY_MS = 30;
const JITTER_MS = 6;

const THROTTLE = 1;
/**
 * Руль подобран так, чтобы круг радиуса v/(TURN_RATE_FULL*STEER) ≈ 22 м целиком
 * помещался внутри карты: удар о стену честно гасит скорость и портил бы измерение.
 */
const STEER = 0.7;
/** Прицел всё время водит, как живой игрок мышью, — иначе башне неоткуда разъехаться. */
const turretTarget = (t: number) => Math.sin(t * 0.8) * 1.4;

interface Packet<T> {
  arrivesAt: number;
  payload: T;
}

/** Старая математика: previous сбрасывался на каждом снапшоте, ошибка мерилась от кадра. */
class LegacyPrediction {
  obstacles: Box[] = [];
  private predicted: TankState | null = null;
  private previous: TankState | null = null;
  private readonly pending: Input[] = [];
  private readonly error = { x: 0, z: 0, angle: 0 };
  private rendered = { x: 0, z: 0, angle: 0, valid: false };
  private seq = 0;

  get ready(): boolean {
    return this.predicted !== null;
  }

  spawn(state: TankState): void {
    this.predicted = { ...state };
    this.previous = { ...state };
  }

  step(throttle: number, steer: number, turret: number): Input | null {
    if (!this.predicted) return null;
    const input: Input = { seq: ++this.seq, throttle, steer, turret };
    this.pending.push(input);
    this.previous = { ...this.predicted };
    stepTank(this.predicted, input, DT, this.obstacles);
    return input;
  }

  reconcile(server: TankState, ack: number): void {
    if (!this.predicted) {
      this.spawn(server);
      return;
    }
    const beforeX = this.rendered.valid ? this.rendered.x : this.predicted.x + this.error.x;
    const beforeZ = this.rendered.valid ? this.rendered.z : this.predicted.z + this.error.z;
    const beforeAngle = this.rendered.valid
      ? this.rendered.angle
      : wrapAngle(this.predicted.angle + this.error.angle);

    Object.assign(this.predicted, server);
    while (this.pending.length > 0 && this.pending[0].seq <= ack) this.pending.shift();
    for (const input of this.pending) stepTank(this.predicted, input, DT, this.obstacles);

    this.previous = { ...this.predicted };

    const dx = beforeX - this.predicted.x;
    const dz = beforeZ - this.predicted.z;
    if (Math.hypot(dx, dz) > 4) {
      this.error.x = 0;
      this.error.z = 0;
      this.error.angle = 0;
    } else {
      this.error.x = dx;
      this.error.z = dz;
      this.error.angle = wrapAngle(beforeAngle - this.predicted.angle);
    }
  }

  decay(dt: number): void {
    const factor = Math.exp(-dt * 9);
    this.error.x *= factor;
    this.error.z *= factor;
    this.error.angle *= factor;
  }

  sample(alpha: number) {
    if (!this.predicted) return null;
    const from = this.previous ?? this.predicted;
    const t = clamp(alpha, 0, 1);
    const state = {
      x: from.x + (this.predicted.x - from.x) * t + this.error.x,
      z: from.z + (this.predicted.z - from.z) * t + this.error.z,
      angle: wrapAngle(lerpAngle(from.angle, this.predicted.angle, t) + this.error.angle),
      // Старый вариант: башня без сглаживания вообще.
      turret: lerpAngle(from.turret, this.predicted.turret, t),
    };
    this.rendered = { x: state.x, z: state.z, angle: state.angle, valid: true };
    return state;
  }
}

interface Client {
  obstacles: Box[];
  readonly ready: boolean;
  spawn(state: TankState): void;
  step(throttle: number, steer: number, turret: number): Input | null;
  reconcile(server: TankState, ack: number): void;
  decay(dt: number): void;
  sample(alpha: number): { x: number; z: number; angle: number; turret: number } | null;
}

interface Sample {
  at: number;
  value: number;
}

interface Result {
  speedJerk: Sample[];
  turretJerk: Sample[];
  popped: Sample[];
}

/**
 * measurePop лишний раз дёргает sample(), а у старой реализации sample() имеет
 * побочный эффект — поэтому для неё замер отключён, чтобы сравнение было честным.
 */
function run(client: Client, measurePop = false): Result {
  client.obstacles = OBSTACLES;

  // --- сервер ---
  const serverState: TankState = { x: 0, z: 0, angle: 0, speed: 0, turret: 0 };
  const queue: Input[] = [];
  let serverAck = 0;
  let serverNextTick = 0;

  const toServer: Packet<Input>[] = [];
  const toClient: Packet<{ state: TankState; ack: number }>[] = [];

  client.spawn(serverState);

  // --- клиент ---
  const frameDt = 1 / CLIENT_FPS;
  let accumulator = 0;
  let prev: { x: number; z: number; turret: number } | null = null;
  let prevSpeed: number | null = null;
  let prevTurretRate: number | null = null;

  const speedJerk: Sample[] = [];
  const turretJerk: Sample[] = [];
  const popped: Sample[] = [];

  const frames = Math.round(DURATION_S * CLIENT_FPS);
  for (let f = 0; f < frames; f++) {
    const now = f * frameDt;

    // Доставка инпутов на сервер.
    while (toServer.length > 0 && toServer[0].arrivesAt <= now) {
      const input = toServer.shift()!;
      if (input.payload.seq > serverAck) {
        queue.push(input.payload);
        if (queue.length > MAX_INPUT_QUEUE) queue.splice(0, queue.length - MAX_INPUT_QUEUE);
      }
    }

    // Тики сервера по своим часам.
    while (serverNextTick <= now) {
      const drain = queue.length >= 3 ? 2 : 1;
      for (let i = 0; i < drain; i++) {
        const input = queue.shift();
        if (input) serverAck = input.seq;
        stepTank(serverState, lastApplied(input), DT, OBSTACLES);
      }
      toClient.push({
        arrivesAt: now + (LATENCY_MS + (Math.random() * 2 - 1) * JITTER_MS) / 1000,
        payload: { state: { ...serverState }, ack: serverAck },
      });
      serverNextTick += (1 / SERVER_HZ) * SERVER_CLOCK_SKEW;
    }

    // Доставка снапшотов клиенту. Поправка не должна сдвигать картинку: вся разница
    // обязана уходить в error и гаснуть плавно — это и проверяем.
    while (toClient.length > 0 && toClient[0].arrivesAt <= now) {
      const snapshot = toClient.shift()!;
      if (!measurePop) {
        client.reconcile(snapshot.payload.state, snapshot.payload.ack);
        continue;
      }
      const alpha = accumulator / DT;
      const beforeFix = client.sample(alpha);
      client.reconcile(snapshot.payload.state, snapshot.payload.ack);
      const afterFix = client.sample(alpha);
      if (beforeFix && afterFix) {
        popped.push({
          at: now,
          value: Math.hypot(afterFix.x - beforeFix.x, afterFix.z - beforeFix.z),
        });
      }
    }

    // Шаги предсказания на клиенте.
    accumulator += frameDt;
    let steps = 0;
    while (accumulator >= DT && steps < 5) {
      accumulator -= DT;
      steps++;
      const input = client.step(THROTTLE, STEER, turretTarget(now));
      if (input) {
        toServer.push({
          arrivesAt: now + (LATENCY_MS + (Math.random() * 2 - 1) * JITTER_MS) / 1000,
          payload: input,
        });
      }
    }

    client.decay(frameDt);

    const state = client.sample(accumulator / DT);
    if (!state) continue;

    // Первые две секунды — разгон, их не меряем.
    const warm = now > 2;
    if (prev) {
      const speed = Math.hypot(state.x - prev.x, state.z - prev.z) / frameDt;
      const rate = angleDiff(prev.turret, state.turret) / frameDt;
      // Рывок — это изменение скорости за кадр. Сама скорость может быть любой,
      // а вот её скачки от кадра к кадру игрок и видит как дёрганье.
      if (warm && prevSpeed !== null) speedJerk.push({ at: now, value: Math.abs(speed - prevSpeed) });
      if (warm && prevTurretRate !== null) {
        turretJerk.push({ at: now, value: Math.abs(rate - prevTurretRate) });
      }
      prevSpeed = speed;
      prevTurretRate = rate;
    }
    prev = { x: state.x, z: state.z, turret: state.turret };
  }

  return { speedJerk, turretJerk, popped };
}

let lastInput: Input = { seq: 0, throttle: 0, steer: 0, turret: 0 };
function lastApplied(input: Input | undefined): Input {
  if (input) lastInput = input;
  return lastInput;
}

function percentile(samples: Sample[], p: number): number {
  const sorted = samples.map((s) => s.value).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function worst(samples: Sample[]): Sample {
  return samples.reduce((a, b) => (b.value > a.value ? b : a), { at: 0, value: 0 });
}

function report(label: string, result: Result) {
  const speed = worst(result.speedJerk);
  const turret = worst(result.turretJerk);
  const pop = worst(result.popped);
  console.log(
    `${label.padEnd(6)} рывок хода: макс ${speed.value.toFixed(3)} м/с (на ${speed.at.toFixed(2)} с), ` +
      `p99 ${percentile(result.speedJerk, 0.99).toFixed(3)} | ` +
      `рывок башни: макс ${((turret.value * 180) / Math.PI).toFixed(1)} град/с, ` +
      `p99 ${((percentile(result.turretJerk, 0.99) * 180) / Math.PI).toFixed(1)}`,
  );
  console.log(
    `${' '.repeat(6)} сдвиг картинки от поправки: макс ${pop.value.toFixed(4)} м (на ${pop.at.toFixed(2)} с), ` +
      `поправок ${result.popped.length}`,
  );
  return { speed: speed.value, turret: turret.value, pop: pop.value };
}

console.log(
  `${CLIENT_FPS} fps, сервер ${SERVER_HZ} Гц (расхождение часов ${((SERVER_CLOCK_SKEW - 1) * 100).toFixed(2)}%), ` +
    `пинг ${LATENCY_MS}±${JITTER_MS} мс, ${DURATION_S} с\n`,
);

lastInput = { seq: 0, throttle: 0, steer: 0, turret: 0 };
const legacy = report('было', run(new LegacyPrediction()));
lastInput = { seq: 0, throttle: 0, steer: 0, turret: 0 };
const fixed = report('стало', run(new SelfPrediction(), true));

// Танк едет 13 м/с; скачок скорости в 0.5 м/с за кадр уже заметен глазом.
const ok = fixed.speed < 0.5 && (fixed.turret * 180) / Math.PI < 30;
console.log(
  `\nулучшение: ход в ${(legacy.speed / Math.max(fixed.speed, 1e-9)).toFixed(1)} раз, ` +
    `башня в ${(legacy.turret / Math.max(fixed.turret, 1e-9)).toFixed(1)} раз`,
);
console.log(ok ? 'SMOOTHNESS OK' : 'SMOOTHNESS FAILED');
process.exit(ok ? 0 : 1);
