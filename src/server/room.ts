import {
  BONUS_DAMAGE,
  BONUS_DAMAGE_MUL,
  BONUS_HEAL,
  BONUS_HEAL_HP,
  BONUS_KINDS,
  BONUS_LIFETIME_S,
  BONUS_MAX,
  BONUS_RADIUS,
  BONUS_RELOAD,
  BONUS_RELOAD_MUL,
  BONUS_SPAWN_S,
  BONUS_SPEED,
  BONUS_SPEED_MUL,
  BONUS_STEALTH,
  BONUS_DURATION_S,
  DT,
  GUN_PITCH_MAX,
  GUN_PITCH_MIN,
  MAX_BOUNCES,
  BOT_HP,
  MAX_HP,
  STANCE_NEUTRAL,
  isStance,
  MAX_INPUT_QUEUE,
  MAX_NAME_LEN,
  MAX_SHELLS,
  MAX_TIER,
  MODE_DM,
  MODE_PVE,
  RAM_COOLDOWN_S,
  RELOAD_S,
  RESPAWN_S,
  SHELL_DAMAGE,
  TANK_RADIUS,
  TICK_HZ,
  WAVE_BREAK_S,
  WAVE_OPENING_BOTS,
  WAVE_OVER_S,
  WAVE_SPAWN_DELAY_S,
  waveConcurrent,
  waveElite,
  waveQuota,
  waveTier,
  isRuleset,
  RULES_ARCADE,
  type GameMode,
  type Ruleset,
} from '../shared/constants.js';
import { buildScene, coverBoxes, isMapId, spawnPoint } from '../shared/map.js';
import { heightAt, terrainNet, type Terrain } from '../shared/terrain.js';
import type { RoomConfig, ServerMessage, WavePhase, WaveState } from '../shared/protocol.js';
import {
  bounceShell,
  canRicochet,
  clamp,
  resolveTankCollisions,
  spawnShell,
  stepShell,
  stepTank,
  sweepShell,
  sweepTank,
  type RamHit,
} from '../shared/sim.js';
import {
  BOOM_GROUND,
  BOOM_HIT,
  BOOM_KILL,
  BOOM_RICOCHET,
  TEAM_BOTS,
  TEAM_PLAYERS,
  createTankState,
  type BonusState,
  type Boom,
  type BoomKind,
  type Box,
  type Input,
  type PlayerInfo,
  type ShellState,
  type SnapshotBonus,
  type SnapshotEntry,
  type SnapshotShell,
  type TankState,
} from '../shared/types.js';
import { botName, botSpawn, createBrain, think, type BotBrain } from './bot.js';

/** Перезарядка и респавн считаются в тиках, чтобы жить в тех же часах, что и симуляция. */
const RELOAD_TICKS = Math.round(RELOAD_S * TICK_HZ);
const RESPAWN_TICKS = Math.round(RESPAWN_S * TICK_HZ);
const RAM_COOLDOWN_TICKS = Math.round(RAM_COOLDOWN_S * TICK_HZ);

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
  team: number;
  /** У ботов — состояние ИИ, у людей null. Всё остальное у них общее. */
  brain: BotBrain | null;
  /** Выбыл до конца волны: в PvE жизнь одна, возрождает только зачистка волны. */
  waiting: boolean;
  /** Тик окончания каждого бонусного эффекта; 0 — эффекта нет. Индекс — вид бонуса. */
  fx: number[];
  /** Кэш эффекта «Маскировка» на этот тик: его читает ИИ каждого бота. */
  stealth: boolean;
  state: TankState;
  hp: number;
  dead: boolean;
  /** Тик, на котором танк вернётся в бой. */
  respawnAt: number;
  /** Тик, раньше которого выстрел не пройдёт. */
  readyAt: number;
  /** Тик, раньше которого этот танк не получает и не наносит урон тараном. */
  ramAt: number;
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

/** Цвета людей и ботов не пересекаются: врага видно по корпусу, а не только по нику. */
const HUMAN_COLORS = [0, 3, 1, 4, 6, 7, 2];
const BOT_COLOR = 5;

/** Никуда не отправляем: у бота нет сокета, но интерфейс Player общий. */
const NO_SEND = (): void => {};

/**
 * Одна комната на весь сервер. Карта общая, все видят всех; режим и сложность
 * переключает хост — первый вошедший игрок.
 */
