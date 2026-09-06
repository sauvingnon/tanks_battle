import {
  DT,
  MAX_BOUNCES,
  MAX_HP,
  MAX_INPUT_QUEUE,
  MAX_NAME_LEN,
  MAX_SHELLS,
  RELOAD_S,
  RESPAWN_S,
  SHELL_DAMAGE,
  TICK_HZ,
} from '../shared/constants.js';
import { buildMap, spawnPoint } from '../shared/map.js';
import {
  bounceShell,
  canRicochet,
  resolveTankCollisions,
  spawnShell,
  stepShell,
  stepTank,
  sweepShell,
  sweepTank,
} from '../shared/sim.js';
import {
  BOOM_GROUND,
  BOOM_HIT,
  BOOM_KILL,
  BOOM_RICOCHET,
  createTankState,
  type Boom,
  type Box,
  type Input,
  type PlayerInfo,
  type ShellState,
  type SnapshotEntry,
  type SnapshotShell,
  type TankState,
} from '../shared/types.js';

/** Перезарядка и респавн считаются в тиках, чтобы жить в тех же часах, что и симуляция. */
const RELOAD_TICKS = Math.round(RELOAD_S * TICK_HZ);
const RESPAWN_TICKS = Math.round(RESPAWN_S * TICK_HZ);

/**
 * На сколько отрезков максимум режется путь снаряда за тик. Каждый отскок начинает
 * новый отрезок, плюс один на остаток пути; предел страхует от вечного цикла,
 * если снаряд зажмёт между гранями.
 */
const MAX_SEGMENTS = MAX_BOUNCES + 2;

export interface Player {
  id: number;
  name: string;
  color: number;
  state: TankState;
  hp: number;
  dead: boolean;
  /** Тик, на котором танк вернётся в бой. */
  respawnAt: number;
  /** Тик, раньше которого выстрел не пройдёт. */
  readyAt: number;
  kills: number;
  deaths: number;
  /** Очередь необработанных инпутов. */
  queue: Input[];
  /** seq последнего инпута, применённого сервером — клиент по нему делает реконсиляцию. */
  ack: number;
  /** Последний применённый инпут: если новых нет, повторяем его (клиент лагает). */
  last: Input;
  send: (data: string) => void;
}

export interface KillEvent {
  killer: string;
  victim: string;
}

/**
 * Одна комната. Пока она в единственном экземпляре — карта общая, все видят всех.
 */
export class Room {
  readonly obstacles: Box[] = buildMap();
  readonly players = new Map<number, Player>();

  private nextId = 1;
  private nextShellId = 1;
  private spawnCounter = 0;
  private tick = 0;

  private readonly shells: ShellState[] = [];
  /** События одного тика: очищаются в начале update(), забираются после. */
  private booms: Boom[] = [];
  private kills: KillEvent[] = [];

  add(name: string, send: (data: string) => void): Player {
    const id = this.nextId++;
    const spawn = spawnPoint(this.spawnCounter++);
    const player: Player = {
      id,
      name: sanitizeName(name),
      color: id % 8,
      state: createTankState(spawn.x, spawn.z, spawn.angle),
      hp: MAX_HP,
      dead: false,
      respawnAt: 0,
      readyAt: 0,
      kills: 0,
      deaths: 0,
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
    // Снаряды ушедшего долетают сами: владельца уже нет, попадание просто никому не засчитается.
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
    this.booms = [];

    for (const player of this.players.values()) {
      if (player.dead && this.tick >= player.respawnAt) this.respawn(player);

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
        // Подбитый танк не едет и не стреляет, что бы ни прислал клиент.
        stepTank(player.state, player.dead ? frozen(player) : player.last, DT, this.obstacles);
        if (player.last.fire) {
          // Флаг срабатывает ровно один раз на инпут. Иначе last повторялся бы
          // каждый тик, и замолчавший клиент стрелял бы сам по себе.
          player.last.fire = false;
          if (!player.dead) this.tryFire(player);
        }
      }
    }

    const alive: TankState[] = [];
    for (const p of this.players.values()) if (!p.dead) alive.push(p.state);
    resolveTankCollisions(alive);

    this.updateShells();
  }

  private tryFire(player: Player): void {
    if (this.tick < player.readyAt) return;
    player.readyAt = this.tick + RELOAD_TICKS;
    this.shells.push(spawnShell(this.nextShellId++, player.id, player.state));
    // Переполнение возможно только при явном флуде — жертвуем самым старым снарядом.
    if (this.shells.length > MAX_SHELLS) this.shells.shift();
  }

  private updateShells(): void {
    for (let i = this.shells.length - 1; i >= 0; i--) {
      if (this.flyShell(this.shells[i], DT)) this.shells.splice(i, 1);
    }
  }

