import { DT } from '../shared/constants.js';
import { angleDiff, clamp, lerpAngle, stepTank, wrapAngle } from '../shared/sim.js';
import type { Box, Input, TankState } from '../shared/types.js';

/** Дальше этого расхождение не сглаживаем, а прыгаем: значит был фриз или телепорт. */
const MAX_VISUAL_ERROR = 4;
/** Во сколько раз за секунду гаснет расхождение; 9 даёт постоянную времени ~110 мс. */
const ERROR_DECAY = 9;

export interface RenderState {
  x: number;
  z: number;
  angle: number;
  turret: number;
}

/**
 * Предсказание собственного танка.
 *
 * Симуляция идёт фиксированным шагом DT, поэтому кадр всегда рисуется между двумя
 * шагами (previous -> predicted). Поправки сервера не двигают картинку мгновенно:
 * траектория сдвигается на поправку, а ровно такой же противоход кладётся в error
 * и гаснет за ~100 мс. Благодаря этому реконсиляция незаметна, а интерполяция между
 * шагами при этом не ломается.
 */
export class SelfPrediction {
  obstacles: Box[] = [];
  /** Пока сервер не сказал обратного — живы. Мёртвый танк не управляется. */
  alive = true;

  private predicted: TankState | null = null;
  private previous: TankState | null = null;
  private readonly pending: Input[] = [];
  private readonly error = { x: 0, z: 0, angle: 0, turret: 0 };
  private seq = 0;

  get ready(): boolean {
    return this.predicted !== null;
  }

  get speed(): number {
    return this.predicted?.speed ?? 0;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  reset(): void {
    this.predicted = null;
    this.previous = null;
    this.pending.length = 0;
    this.seq = 0;
    this.alive = true;
    this.error.x = 0;
    this.error.z = 0;
    this.error.angle = 0;
    this.error.turret = 0;
  }

  /** Первый снапшот: принимаем позицию сервера как есть. */
  spawn(state: TankState): void {
    this.predicted = { ...state };
    this.previous = { ...state };
  }

  /** Один шаг предсказания. Возвращает инпут, который надо отправить серверу. */
  step(throttle: number, steer: number, turret: number, fire = false): Input | null {
    if (!this.predicted) return null;

    // Подбитый танк не едет — точно так же, как его считает сервер, иначе
    // предсказание разъедется на все секунды ожидания респавна.
    if (!this.alive) {
      throttle = 0;
      steer = 0;
      turret = this.predicted.turret;
      fire = false;
    }

    const input: Input = { seq: ++this.seq, throttle, steer, turret, fire };
    this.pending.push(input);
    this.previous = { ...this.predicted };
    stepTank(this.predicted, input, DT, this.obstacles);

    // Страховка от бесконечного роста, если ack почему-то перестал приходить.
    if (this.pending.length > 180) this.pending.splice(0, this.pending.length - 180);
    return input;
  }

  /** Поправка от сервера: ставим его состояние и переигрываем неподтверждённое. */
  reconcile(server: TankState, ack: number): void {
    if (!this.predicted) {
      this.spawn(server);
      return;
    }

    // Сравниваем чистые состояния симуляции — без интерполяции и без error,
    // иначе намеренное отставание кадра попадёт в расхождение второй раз.
    const before = { ...this.predicted };

    this.predicted.x = server.x;
    this.predicted.z = server.z;
    this.predicted.angle = server.angle;
    this.predicted.speed = server.speed;
    this.predicted.turret = server.turret;

    while (this.pending.length > 0 && this.pending[0].seq <= ack) this.pending.shift();
    for (const input of this.pending) stepTank(this.predicted, input, DT, this.obstacles);

    const deltaX = this.predicted.x - before.x;
    const deltaZ = this.predicted.z - before.z;
    const deltaAngle = angleDiff(before.angle, this.predicted.angle);
    const deltaTurret = angleDiff(before.turret, this.predicted.turret);

    if (Math.hypot(deltaX, deltaZ) > MAX_VISUAL_ERROR) {
      this.previous = { ...this.predicted };
      this.error.x = 0;
      this.error.z = 0;
      this.error.angle = 0;
      this.error.turret = 0;
      return;
    }

    if (this.previous) {
      this.previous.x += deltaX;
      this.previous.z += deltaZ;
      this.previous.angle = wrapAngle(this.previous.angle + deltaAngle);
      this.previous.turret = wrapAngle(this.previous.turret + deltaTurret);
    }
    this.error.x -= deltaX;
    this.error.z -= deltaZ;
    this.error.angle = wrapAngle(this.error.angle - deltaAngle);
    this.error.turret = wrapAngle(this.error.turret - deltaTurret);
  }

  /** Гасит накопленное расхождение. Не зависит от частоты кадров. */
  decay(dt: number): void {
    const factor = Math.exp(-dt * ERROR_DECAY);
    this.error.x *= factor;
    this.error.z *= factor;
    this.error.angle *= factor;
    this.error.turret *= factor;
  }

  /**
   * Состояние для отрисовки. alpha — доля времени, прошедшая до следующего шага
   * симуляции: 0 — только что шагнули, 1 — вот-вот шагнём снова.
   */
  sample(alpha: number): RenderState | null {
    if (!this.predicted) return null;
    const from = this.previous ?? this.predicted;
    const t = clamp(alpha, 0, 1);

    return {
      x: from.x + (this.predicted.x - from.x) * t + this.error.x,
      z: from.z + (this.predicted.z - from.z) * t + this.error.z,
      angle: wrapAngle(lerpAngle(from.angle, this.predicted.angle, t) + this.error.angle),
      turret: wrapAngle(lerpAngle(from.turret, this.predicted.turret, t) + this.error.turret),
    };
  }
}