export class Room {
  private scene = buildScene(0);
  /** Геометрия текущей карты. Меняется целиком при смене карты. */
  obstacles: Box[] = this.scene.obstacles;
  /**
   * Земля текущей карты. На семи аркадных картах это FLAT, и вся высотная
   * арифметика уходит по короткому пути.
   */
  terrain: Terrain = this.scene.terrain;
  /**
   * Половина стороны текущей карты, м. У больших карт она вчетверо больше
   * площадью, поэтому размер ходит вместе с геометрией, а не берётся из
   * константы: иначе стена стояла бы там, где её никто не рисовал.
   */
  half: number = this.scene.half;
  /** Блоки, по которым свип ведёт снаряд. Пересобирается со сменой карты. */
  cover: Box[] = coverBoxes(this.obstacles, this.terrain);
  readonly players = new Map<number, Player>();

  /** Индекс карты в MAPS. */
  mapId = 0;
  mode: GameMode = MODE_DM;
  /**
   * Аркада или реализм. Сейчас правила целиком клиентские — сервер шлёт всем
   * одно и то же, а подписи снимает клиент, — но настройка комнатная, а не
   * личная: одни в комнате с ником над головой, другие без, — это не разные
   * вкусы, а разные игры.
   */
  rules: Ruleset = RULES_ARCADE;
  /** Выбор хоста: стартовый тир ботов, 0..MAX_TIER. Дальше волны поднимают его сами. */
  difficulty = 1;
  /**
   * Сложность, по которой идёт текущая волна. Снимок делается на старте волны:
   * иначе переключение посреди боя меняло бы выучку следующих же ботов этой волны,
   * и подпись «со следующей волны» врала бы.
   */
  runDifficulty = 1;
  /**
   * Манера боя ботов. Ручка, независимая от сложности: та отвечает за выучку,
   * эта — за дистанцию и за право лезть в упор. Читается ИИ каждый тик, поэтому
   * переключение действует сразу, не дожидаясь новой волны.
   */
  stance = STANCE_NEUTRAL;
  /** Ящики с усилениями на карте. Работают в обоих режимах. */
  bonusesOn = false;
  hostId = 0;

  private nextId = 1;
  private nextShellId = 1;
  private spawnCounter = 0;
  private tick = 0;

  // --- Состояние забега по волнам (только в MODE_PVE) ---
  private wave = 0;
  private phase: WavePhase = 'break';
  /** Тик, на котором кончится пауза между волнами или экран проигрыша. */
  private phaseUntil = 0;
  /** Сколько ботов волны ещё не выпущено. */
  private quotaLeft = 0;
  /** Тик, раньше которого следующий бот не выйдет. */
  private spawnAt = 0;
  /** Сколько ботов волны выходят ускоренно, чтобы бой начался сразу. */
  private opening = 0;
  private best = 0;
  private botCounter = 0;

  /**
   * Живой список танков для ИИ. Именно объект, а не players.values(): итератор
   * одноразовый, а think() проходит по танкам несколько раз за тик.
   */
  private readonly tanks: Iterable<Player> = {
    [Symbol.iterator]: () => this.players.values(),
  };

  private readonly shells: ShellState[] = [];
  /** Имена ушедших стрелков, чьи снаряды ещё в воздухе. Чистится в updateShells. */
  private readonly ghosts = new Map<number, string>();
  /** Ящики на карте. Публичны по той же причине, что и players: их гоняют проверки. */
  readonly bonuses: BonusState[] = [];
  private nextBonusId = 1;
  /** Тик, на котором на карте появится следующий ящик. */
  private bonusAt = 0;

  /** События одного тика: очищаются в начале update(), забираются после. */
  private booms: Boom[] = [];
  private kills: KillEvent[] = [];

  /** emit рассылает сообщение всем людям в комнате; в тестах его можно не давать. */
  constructor(private readonly emit: (msg: ServerMessage) => void = () => {}) {}

  add(name: string, send: (data: string) => void): Player {
    const spawn = spawnPoint(this.spawnCounter++, this.mapId);
    const player = this.create(sanitizeName(name), TEAM_PLAYERS, spawn, send);
    player.color = HUMAN_COLORS[this.humanCount % HUMAN_COLORS.length];
    this.players.set(player.id, player);

    // Хост — первый вошедший: он и настраивает комнату.
    if (this.hostId === 0) {
      this.hostId = player.id;
      this.emitConfig();
    }
    // Волна уже идёт — новичок ждёт её конца, иначе он выпал бы в гущу боя.
    if (this.mode === MODE_PVE && this.phase === 'fight') player.waiting = true;
    if (player.waiting) player.dead = true;

    return player;
  }

