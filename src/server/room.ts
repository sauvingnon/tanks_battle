import { MAX_INPUT_QUEUE, MAX_NAME_LEN, TICK_HZ, DT } from '../shared/constants.js';
import { buildMap, spawnPoint } from '../shared/map.js';
import { resolveTankCollisions, stepTank } from '../shared/sim.js';
import {
  createTankState,
  type Box,
  type Input,
  type PlayerInfo,
  type SnapshotEntry,
  type TankState,
} from '../shared/types.js';

export interface Player {
  id: number;
  name: string;
  color: number;
  state: TankState;
  /** Очередь необработанных инпутов. */
  queue: Input[];
  /** seq последнего инпута, применённого сервером — клиент по нему делает реконсиляцию. */
  ack: number;
  /** Последний применённый инпут: если новых нет, повторяем его (клиент лагает). */
  last: Input;
  send: (data: string) => void;
}

/**
 * Одна комната. Пока она в единственном экземпляре — карта общая, все видят всех.
 */
export class Room {
  readonly obstacles: Box[] = buildMap();
  readonly players = new Map<number, Player>();

  private nextId = 1;
  private spawnCounter = 0;
  private tick = 0;

  add(name: string, send: (data: string) => void): Player {
    const id = this.nextId++;
    const spawn = spawnPoint(this.spawnCounter++);
    const player: Player = {
      id,
      name: sanitizeName(name),
      color: id % 8,
      state: createTankState(spawn.x, spawn.z, spawn.angle),
      queue: [],
      ack: 0,
      last: { seq: 0, throttle: 0, steer: 0, turret: spawn.angle },
      send,
    };
    this.players.set(id, player);
    return player;
  }

  remove(id: number): void {
    this.players.delete(id);
  }

  info(player: Player): PlayerInfo {
    return { id: player.id, name: player.name, color: player.color };
  }

  allInfo(): PlayerInfo[] {
    return [...this.players.values()].map((p) => this.info(p));
  }

  pushInput(player: Player, input: Input): void {
    // Инпуты из прошлого игнорируем, будущее — ограничиваем длиной очереди,
    // иначе пачкой пакетов можно было бы «ускорить» свой танк.
    if (input.seq <= player.ack) return;
    player.queue.push(input);
    if (player.queue.length > MAX_INPUT_QUEUE) {
      player.queue.splice(0, player.queue.length - MAX_INPUT_QUEUE);
    }
  }

  /** Один шаг мира. */
  update(): void {
    this.tick++;

    for (const player of this.players.values()) {
      // Часы клиента и сервера идут независимо, поэтому очередь то пустеет, то копится.
      // Если накопилось — разгребаем по два инпута за тик: каждый всё равно применяется
      // ровно один раз, зато отставание не растёт до срабатывания MAX_INPUT_QUEUE,
      // после которого сервер начал бы терять инпуты, уже применённые клиентом.
      const drain = player.queue.length >= 3 ? 2 : 1;

      for (let i = 0; i < drain; i++) {
        const input = player.queue.shift();
        if (input) {
          player.last = input;
          player.ack = input.seq;
        }
        // Если новых инпутов нет — продолжаем с последним известным: танк не замирает
        // при потере пакета, а клиент предсказывает ровно то же самое.
        stepTank(player.state, player.last, DT, this.obstacles);
      }
    }

    resolveTankCollisions([...this.players.values()].map((p) => p.state));
  }

  /** Снапшот общий для всех, кроме поля ack — оно у каждого своё. */
  snapshotEntries(): SnapshotEntry[] {
    const entries: SnapshotEntry[] = [];
    for (const p of this.players.values()) {
      entries.push({
        i: p.id,
        x: round(p.state.x),
        z: round(p.state.z),
        a: round(p.state.angle),
        t: round(p.state.turret),
        s: round(p.state.speed),
      });
    }
    return entries;
  }

  get tickCount(): number {
    return this.tick;
  }

  get tickHz(): number {
    return TICK_HZ;
  }
}

/** Три знака после запятой — миллиметры, для сети более чем достаточно. */
function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Управляющие символы вырезаем — иначе ими можно ломать вёрстку ников. */
const CONTROL_CHARS = new RegExp('[\u0000-\u001f\u007f]', 'g');

export function sanitizeName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  const clean = text.replace(CONTROL_CHARS, '').trim().slice(0, MAX_NAME_LEN);
  return clean.length > 0 ? clean : 'Танк';
}