  /**
   * Проводит снаряд через тик. Путь режется на отрезки: до ближайшего касания,
   * а после отскока — остаток тика заново. Возвращает true, если снаряд отжил своё.
   */
  private flyShell(shell: ShellState, dt: number): boolean {
    for (let segment = 0; segment < MAX_SEGMENTS; segment++) {
      const wall = sweepShell(shell, dt, this.obstacles);

      // Танк на отрезке важнее стены за ним, поэтому ищем его только до касания.
      const victim = this.firstVictim(shell, dt, wall ? wall.t : 1);
      if (victim) {
        stepShell(shell, dt * victim.t);
        this.damage(victim.player, shell);
        return true;
      }

      if (!wall) {
        stepShell(shell, dt);
        return shell.life <= 0;
      }

      const travel = dt * wall.t;
      stepShell(shell, travel);
      dt -= travel;

      if (!canRicochet(shell, wall)) {
        this.booms.push({ x: shell.x, z: shell.z, k: BOOM_GROUND, o: shell.owner });
        return true;
      }

      bounceShell(shell, wall);
      this.booms.push({ x: shell.x, z: shell.z, k: BOOM_RICOCHET, o: shell.owner });
      if (shell.life <= 0) return true;
    }

    // Отрезки кончились — снаряд застрял между гранями, убираем его молча.
    return true;
  }

  /** Ближайший по ходу отрезка танк, в который попадёт снаряд; limit — доля шага до стены. */
  private firstVictim(
    shell: ShellState,
    dt: number,
    limit: number,
  ): { player: Player; t: number } | null {
    let best: { player: Player; t: number } | null = null;
    for (const target of this.players.values()) {
      if (target.dead) continue;
      // В себя можно попасть только рикошетом: иначе снаряд убивал бы стрелка на вылете.
      if (target.id === shell.owner && shell.bounces === 0) continue;

      const t = sweepTank(shell, dt, target.state);
      if (t === null || t > limit) continue;
      if (best === null || t < best.t) best = { player: target, t };
    }
    return best;
  }

  private damage(victim: Player, shell: ShellState): void {
    victim.hp -= SHELL_DAMAGE;
    if (victim.hp > 0) {
      this.booms.push({ x: shell.x, z: shell.z, k: BOOM_HIT, o: shell.owner });
      return;
    }

    victim.hp = 0;
    victim.dead = true;
    victim.deaths++;
    victim.respawnAt = this.tick + RESPAWN_TICKS;
    victim.queue.length = 0;
    this.booms.push({ x: victim.state.x, z: victim.state.z, k: BOOM_KILL, o: shell.owner });

    // Стрелявший мог выйти, пока снаряд летел.
    const killer = this.players.get(shell.owner);
    // За смерть от собственного рикошета фраг не полагается — только запись в ленту.
    if (killer && killer !== victim) killer.kills++;
    this.kills.push({ killer: killer?.name ?? 'Неизвестный', victim: victim.name });
  }

  private respawn(player: Player): void {
    const spawn = spawnPoint(this.spawnCounter++);
    player.state = createTankState(spawn.x, spawn.z, spawn.angle);
    player.hp = MAX_HP;
    player.dead = false;
    player.readyAt = this.tick;
    // seq не сбрасываем: клиент продолжает свою нумерацию, ack должен остаться в её шкале.
    player.last = { seq: player.last.seq, throttle: 0, steer: 0, turret: spawn.angle };
    player.queue.length = 0;
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
        h: p.hp,
        d: p.dead ? 1 : 0,
      });
    }
    return entries;
  }

  snapshotShells(): SnapshotShell[] {
    return this.shells.map((s) => ({
      i: s.id,
      o: s.owner,
      x: round(s.x),
      z: round(s.z),
      a: round(Math.atan2(s.vx, s.vz)),
      b: s.bounces,
    }));
  }

  /** Взрывы этого тика. */
  get boomEvents(): Boom[] {
    return this.booms;
  }

  /** Забирает накопленные фраги: вызывать раз за тик после update(). */
  drainKills(): KillEvent[] {
    if (this.kills.length === 0) return this.kills;
    const out = this.kills;
    this.kills = [];
    return out;
  }

  get shellCount(): number {
    return this.shells.length;
  }

  get tickCount(): number {
    return this.tick;
  }

  get tickHz(): number {
    return TICK_HZ;
  }
}

/** Инпут подбитого танка: рулить нельзя, но башню оставляем там, где её застали. */
function frozen(player: Player): Input {
  return { seq: player.last.seq, throttle: 0, steer: 0, turret: player.state.turret };
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