  private create(
    name: string,
    team: number,
    spawn: { x: number; z: number; angle: number },
    send: (data: string) => void,
  ): Player {
    return {
      id: this.nextId++,
      name,
      color: BOT_COLOR,
      team,
      brain: null,
      waiting: false,
      fx: new Array<number>(BONUS_KINDS).fill(0),
      stealth: false,
      state: createTankState(spawn.x, spawn.z, spawn.angle),
      hp: MAX_HP,
      dead: false,
      respawnAt: 0,
      readyAt: 0,
      ramAt: 0,
      kills: 0,
      deaths: 0,
      queue: [],
      ack: 0,
      last: { seq: 0, throttle: 0, steer: 0, turret: spawn.angle },
      send,
    };
  }

  remove(id: number): void {
    const player = this.players.get(id);
    if (player) this.forget(player);
    this.players.delete(id);
    if (id !== this.hostId) return;

    // Хост ушёл — передаём следующему по времени входа.
    this.hostId = 0;
    for (const player of this.players.values()) {
      if (player.brain) continue;
      this.hostId = player.id;
      break;
    }
    this.emitConfig();
  }

  info(player: Player): PlayerInfo {
    return {
      id: player.id,
      name: player.name,
      color: player.color,
      team: player.team,
      ...(player.brain ? { bot: 1 as const } : {}),
    };
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

    if (this.mode === MODE_PVE) this.updateWave();
    if (this.bonusesOn) this.updateBonuses();

    for (const player of this.players.values()) {
      if (player.brain) {
        this.stepBot(player);
        continue;
      }
      // Ждущий конца волны не возрождается по таймеру — его поднимет сама волна.
      if (player.dead && !player.waiting && this.tick >= player.respawnAt) this.respawn(player);

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
        stepTank(
          player.state,
          player.dead ? frozen(player) : player.last,
          DT,
          this.obstacles,
          this.boost(player),
          this.half,
        );
        if (player.last.fire) {
          // Флаг срабатывает ровно один раз на инпут. Иначе last повторялся бы
          // каждый тик, и замолчавший клиент стрелял бы сам по себе.
          player.last.fire = false;
          if (!player.dead) this.tryFire(player);
        }
      }
    }

    const alive: Player[] = [];
    for (const p of this.players.values()) if (!p.dead) alive.push(p);
    this.applyRams(
      alive,
      resolveTankCollisions(
        alive.map((p) => p.state),
        DT,
      ),
    );

    this.updateShells();
  }

  /**
   * Урон от таранов. Физика посчитана в resolveTankCollisions, комната решает,
   * кому он вообще засчитывается.
   *
   * Боты друг друга не таранят. Они ходят стаей и постоянно трутся бортами,
   * обходя цель, — с уроном волна выкашивала бы себя сама, и чем больше ботов,
   * тем быстрее. Игроку это читалось бы как «волна кончилась сама собой».
   */
  private applyRams(alive: Player[], hits: RamHit[]): void {
    for (const hit of hits) {
      const a = alive[hit.a];
      const b = alive[hit.b];
      if (a.brain && b.brain) continue;
      // Пауза общая на танк, а не на пару: иначе в свалке трое разом снимали бы
      // с одного полный урон каждый тик, и таран решал бы бой без единого выстрела.
      if (this.tick < a.ramAt || this.tick < b.ramAt) continue;

      // Урон округляем: физика считает его непрерывно от скорости сближения, а
      // здоровье — целое число, которое игрок читает с полоски. Дробные остатки
      // ничего не решают и только превращают понятный размен в «87.3 из 100».
      const toA = Math.round(hit.damageA);
      const toB = Math.round(hit.damageB);
      // Совсем слабый контакт округлился в ноль — это не таран, и паузу он
      // тратить не должен: иначе им можно было бы прикрыться от настоящего.
      if (toA === 0 && toB === 0) continue;

      a.ramAt = this.tick + RAM_COOLDOWN_TICKS;
      b.ramAt = this.tick + RAM_COOLDOWN_TICKS;

      // Урон получают оба, даже если первый же удар кого-то убил: встречный
      // таран — это размен, а не очередь. Имена берём заранее по той же причине.
      const nameA = a.name;
      const nameB = b.name;
      if (toA > 0) this.hurt(a, toA, b.id, nameB);
      if (toB > 0) this.hurt(b, toB, a.id, nameA);
    }
  }

  /** Шаг бота: думает сам, дальше едет и стреляет по общим правилам. */
  private stepBot(bot: Player): void {
    bot.last = think(
      {
        id: bot.id,
        team: bot.team,
        dead: bot.dead,
        stealth: bot.stealth,
        state: bot.state,
        hp: bot.hp,
        brain: bot.brain!,
      },
      {
        tick: this.tick,
        obstacles: this.obstacles,
        cover: this.cover,
        tanks: this.tanks,
        stance: this.stance,
        terrain: this.relief,
        half: this.half,
      },
    );
    stepTank(bot.state, bot.last, DT, this.obstacles, 1, this.half);
    if (bot.last.fire) {
      bot.last.fire = false;
      this.tryFire(bot);
    }
  }

  private tryFire(player: Player): void {
    if (this.tick < player.readyAt) return;
    const rush = player.fx[BONUS_RELOAD] > this.tick ? BONUS_RELOAD_MUL : 1;
    player.readyAt = this.tick + Math.max(1, Math.round(RELOAD_TICKS * rush));

    const shell = spawnShell(
      this.nextShellId++,
      player.id,
      player.state,
      this.aimPitch(player),
      heightAt(this.terrain, player.state.x, player.state.z),
    );
    // Урон считаем здесь, а не при попадании: снаряд после выстрела живёт сам по себе.
    const power = player.fx[BONUS_DAMAGE] > this.tick ? BONUS_DAMAGE_MUL : 1;
    shell.dmg = Math.round(SHELL_DAMAGE * power);
    this.shells.push(shell);
    // Переполнение возможно только при явном флуде — жертвуем самым старым снарядом.
    if (this.shells.length > MAX_SHELLS) this.shells.shift();
  }

  /**
   * Рельеф для свипов — или undefined, если карта плоская. Именно undefined, а не
   * FLAT: без него свип двумерный и в точности такой, каким был до рельефа, и
   * семь аркадных карт не платят за высоту ни одной выборкой.
   */
  private get relief(): Terrain | undefined {
    return this.terrain.flat ? undefined : this.terrain;
  }

  /**
   * Вертикальная наводка, с которой уйдёт снаряд. Приходит от клиента, поэтому
   * зажимается пределами пушки здесь: на плоской карте — жёстко в ноль, чтобы
   * аркада не зависела от того, что прислал клиент.
   */
  private aimPitch(player: Player): number {
    if (this.terrain.flat) return 0;
    const want = player.last.pitch;
    if (typeof want !== 'number' || !Number.isFinite(want)) return 0;
    return clamp(want, GUN_PITCH_MIN, GUN_PITCH_MAX);
  }

  private updateShells(): void {
    for (let i = this.shells.length - 1; i >= 0; i--) {
      if (this.flyShell(this.shells[i], DT)) this.shells.splice(i, 1);
    }
    // Имя ушедшего держим ровно до тех пор, пока в воздухе есть его снаряд.
    for (const id of this.ghosts.keys()) {
      if (!this.shells.some((shell) => shell.owner === id)) this.ghosts.delete(id);
    }
  }

  /**
   * Танк покидает комнату (бот погиб, человек отключился), а его снаряды ещё летят.
   * Запоминаем имя, чтобы попадание не досталось «Неизвестному»: выстрел был сделан
   * по правилам, и то, что стрелка уже нет, к его снаряду отношения не имеет.
   */
  private forget(player: Player): void {
    if (this.shells.some((shell) => shell.owner === player.id)) {
      this.ghosts.set(player.id, player.name);
    }
  }

  /**
   * Проводит снаряд через тик. Путь режется на отрезки: до ближайшего касания,
   * а после отскока — остаток тика заново. Возвращает true, если снаряд отжил своё.
   */
  private flyShell(shell: ShellState, dt: number): boolean {
    for (let segment = 0; segment < MAX_SEGMENTS; segment++) {
      // Именно cover: на плоской карте низкое укрытие снаряд проходит насквозь.
      // На рельефе там все блоки, а заодно и сама земля — свип решает по высоте.
      const wall = sweepShell(shell, dt, this.cover, this.relief, this.half);

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
        this.boom(shell, BOOM_GROUND);
        return true;
      }

      bounceShell(shell, wall);
      this.boom(shell, BOOM_RICOCHET);
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

      const t = sweepTank(shell, dt, target.state, this.relief);
      if (t === null || t > limit) continue;
      if (best === null || t < best.t) best = { player: target, t };
    }
    return best;
  }

  private damage(victim: Player, shell: ShellState): void {
    if (this.hurt(victim, shell.dmg ?? SHELL_DAMAGE, shell.owner)) return;
    this.boom(shell, BOOM_HIT);
  }

  /**
   * Взрыв там, где снаряд остановился. Высоту шлём только с рельефом: на
   * плоскости она всегда одна и та же, и клиент знает её без сети.
   */
  private boom(shell: ShellState, kind: BoomKind): void {
    this.booms.push({
      x: shell.x,
      z: shell.z,
      k: kind,
      o: shell.owner,
      ...(this.terrain.flat ? {} : { y: round(shell.y) }),
    });
  }

  /**
   * Снять здоровье и, если оно кончилось, провести смерть. Возвращает true, если
   * танк подбит: вызывающая сторона по этому решает, показывать ли отметку
   * попадания — взрыв гибели она уже поставила сама.
   *
   * Единая точка на выстрел и на таран. Разводить их нельзя: смерть тянет за
   * собой фраг, ленту, сгорание бонусов, выбывание бота и ожидание волны, и
   * второй экземпляр этого списка разошёлся бы с первым на первой же правке.
   */
  private hurt(victim: Player, amount: number, killerId: number, name?: string): boolean {
    // Убивший мог погибнуть или выйти, пока летел снаряд. На попадание это не
    // влияет: урон снаряд принёс с собой, а имя для ленты найдётся среди ушедших.
    // Имя можно передать и явно — во встречном таране оба гибнут в одном тике,
    // и второго из них искать в комнате уже поздно.
    const killer = this.players.get(killerId);
    const killerName = name ?? killer?.name ?? this.ghosts.get(killerId) ?? 'Неизвестный';

    victim.hp -= amount;
    if (victim.hp > 0) return false;

    victim.hp = 0;
    victim.dead = true;
    victim.deaths++;
    victim.respawnAt = this.tick + RESPAWN_TICKS;
    victim.queue.length = 0;
    // Бонусы сгорают вместе с танком: копить усиления через смерть нельзя.
    victim.fx.fill(0);
    victim.stealth = false;
    this.booms.push({ x: victim.state.x, z: victim.state.z, k: BOOM_KILL, o: killerId });

    // За смерть от собственного рикошета фраг не полагается — только запись в ленту.
    if (killer && killer !== victim) killer.kills++;
    this.kills.push({ killer: killerName, victim: victim.name });

    if (victim.brain) {
      // Бот выбывает насовсем: волна кончится, когда карта опустеет. Пометка
      // killed нужна клиенту: без неё он стёр бы танк тем же кадром, и вместо
      // горящего остова бот просто исчезал бы — то же событие, что и выход из игры.
      this.forget(victim);
      this.players.delete(victim.id);
      this.emit({ t: 'left', id: victim.id, killed: true });
    } else if (this.mode === MODE_PVE) {
      // Жизнь одна на волну — в строй вернёт только её зачистка.
      victim.waiting = true;
    }
    return true;
  }

  private respawn(player: Player): void {
    const spawn = spawnPoint(this.spawnCounter++, this.mapId);
    player.state = createTankState(spawn.x, spawn.z, spawn.angle);
    player.hp = player.brain ? BOT_HP : MAX_HP;
    player.dead = false;
    player.readyAt = this.tick;
    // seq не сбрасываем: клиент продолжает свою нумерацию, ack должен остаться в её шкале.
    player.last = { seq: player.last.seq, throttle: 0, steer: 0, turret: spawn.angle };
    player.queue.length = 0;
  }

  // --- Бонусы ---

  /** Множитель хода от бонуса «Ход»; клиент подставляет в предсказание то же число. */
  private boost(player: Player): number {
    return player.fx[BONUS_SPEED] > this.tick ? BONUS_SPEED_MUL : 1;
  }

  private updateBonuses(): void {
    // Маскировку кэшируем один раз за тик: её читает ИИ каждого бота по всем целям.
    for (const player of this.players.values()) {
      player.stealth = player.fx[BONUS_STEALTH] > this.tick;
    }

    // Неподобранные ящики исчезают, иначе карта постепенно зарастает.
    for (let i = this.bonuses.length - 1; i >= 0; i--) {
      if (this.tick >= this.bonuses[i].until) this.bonuses.splice(i, 1);
    }

    if (this.bonuses.length < BONUS_MAX && this.tick >= this.bonusAt) {
      this.spawnBonus();
      this.bonusAt = this.tick + Math.round(BONUS_SPAWN_S * TICK_HZ);
    }

    // Подбирают только люди: дюжина ботов вымела бы карту раньше игрока.
    const reach = TANK_RADIUS + BONUS_RADIUS;
    for (const player of this.players.values()) {
      if (player.brain || player.dead) continue;
      for (let i = this.bonuses.length - 1; i >= 0; i--) {
        const bonus = this.bonuses[i];
        if (Math.hypot(bonus.x - player.state.x, bonus.z - player.state.z) > reach) continue;
        this.bonuses.splice(i, 1);
        this.applyBonus(player, bonus.kind);
      }
    }
  }

  private applyBonus(player: Player, kind: number): void {
    if (kind === BONUS_HEAL) {
      // Потолок берётся по самому танку: у бота он свой, и общий MAX_HP вылечил
      // бы его выше собственного максимума. Ящики боты не подбирают, но правило
      // должно быть верным само по себе, а не за счёт того, что не срабатывает.
      player.hp = Math.min(player.brain ? BOT_HP : MAX_HP, player.hp + BONUS_HEAL_HP);
    } else {
      // Второй ящик того же вида не складывается, а отсчитывает срок заново.
      player.fx[kind] = this.tick + Math.round(BONUS_DURATION_S[kind] * TICK_HZ);
    }
    this.emit({ t: 'pickup', id: player.id, kind });
  }

  private spawnBonus(): void {
    const spot = this.freeSpot();
    if (!spot) return;
    this.bonuses.push({
      id: this.nextBonusId++,
      kind: Math.floor(Math.random() * BONUS_KINDS),
      x: spot.x,
      z: spot.z,
      until: this.tick + Math.round(BONUS_LIFETIME_S * TICK_HZ),
    });
  }

  /** Свободная точка под ящик: не в блоке, не у стены и не вплотную к другому ящику. */
  private freeSpot(): { x: number; z: number } | null {
    const limit = this.half - 8;
    const pad = BONUS_RADIUS + TANK_RADIUS;

    for (let attempt = 0; attempt < 24; attempt++) {
      const x = (Math.random() * 2 - 1) * limit;
      const z = (Math.random() * 2 - 1) * limit;

      let taken = false;
      for (const box of this.obstacles) {
        if (Math.abs(x - box.x) < box.w / 2 + pad && Math.abs(z - box.z) < box.d / 2 + pad) {
          taken = true;
          break;
        }
      }
      if (taken) continue;
      // Ящики не должны лежать кучкой: иначе один заезд собирает сразу три.
      if (this.bonuses.some((b) => Math.hypot(b.x - x, b.z - z) < 16)) continue;
      return { x, z };
    }
    return null;
  }

  /** Убирает ящики и все действующие эффекты: при смене режима и при выключении бонусов. */
  private clearBonuses(): void {
    this.bonuses.length = 0;
    this.bonusAt = this.tick;
    for (const player of this.players.values()) {
      player.fx.fill(0);
      player.stealth = false;
    }
  }

  private effectMask(player: Player): number {
    let mask = 0;
    for (let kind = 0; kind < BONUS_KINDS; kind++) {
      if (player.fx[kind] > this.tick) mask |= 1 << kind;
    }
    return mask;
  }

  snapshotBonuses(): SnapshotBonus[] {
    return this.bonuses.map((b) => ({ i: b.id, k: b.kind, x: round(b.x), z: round(b.z) }));
  }

  get bonusCount(): number {
    return this.bonuses.length;
  }

  // --- Режим и волны ---

  /** Настройка комнаты хостом. Смена режима или карты перезапускает мир. */
  setup(
    mode: GameMode | undefined,
    difficulty: number | undefined,
    bonuses: boolean | undefined,
    map?: number,
    stance?: number,
    rules?: Ruleset,
  ): void {
    if (typeof difficulty === 'number' && Number.isFinite(difficulty)) {
      this.difficulty = clamp(Math.round(difficulty), 0, MAX_TIER);
    }
    if (isStance(stance)) this.stance = stance;
    if (typeof bonuses === 'boolean' && bonuses !== this.bonusesOn) {
      this.bonusesOn = bonuses;
      // Выключили — карта и все действующие усиления чистятся сразу.
      if (!bonuses) this.clearBonuses();
    }

    const newMap = isMapId(map) && map !== this.mapId;
    if (newMap) {
      this.mapId = map;
      this.scene = buildScene(this.mapId);
      this.obstacles = this.scene.obstacles;
      this.terrain = this.scene.terrain;
      this.half = this.scene.half;
      this.cover = coverBoxes(this.obstacles, this.terrain);
      // Геометрию клиент не строит сам — шлём её раньше рестарта, чтобы к первому
      // же снапшоту нового мира у него была правильная карта. Землю тем же
      // сообщением и по той же причине.
      this.emit({
        t: 'map',
        id: this.mapId,
        half: this.half,
        obstacles: this.obstacles,
        terrain: terrainNet(this.terrain),
      });
    }

    const newMode = mode !== undefined && mode !== this.mode;
    if (newMode) this.mode = mode;

    // Смена правил перезапускает бой по той же причине, что и смена режима: это
    // не настройка внутри боя, а другой бой. Заодно снимает неприятность, когда
    // подписи гаснут посреди перестрелки.
    const newRules = isRuleset(rules) && rules !== this.rules;
    if (newRules) this.rules = rules;

    if (newMap || newMode || newRules) this.restart();

    this.emitConfig();
  }

  /** Мир начинается заново: боты убраны, счёт обнулён, волны с первой. */
  private restart(): void {
    this.clearBots();
    this.clearBonuses();
    this.shells.length = 0;
    this.resetScores();
    this.wave = 0;
    this.runDifficulty = this.difficulty;
    this.phase = 'break';
    this.phaseUntil = this.tick;
    // Возрождаем всех, а не только павших: на новой карте старые координаты могут
    // оказаться внутри блока, и танк вытолкнет неизвестно куда.
    for (const player of this.players.values()) {
      player.waiting = false;
      this.respawn(player);
    }
    this.emitWave();
  }

  /**
   * Машина волн. Крутится только в MODE_PVE и только пока в комнате есть люди:
   * на пустом сервере забег не должен идти сам по себе.
   */
  private updateWave(): void {
    if (this.humanCount === 0) {
      if (this.wave !== 0) {
        this.clearBots();
        this.wave = 0;
        this.phase = 'break';
      }
      this.phaseUntil = this.tick;
      return;
    }

    if (this.phase !== 'fight') {
      if (this.tick < this.phaseUntil) return;
      this.startWave(this.phase === 'over' ? 1 : this.wave + 1);
      return;
    }

    if (this.everyoneDown()) {
      this.gameOver();
      return;
    }

    const alive = this.botCount;
    // Толпа растёт по той же лестнице, что и выучка: иначе на «Новичке» поздние
    // волны по 20 ботов ползли бы по двое и превращались в тир.
    const room = waveConcurrent(this.wave, this.humanCount, waveTier(this.wave, this.runDifficulty));
    if (this.quotaLeft > 0 && alive < room && this.tick >= this.spawnAt) {
      this.spawnBot();
    } else if (this.quotaLeft === 0 && alive === 0) {
      this.endWave();
    }
  }

  private startWave(wave: number): void {
    if (wave === 1) this.resetScores();
    // Выбор хоста вступает в силу здесь — ровно на границе волн.
    const tookEffect = this.runDifficulty !== this.difficulty;
    this.runDifficulty = this.difficulty;
    this.wave = wave;
    this.phase = 'fight';
    this.quotaLeft = waveQuota(wave);
    this.opening = WAVE_OPENING_BOTS;
    this.spawnAt = this.tick;

    // Волна начинается полным составом и с полным здоровьем: павшие встают в строй,
    // а дотянувшие на последних HP не идут в следующую волну калеками.
    for (const player of this.players.values()) {
      if (player.brain) continue;
      player.waiting = false;
      if (player.dead) this.respawn(player);
      player.hp = MAX_HP;
    }
    this.emitWave();
    // Панель настроек должна погасить пометку «ждёт следующей волны».
    if (tookEffect) this.emitConfig();
  }

  private endWave(): void {
    this.best = Math.max(this.best, this.wave);
    this.phase = 'break';
    this.phaseUntil = this.tick + Math.round(WAVE_BREAK_S * TICK_HZ);
    this.emitWave();
  }

  private gameOver(): void {
    this.best = Math.max(this.best, this.wave);
    this.clearBots();
    this.phase = 'over';
    this.phaseUntil = this.tick + Math.round(WAVE_OVER_S * TICK_HZ);
    this.emitWave();
  }

  /** Волна выпускается по одному: сразу всей толпой она задавила бы числом. */
  private spawnBot(): void {
    const base = waveTier(this.wave, this.runDifficulty);
    // «Элита» — бот на ступень выше остальных; её доля растёт с номером волны.
    const tier = Math.random() < waveElite(this.wave) ? Math.min(MAX_TIER, base + 1) : base;

    const index = this.botCounter++;
    const bot = this.create(
      botName(index),
      TEAM_BOTS,
      botSpawn(this.tanks, TEAM_BOTS, index, this.mapId),
      NO_SEND,
    );
    bot.brain = createBrain(tier, this.tick, index);
    bot.hp = BOT_HP;
    this.players.set(bot.id, bot);
    this.emit({ t: 'joined', player: this.info(bot) });

    this.quotaLeft--;
    const fast = this.opening > 0;
    if (fast) this.opening--;
    this.spawnAt = this.tick + Math.round((fast ? 0.7 : WAVE_SPAWN_DELAY_S) * TICK_HZ);
    this.emitWave();
  }

  private clearBots(): void {
    for (const [id, player] of this.players) {
      if (!player.brain) continue;
      this.players.delete(id);
      this.emit({ t: 'left', id });
    }
    this.quotaLeft = 0;
  }

  /** Все люди выбыли до конца волны — забег окончен. */
  private everyoneDown(): boolean {
    let any = false;
    for (const player of this.players.values()) {
      if (player.brain) continue;
      if (!player.waiting) return false;
      any = true;
    }
    return any;
  }

  private resetScores(): void {
    for (const player of this.players.values()) {
      player.kills = 0;
      player.deaths = 0;
    }
  }

  waveState(): WaveState {
    return {
      wave: this.wave,
      phase: this.phase,
      left: this.quotaLeft + this.botCount,
      until: this.phase === 'fight' ? 0 : Math.max(0, (this.phaseUntil - this.tick) / TICK_HZ),
      best: this.best,
    };
  }

  private emitWave(): void {
    this.emit({ t: 'wave', ...this.waveState() });
  }

  private emitConfig(): void {
    this.emit({ t: 'config', ...this.config() });
  }

  /** Настройки комнаты одним куском: их шлют и welcome, и config. */
  config(): RoomConfig {
    return {
      mapId: this.mapId,
      mode: this.mode,
      rules: this.rules,
      difficulty: this.difficulty,
      // Что реально в силе прямо сейчас: в бою это может отставать от выбора хоста.
      active: this.mode === MODE_PVE && this.phase === 'fight' ? this.runDifficulty : this.difficulty,
      stance: this.stance,
      bonuses: this.bonusesOn,
      hostId: this.hostId,
    };
  }

  /** Живых игроков-людей в комнате (боты не в счёт). */
  get humanCount(): number {
    let n = 0;
    for (const player of this.players.values()) if (!player.brain) n++;
    return n;
  }

  get botCount(): number {
    let n = 0;
    for (const player of this.players.values()) if (player.brain) n++;
    return n;
  }

  /** Снапшот общий для всех, кроме поля ack — оно у каждого своё. */
  snapshotEntries(): SnapshotEntry[] {
    const entries: SnapshotEntry[] = [];
    for (const p of this.players.values()) {
      const mask = this.bonusesOn ? this.effectMask(p) : 0;
      entries.push({
        i: p.id,
        x: round(p.state.x),
        z: round(p.state.z),
        a: round(p.state.angle),
        t: round(p.state.turret),
        s: round(p.state.speed),
        h: p.hp,
        d: p.dead ? 1 : 0,
        // Поле есть только у тех, у кого эффект реально висит — экономия трафика.
        ...(mask === 0 ? {} : { f: mask }),
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
      y: round(s.y),
      a: round(Math.atan2(s.vx, s.vz)),
      // Наклон нужен только мешу и только когда он не нулевой, то есть на рельефе.
      ...(s.vy === 0 ? {} : { p: round(Math.atan2(s.vy, Math.hypot(s.vx, s.vz))) }),
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

  /** Сколько имён ушедших стрелков держим ради их снарядов. Для проверок. */
  get ghostCount(): number {
    return this.ghosts.size;
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
