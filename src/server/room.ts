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
  ROYALE_LOOT_ARMOR,
  ROYALE_LOOT_ARMOR_HP,
  ROYALE_LOOT_DAMAGE,
  ROYALE_LOOT_DAMAGE_MUL,
  ROYALE_LOOT_RELOAD,
  ROYALE_LOOT_RELOAD_MUL,
  ROYALE_LOOT_SPEED,
  ROYALE_LOOT_SPEED_MUL,
  DT,
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
  MODE_EXPEDITION,
  MODE_ROYALE,
  MODE_TEAM,
  isSquadMode,
  isTeamBattleSize,
  TEAM_BATTLE_ROUND_S,
  TEAM_BATTLE_OVER_S,
  type TeamBattleSize,
  EXPEDITION_WAVES,
  EXPEDITION_UPGRADE_COUNT,
  EXPEDITION_UPGRADES,
  expeditionPower,
  isCoopMode,
  RAM_COOLDOWN_S,
  RELOAD_S,
  RESPAWN_S,
  SHELL_DAMAGE,
  SHELL_DAMAGE_SPREAD,
  SHELL_RADIUS,
  TANK_RADIUS,
  TICK_HZ,
  WAVE_BREAK_S,
  WAVE_OPENING_BOTS,
  WAVE_OVER_S,
  WAVE_SPAWN_DELAY_S,
  WRECK_HEIGHT,
  WRECK_COLLISION_W,
  WRECK_COLLISION_D,
  WRECK_TANK_COLLISION_RADIUS,
  royaleSquadCount,
  ROYALE_SQUAD_SIZE,
  ROYALE_START_COUNTDOWN_S,
  isRoyaleSquadSize,
  ROYALE_ZONE_FINAL_RADIUS,
  ROYALE_ZONE_REST_S,
  ROYALE_ZONE_SHRINK_S,
  ROYALE_ZONE_START_WAIT_S,
  ROYALE_ZONE_DAMAGE_S,
  ROYALE_SHOT_REVEAL_RANGE,
  ROYALE_SIGHT_RANGE,
  waveConcurrent,
  waveElite,
  waveQuota,
  waveTier,
  isRuleset,
  RULES_ARCADE,
  type GameMode,
  type RoyaleSquadSize,
  type Ruleset,
} from '../shared/constants.js';
import { buildScene, bushBoxes, bushIndexAt, coverBoxes, isMapId, passableObstacles, ROYALE_MAP_ID, spawnPoint } from '../shared/map.js';
import type { RoomConfig, RoyaleZoneState, ServerMessage, WavePhase, WaveState } from '../shared/protocol.js';
import {
  bounceShell,
  canRicochet,
  clamp,
  hitZoneDamageMul,
  resolveTankCollisions,
  spawnShell,
  stepShell,
  stepTank,
  sweepCircle,
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
  TEAM_ONE,
  TEAM_PLAYERS,
  TEAM_TWO,
  boxCollisionSize,
  circleIntersectsPolygon,
  createTankState,
  type BonusState,
  type Boom,
  type BoomKind,
  type Box,
  type HitFx,
  type Input,
  type PlayerInfo,
  type ShellState,
  type SnapshotBonus,
  type SnapshotContact,
  type SnapshotEntry,
  type SnapshotShell,
  type TankState,
  worldCollisionPolygon,
} from '../shared/types.js';
import {
  botName,
  botSpawn,
  createBrain,
  hasShot,
  think,
  type BotBrain,
  type BotSelf,
  type BotWorld,
  type BotZone,
} from './bot.js';
import { RoyaleIntel, RoyalePolicy, royaleThink } from './royaleBrain.js';
import { RoyaleSpawner, type RoyaleDrop } from './royaleSpawn.js';
import { BoxGrid } from './boxIndex.js';

/** Перезарядка и респавн считаются в тиках, чтобы жить в тех же часах, что и симуляция. */
const RELOAD_TICKS = Math.round(RELOAD_S * TICK_HZ);
const RESPAWN_TICKS = Math.round(RESPAWN_S * TICK_HZ);
const RAM_COOLDOWN_TICKS = Math.round(RAM_COOLDOWN_S * TICK_HZ);
const ROYALE_VISION_REFRESH_TICKS = Math.round(5 * TICK_HZ);
/** Выстрел ненадолго выдаёт танк даже из куста. */
const ROYALE_SHOT_REVEAL_TICKS = 2 * TICK_HZ;

/** Насколько дальше настоящего радиуса попадания снаряд ещё считается «прошёл рядом», м. */
const NEAR_MISS_MARGIN = 2.2;
// Больше диаметра танка, но достаточно мелко, чтобы в перестрелке выбирать
// лишь соседние цели, а не весь список игроков.
const TANK_CELL_SIZE = 16;
/** Подавление после близкого разрыва (или уцелевшего попадания), с. */
const SUPPRESS_S = 1.6;
const SUPPRESS_TICKS = Math.round(SUPPRESS_S * TICK_HZ);

/**
 * Дальность слуха — доля половины стороны карты, зажатая в разумных пределах:
 * на маленькой карте выстрел не должен быть слышен из другого её конца, на
 * большой — не должен превращаться в отдельный, куда более узкий обзор.
 */
const HEARING_FRAC = 0.4;
const HEARING_MIN = 25;
const HEARING_MAX = 55;
/** Дальность, на которой сторонний игрок видит цифры урона чужого боя. */
const DAMAGE_EVENT_RANGE = 120;

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
  /** Постоянные модули BR: биты соответствуют ROYALE_LOOT_*; не таймеры. */
  royaleLootMask: number;
  /** Добавка к максимуму здоровья от бронепластин BR. */
  royaleArmor: number;
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
  /** Тик, раньше которого танк подавлен — рука у бота дрожит сильнее (см. suppress). */
  suppressedUntil: number;
  kills: number;
  deaths: number;
  /** Монотонный счётчик реально принятых сервером выстрелов. */
  shots: number;
  /** Последний выстрел: в BR вспышка на короткое время раскрывает танк. */
  lastShotAt: number;
  /** Дробный остаток урона зоны; здоровье остаётся целым, DPS — точным. */
  zoneDamageRemainder: number;
  /** Очередь необработанных инпутов. */
  queue: Input[];
  /** seq последнего инпута, применённого сервером — клиент по нему делает реконсиляцию. */
  ack: number;
  /** Последний применённый инпут: если новых нет, повторяем его (клиент лагает). */
  last: Input;
  /** Бинарь — только snapshot; остальное шлётся текстовым JSON. */
  send: (data: string | ArrayBuffer) => void;
}

export interface KillEvent {
  killer: string;
  victim: string;
}

/** Итог только что законченного раунда командного боя — для доски лидеров. */
export interface TeamRoundResult {
  winner: number | 'draw';
  entries: { name: string; team: number; kills: number }[];
}

/** Внутреннее событие урона: id нужны только серверу для адресной рассылки. */
interface HitEvent extends HitFx {
  victimId: number;
  sourceId: number;
}

/** Цвета людей и ботов не пересекаются: врага видно по корпусу, а не только по нику. */
const HUMAN_COLORS = [0, 3, 1, 4, 6, 7, 2];
const BOT_COLOR = 5;

/** Никуда не отправляем: у бота нет сокета, но интерфейс Player общий. */
const NO_SEND = (): void => {};

/**
 * Фиксированные контейнеры «Рубежа». Координаты уже в масштабе карты 900×900;
 * при запуске на тестовой карте они масштабируются к её размеру и проверяются
 * на свободное место. Числа задают районы, а не случайную россыпь по полю.
 */
const ROYALE_LOOT_LAYOUT: Array<[number, number, number]> = [
  [0, 0, BONUS_HEAL],
  [-160, 128, ROYALE_LOOT_ARMOR],
  [160, 128, ROYALE_LOOT_DAMAGE],
  [-160, -128, ROYALE_LOOT_RELOAD],
  [160, -128, ROYALE_LOOT_SPEED],
  [0, 240, BONUS_HEAL],
  [0, -240, BONUS_HEAL],
  [240, 0, ROYALE_LOOT_DAMAGE],
  [-240, 0, ROYALE_LOOT_RELOAD],
  [-112, 240, ROYALE_LOOT_ARMOR],
  [128, -240, ROYALE_LOOT_SPEED],
  [224, 176, BONUS_HEAL],
];

/**
 * Одна комната на весь сервер. Карта общая, все видят всех; режим и сложность
 * переключает хост — первый вошедший игрок.
 */
export class Room {
  private scene = buildScene(0);
  /** Геометрия текущей карты. Меняется целиком при смене карты. */
  obstacles: Box[] = this.scene.obstacles;
  /**
   * Половина стороны текущей карты, м. У больших карт она вчетверо больше
   * площадью, поэтому размер ходит вместе с геометрией, а не берётся из
   * константы: иначе стена стояла бы там, где её никто не рисовал.
   */
  half: number = this.scene.half;
  /** Блоки, по которым свип ведёт снаряд. Пересобирается со сменой карты. */
  cover: Box[] = coverBoxes(this.obstacles);
  /** Кусты карты — рвут обзор ИИ ботов (см. bot.ts, hasShot), на экран игрока не влияют. */
  bushes: Box[] = bushBoxes(this.obstacles);
  /** obstacles без кустов — по этому списку едет танк, кусты не мешают. */
  private moveObstacles: Box[] = passableObstacles(this.obstacles);
  /**
   * То же самое, но раз в тик дополненное остовами подбитых танков (см.
   * refreshWrecks): по ним и едут, и стреляют, и объезжают, а `obstacles`/
   * `cover` выше остаются чистой геометрией карты — их читают сетевое
   * сообщение `'map'` и скрипты проверки.
   */
  private liveObstacles: Box[] = this.moveObstacles;
  private liveCover: Box[] = this.cover;
  private obstacleIndex = new BoxGrid(this.moveObstacles);
  private coverIndex = new BoxGrid(this.cover);
  private bushIndex = new BoxGrid(this.bushes);
  private liveObstacleIndex = this.obstacleIndex;
  private liveCoverIndex = this.coverIndex;
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
  /** Усиления всей команды в текущем забеге экспедиции. */
  private expeditionUpgrades: number[] = [];
  private upgradeChoices: number[] = [];
  private victory = false;

  // --- Состояние королевской битвы ---
  private royaleStarted = false;
  private royaleOver = false;
  private royalePhase: 'countdown' | 'fight' | 'over' = 'countdown';
  private royalePhaseUntil = 0;
  private royaleZone: {
    x: number;
    z: number;
    r: number;
    fromX: number;
    fromZ: number;
    fromR: number;
    nextX: number;
    nextZ: number;
    nextR: number;
    phase: RoyaleZoneState['phase'];
    step: number;
    endsAt: number;
  } = {
    x: 0,
    z: 0,
    r: 0,
    fromX: 0,
    fromZ: 0,
    fromR: 0,
    nextX: 0,
    nextZ: 0,
    nextR: 0,
    phase: 'safe',
    step: 0,
    endsAt: 0,
  };
  /** Командная память о последнем контакте: team -> enemy id -> point + expiry. */
  private readonly royaleContacts = new Map<number, Map<number, { x: number; z: number; until: number }>>();
  /** Общий засвет сквада: команда -> враги, которых видит хотя бы один союзник. */
  private readonly royaleVision = new Map<number, Set<number>>();
  /** Личная видимость каждого живого наблюдателя; из неё собирается royaleVision сквада. */
  private readonly royaleSight = new Map<number, Set<number>>();
  /** Цели, чья видимость изменилась без движения: выстрел, смерть, окончание засвета. */
  private readonly royaleVisionEvents = new Set<number>();
  private royaleVisionTick = -Infinity;
  /** BR-слой ИИ (см. royaleBrain.ts): знание сквада и BR-тактика поверх общего think(). */
  private readonly royaleIntel = new RoyaleIntel();
  private readonly royalePolicy = new RoyalePolicy(this.royaleIntel);

  // --- Состояние командного боя ---
  private teamStarted = false;
  /** Выбор хоста: сколько человек и ботов на стороне, 5 или 10. */
  teamSize: TeamBattleSize = 5;
  /** Формат отряда BR: 1 — соло, 2 — дуо, 4 — сквад. */
  royaleSquadSize: RoyaleSquadSize = ROYALE_SQUAD_SIZE;
  private teamPhase: 'fight' | 'over' = 'fight';
  /** Тик, на котором кончится экран итогов и начнётся новый раунд. */
  private teamPhaseUntil = 0;
  /** Тик, на котором раунд обрывается ничьёй, если бой ещё не решён. */
  private teamRoundEndsAt = 0;
  private teamWinner: number | 'draw' | null = null;
  /** Итог только что законченного раунда — на один drain, как kills. */
  private teamResult: TeamRoundResult | null = null;

  /**
   * Живой список танков для ИИ. Именно объект, а не players.values(): итератор
   * одноразовый, а think() проходит по танкам несколько раз за тик.
   */
  private readonly tanks: Iterable<Player> = {
    [Symbol.iterator]: () => this.players.values(),
  };

  private readonly shells: ShellState[] = [];
  /**
   * Динамическая широкая фаза для снарядов. Перестраивается после движения
   * танков и хранит только их центры: точную sweep-проверку по кругу всё равно
   * выполняем ниже. Так залп не делает два полных прохода по всем игрокам на
   * каждый снаряд.
   */
  private readonly tankCells = new Map<string, Player[]>();
  /** Имена ушедших стрелков, чьи снаряды ещё в воздухе. Чистится в updateShells. */
  private readonly ghosts = new Map<number, string>();
  /** Ящики на карте. Публичны по той же причине, что и players: их гоняют проверки. */
  readonly bonuses: BonusState[] = [];
  private nextBonusId = 1;
  /** Тик, на котором на карте появится следующий ящик. */
  private bonusAt = 0;

  /** События одного тика: очищаются в начале update(), забираются после. */
  private booms: Boom[] = [];
  /** Сумма урона по каждому попаданию — снаряд ли, таран ли, клиент рисует цифрой. */
  private hits: HitEvent[] = [];
  private kills: KillEvent[] = [];

  /** emit рассылает сообщение всем людям в комнате; в тестах его можно не давать. */
  constructor(private readonly emit: (msg: ServerMessage) => void = () => {}) {}

  add(name: string, send: (data: string | ArrayBuffer) => void): Player {
    const spawn = spawnPoint(this.spawnCounter++, this.mapId);
    const player = this.create(sanitizeName(name), TEAM_PLAYERS, spawn, send);
    player.color = HUMAN_COLORS[this.humanCount % HUMAN_COLORS.length];
    this.players.set(player.id, player);

    // Хост — первый вошедший: он и настраивает комнату.
    if (this.hostId === 0) {
      this.hostId = player.id;
      this.emitConfig();
    }
    // Волна или раунд уже идут — новичок ждёт конца, иначе он выпал бы в гущу боя.
    if (
      (isCoopMode(this.mode) && this.phase === 'fight') ||
      (this.mode === MODE_TEAM && this.teamPhase === 'fight')
    ) {
      player.waiting = true;
    }
    if (player.waiting) player.dead = true;

    return player;
  }

  private create(
    name: string,
    team: number,
    spawn: { x: number; z: number; angle: number },
    send: (data: string | ArrayBuffer) => void,
  ): Player {
    return {
      id: this.nextId++,
      name,
      color: BOT_COLOR,
      team,
      brain: null,
      waiting: false,
      fx: new Array<number>(BONUS_KINDS).fill(0),
      royaleLootMask: 0,
      royaleArmor: 0,
      stealth: false,
      state: this.spawnState(spawn),
      hp: MAX_HP,
      dead: false,
      respawnAt: 0,
      readyAt: 0,
      ramAt: 0,
      suppressedUntil: 0,
      kills: 0,
      deaths: 0,
      shots: 0,
      lastShotAt: -Infinity,
      zoneDamageRemainder: 0,
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
    if (this.mode === MODE_ROYALE && this.royaleStarted) this.emitWave();
    // Ушедший мог быть единственным, кто держал врага в засвете для сквада.
    this.royaleSight.delete(id);
    this.royaleVisionEvents.delete(id);
    this.invalidateRoyaleVision();
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
    this.hits = [];

    if (isCoopMode(this.mode)) this.updateWave();
    if (this.mode === MODE_ROYALE) this.updateRoyale();
    if (this.mode === MODE_TEAM) this.updateTeamBattle();
    if (this.bonusesOn) this.updateBonuses();
    this.refreshWrecks();
    // Снимок нужен до движения, включая разворот бота и расталкивание корпусов:
    // в конце тика по нему определяем, кто действительно сдвинулся.
    const royalePositions = this.mode === MODE_ROYALE
      ? new Map([...this.players.values()].map((player) => [player.id, { x: player.state.x, z: player.state.z }]))
      : null;

    for (const player of this.players.values()) {
      if (player.brain) {
        this.stepBot(player);
        continue;
      }
      // Ждущий конца волны не возрождается по таймеру — его поднимет сама волна.
      // В BR и в командном бою жизнь одна на раунд — respawnAt тут не действует.
      if (
        player.dead &&
        !player.waiting &&
        this.mode !== MODE_ROYALE &&
        this.mode !== MODE_TEAM &&
        this.tick >= player.respawnAt
      ) {
        this.respawn(player);
      }

      // До сигнала старта состав уже виден, но никто не может случайно
      // уехать со спавна или открыть огонь во время предстартового отсчёта.
      if (this.mode === MODE_ROYALE && this.royalePhase !== 'fight') {
        player.queue.length = 0;
        player.last.fire = false;
        continue;
      }

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
        // Подбитый танк не едет и не стреляет, что бы ни прислал клиент. Ему
        // самому список остовов не нужен — с нулевым газом это лишь риск
        // упереться в собственный только что появившийся труп-препятствие;
        // живым его видят остальные через liveObstacles.
        stepTank(
          player.state,
          player.dead ? frozen(player) : player.last,
          DT,
          player.dead ? this.moveObstacles : this.liveObstacles,
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
    this.refreshTankCells();
    this.updateShells();
    if (royalePositions) this.refreshRoyaleVisionAfterMovement(royalePositions);
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
      if (isSquadMode(this.mode) && a.team === b.team) continue;
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

  /** Случайный центр вложенного круга; препятствия на карте здесь не учитываются. */
  private randomZoneCenter(outerX: number, outerZ: number, outerR: number, innerR: number): { x: number; z: number } {
    const maxShift = Math.max(0, outerR - innerR - 2);
    const mapLimit = Math.max(0, this.half - innerR - 2);
    for (let attempt = 0; attempt < 128; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.sqrt(Math.random()) * maxShift;
      const x = outerX + Math.cos(angle) * distance;
      const z = outerZ + Math.sin(angle) * distance;
      if (Math.abs(x) <= mapLimit && Math.abs(z) <= mapLimit) return { x, z };
    }
    // Текущий центр уже находится в допустимом квадрате: новый радиус меньше,
    // поэтому оставить центр на месте — безопасный fallback.
    return { x: outerX, z: outerZ };
  }

  private planNextRoyaleZone(): void {
    const zone = this.royaleZone;
    zone.nextR = Math.max(ROYALE_ZONE_FINAL_RADIUS, zone.r * 0.58);
    const next = this.randomZoneCenter(zone.x, zone.z, zone.r, zone.nextR);
    zone.nextX = next.x;
    zone.nextZ = next.z;
  }

  /** Подготовить сквады выбранного размера для первого запуска BR. Возрождений здесь нет. */
  private startRoyale(): void {
    this.royaleStarted = true;
    this.royaleOver = false;
    this.royalePhase = 'countdown';
    this.royalePhaseUntil = this.tick + Math.round(ROYALE_START_COUNTDOWN_S * TICK_HZ);
    this.royaleVision.clear();
    this.royaleSight.clear();
    this.royaleVisionEvents.clear();
    this.royaleVisionTick = -Infinity;
    this.royaleIntel.clear();

    // Стартовый круг центрирован на карте, а каждый следующий получает новый
    // случайный, но вложенный центр — маршрут остаётся непредсказуемым.
    const centerX = 0;
    const centerZ = 0;
    // Круг с запасом накрывает даже углы квадратной карты; урон начинается
    // только после предстартового отсчёта, а сжатие — после ожидания.
    const startRadius = Math.hypot(this.half, this.half) + 5;
    this.royaleZone = {
      x: centerX,
      z: centerZ,
      r: startRadius,
      fromX: centerX,
      fromZ: centerZ,
      fromR: startRadius,
      nextX: centerX,
      nextZ: centerZ,
      nextR: startRadius,
      phase: 'safe',
      step: 0,
      endsAt: 0,
    };
    this.planNextRoyaleZone();
    this.spawnRoyaleLoot();

    // Один спавнер на весь матч: он копит уже занятые точки по ходу расстановки,
    // так что сквады не садятся друг другу в корпус, хотя точка для каждого —
    // случайная, где угодно внутри зоны (она пока и есть вся карта).
    const spawner = new RoyaleSpawner(this.half, this.moveObstacles);
    const squadCount = royaleSquadCount(this.royaleSquadSize);
    const drops = new Map<number, RoyaleDrop[]>();
    const dropFor = (team: number): RoyaleDrop[] => {
      let drop = drops.get(team);
      if (!drop) {
        drop = spawner.squadDrop(this.royaleZone, this.royaleSquadSize);
        drops.set(team, drop);
      }
      return drop;
    };

    // Люди распределяются по сквадам по порядку входа. В соло каждый получает
    // отдельную команду, в дуо — по два места, в скваде — до четырёх.
    const humans = [...this.players.values()].filter((player) => !player.brain).sort((a, b) => a.id - b.id);
    humans.forEach((player, index) => {
      const team = Math.floor(index / this.royaleSquadSize);
      player.team = team;
      // Перемещаем людей на ту же случайную точку высадки, которую получат их
      // союзные боты. Иначе бот-напарник был бы рядом с игроком только по
      // team id, но физически оставался бы в другом месте карты.
      this.respawn(player, dropFor(team)[index % this.royaleSquadSize]);
    });

    // Заполняем все сквады ботами, включая свободные места в людском.
    for (let team = 0; team < squadCount; team++) {
      while (this.countTeam(team) < this.royaleSquadSize) {
        this.spawnRoyaleBot(team, dropFor(team)[this.countTeam(team)]);
      }
    }
    this.emitWave();
  }

  private spawnRoyaleBot(team: number, spawn: RoyaleDrop): void {
    const index = this.botCounter++;
    const bot = this.create(botName(index), team, spawn, NO_SEND);
    const tier = Math.min(MAX_TIER, this.difficulty + (team === TEAM_PLAYERS ? 0 : Math.random() < 0.25 ? 1 : 0));
    bot.brain = createBrain(tier, this.tick, index);
    bot.hp = BOT_HP;
    this.players.set(bot.id, bot);
    this.emit({ t: 'joined', player: this.info(bot) });
  }

  private countTeam(team: number): number {
    let count = 0;
    for (const player of this.players.values()) if (player.team === team) count++;
    return count;
  }

  /**
   * Машина раунда командного боя: одна жизнь на раунд, до полного уничтожения
   * одной из сторон или до истечения TEAM_BATTLE_ROUND_S — тогда ничья.
   */
  private updateTeamBattle(): void {
    if (this.humanCount === 0) {
      if (this.teamStarted) this.clearBots();
      this.teamStarted = false;
      this.teamWinner = null;
      return;
    }

    if (!this.teamStarted || this.teamPhase !== 'fight') {
      if (this.teamStarted && this.tick < this.teamPhaseUntil) return;
      this.startTeamRound();
      return;
    }

    const { a, b } = this.teamAliveCounts();
    if (a === 0 || b === 0) {
      this.teamWinner = a === 0 && b === 0 ? 'draw' : a === 0 ? TEAM_TWO : TEAM_ONE;
      this.endTeamRound();
      return;
    }
    if (this.tick >= this.teamRoundEndsAt) {
      this.teamWinner = 'draw';
      this.endTeamRound();
    }
  }

  /**
   * Стартует (или начинает заново) раунд: разводит текущих людей по двум
   * сторонам через одного по возрастанию id — стабильно, без выбора игрока, и
   * при каждом реванше тасует стороны заново, — и добивает ботами до teamSize
   * с каждой стороны.
   */
  private startTeamRound(): void {
    this.clearBots();
    this.teamStarted = true;
    this.teamPhase = 'fight';
    this.teamRoundEndsAt = this.tick + Math.round(TEAM_BATTLE_ROUND_S * TICK_HZ);
    this.teamWinner = null;
    this.resetScores();

    const humans = [...this.players.values()].filter((p) => !p.brain).sort((a, b) => a.id - b.id);
    humans.forEach((player, index) => {
      player.team = index % 2 === 0 ? TEAM_ONE : TEAM_TWO;
      player.waiting = false;
      this.respawn(player, botSpawn(this.tanks, player.team, this.spawnCounter++, this.mapId));
    });

    for (const team of [TEAM_ONE, TEAM_TWO]) {
      while (this.countTeam(team) < this.teamSize) this.spawnTeamBot(team);
    }
    this.emitWave();
  }

  private spawnTeamBot(team: number): void {
    const index = this.botCounter++;
    const bot = this.create(botName(index), team, botSpawn(this.tanks, team, index, this.mapId), NO_SEND);
    bot.brain = createBrain(this.difficulty, this.tick, index);
    bot.hp = BOT_HP;
    this.players.set(bot.id, bot);
    this.emit({ t: 'joined', player: this.info(bot) });
  }

  /** Итог раунда — участникам-людям, доска лидеров считает его уже сама. */
  private endTeamRound(): void {
    const entries = [...this.players.values()]
      .filter((p) => !p.brain)
      .map((p) => ({ name: p.name, team: p.team, kills: p.kills }));
    this.teamResult = { winner: this.teamWinner!, entries };
    this.teamPhase = 'over';
    this.teamPhaseUntil = this.tick + Math.round(TEAM_BATTLE_OVER_S * TICK_HZ);
    this.emitWave();
  }

  private teamAliveCounts(): { a: number; b: number } {
    let a = 0;
    let b = 0;
    for (const player of this.players.values()) {
      if (player.dead) continue;
      if (player.team === TEAM_ONE) a++;
      else if (player.team === TEAM_TWO) b++;
    }
    return { a, b };
  }

  /** Забирает итог только что законченного раунда; вызывать раз за тик, как drainKills. */
  drainTeamResult(): TeamRoundResult | null {
    const result = this.teamResult;
    this.teamResult = null;
    return result;
  }

  /** Машина матча BR: один старт, затем зона, урон снаружи и проверка победителя. */
  private updateRoyale(): void {
    if (this.humanCount === 0) {
      if (this.royaleStarted) this.clearBots();
      this.royaleContacts.clear();
      this.royaleVision.clear();
      this.royaleSight.clear();
      this.royaleVisionEvents.clear();
      this.royaleVisionTick = -Infinity;
      this.royaleIntel.clear();
      this.royaleStarted = false;
      this.royaleOver = false;
      this.royalePhase = 'countdown';
      this.royalePhaseUntil = 0;
      return;
    }
    if (!this.royaleStarted) this.startRoyale();
    if (this.royaleOver) return;

    if (this.royalePhase === 'countdown') {
      if (this.tick < this.royalePhaseUntil) return;
      this.royalePhase = 'fight';
      this.royalePhaseUntil = 0;
      this.royaleZone.endsAt = this.tick + Math.round(ROYALE_ZONE_START_WAIT_S * TICK_HZ);
      this.emitWave();
    }

    this.updateRoyaleZone();
    this.refreshRoyaleVision();
    for (const player of this.players.values()) {
      if (player.dead) continue;
      const outside = Math.hypot(player.state.x - this.royaleZone.x, player.state.z - this.royaleZone.z) > this.royaleZone.r;
      if (!outside) {
        player.zoneDamageRemainder = 0;
        continue;
      }
      player.zoneDamageRemainder += this.royaleZoneDamage() * DT;
      const damage = Math.floor(player.zoneDamageRemainder + 1e-9);
      if (damage <= 0) continue;
      player.zoneDamageRemainder -= damage;
      this.hurt(player, damage, -1, 'Зона');
    }

    const aliveTeams = new Set<number>();
    for (const player of this.players.values()) if (!player.dead) aliveTeams.add(player.team);
    if (aliveTeams.size <= 1) {
      this.royaleOver = true;
      this.royalePhase = 'over';
      this.royalePhaseUntil = 0;
      this.royaleZone.phase = 'over';
      this.royaleZone.endsAt = 0;
      this.emitWave();
    }
  }

  private updateRoyaleZone(): void {
    const zone = this.royaleZone;
    if (zone.phase === 'over' || zone.phase === 'final') return;

    if (zone.phase === 'safe') {
      if (this.tick < zone.endsAt) return;
      zone.phase = 'shrinking';
      zone.fromR = zone.r;
      zone.fromX = zone.x;
      zone.fromZ = zone.z;
      zone.endsAt = this.tick + Math.round(ROYALE_ZONE_SHRINK_S * TICK_HZ);
    }

    if (zone.phase !== 'shrinking') return;
    const duration = Math.round(ROYALE_ZONE_SHRINK_S * TICK_HZ);
    const startedAt = zone.endsAt - duration;
    const progress = clamp((this.tick - startedAt) / duration, 0, 1);
    zone.r = zone.fromR + (zone.nextR - zone.fromR) * progress;
    zone.x = zone.fromX + (zone.nextX - zone.fromX) * progress;
    zone.z = zone.fromZ + (zone.nextZ - zone.fromZ) * progress;
    if (progress < 1) return;

    zone.r = zone.nextR;
    zone.x = zone.nextX;
    zone.z = zone.nextZ;
    zone.step++;
    if (zone.r <= ROYALE_ZONE_FINAL_RADIUS + 0.01) {
      zone.phase = 'final';
      zone.endsAt = 0;
    } else {
      zone.phase = 'safe';
      zone.endsAt = this.tick + Math.round(ROYALE_ZONE_REST_S * TICK_HZ);
      this.planNextRoyaleZone();
    }
  }

  private royaleZoneDamage(): number {
    return ROYALE_ZONE_DAMAGE_S[Math.min(this.royaleZone.step, ROYALE_ZONE_DAMAGE_S.length - 1)];
  }

  royaleZoneState(): RoyaleZoneState | undefined {
    if (this.mode !== MODE_ROYALE || !this.royaleStarted || this.royalePhase !== 'fight') return undefined;
    return {
      x: round(this.royaleZone.x),
      z: round(this.royaleZone.z),
      nextX: round(this.royaleZone.nextX),
      nextZ: round(this.royaleZone.nextZ),
      r: round(this.royaleZone.r),
      nextR: round(this.royaleZone.nextR),
      until: this.royaleZone.endsAt > 0 ? Math.max(0, (this.royaleZone.endsAt - this.tick) / TICK_HZ) : 0,
      phase: this.royaleZone.phase,
      damage: this.royaleZoneDamage(),
    };
  }

  /** Шаг бота: думает сам, дальше едет и стреляет по общим правилам. */
  private stepBot(bot: Player): void {
    // Труп не думает и не едет: иначе он рулил бы по инерции последнего инпута.
    if (bot.dead) return;
    if (this.mode === MODE_ROYALE && this.royalePhase !== 'fight') return;
    const self: BotSelf = {
      id: bot.id,
      team: bot.team,
      dead: bot.dead,
      stealth: bot.stealth,
      state: bot.state,
      hp: bot.hp,
      brain: bot.brain!,
      suppressed: this.tick < bot.suppressedUntil,
    };
    const world: BotWorld = {
      tick: this.tick,
      obstacles: this.liveObstacles,
      obstacleIndex: this.liveObstacleIndex,
      cover: this.liveCover,
      coverIndex: this.liveCoverIndex,
      bushes: this.bushes,
      bushIndex: this.bushIndex,
      tanks: this.tanks,
      shells: this.shells,
      stance: this.stance,
      half: this.half,
      zone: this.mode === MODE_ROYALE ? this.botZoneState() : undefined,
    };
    // BR думает отдельным слоем (см. royaleBrain.ts) — играет на выживание, а
    // не только на фраги; остальные режимы — тем же think(), что и раньше.
    bot.last =
      this.mode === MODE_ROYALE
        ? royaleThink(self, world, this.royaleIntel, this.royalePolicy)
        : think(self, world);
    stepTank(bot.state, bot.last, DT, this.liveObstacles, 1, this.half);
    if (bot.last.fire) {
      bot.last.fire = false;
      this.tryFire(bot);
    }
  }

  private botZoneState(): BotZone | undefined {
    if (!this.royaleStarted) return undefined;
    return {
      x: this.royaleZone.x,
      z: this.royaleZone.z,
      nextX: this.royaleZone.nextX,
      nextZ: this.royaleZone.nextZ,
      r: this.royaleZone.r,
      nextR: this.royaleZone.nextR,
      until: this.royaleZone.endsAt > 0 ? Math.max(0, (this.royaleZone.endsAt - this.tick) / TICK_HZ) : 0,
      phase: this.royaleZone.phase,
    };
  }

  private tryFire(player: Player): void {
    if (this.tick < player.readyAt) return;
    const rush = this.mode === MODE_ROYALE
      ? (player.royaleLootMask & (1 << ROYALE_LOOT_RELOAD) ? ROYALE_LOOT_RELOAD_MUL : 1)
      : player.fx[BONUS_RELOAD] > this.tick ? BONUS_RELOAD_MUL : 1;
    const expeditionReload = player.brain ? 1 : this.expeditionStats().reload;
    player.readyAt = this.tick + Math.max(1, Math.round(RELOAD_TICKS * rush * expeditionReload));

    const shell = spawnShell(this.nextShellId++, player.id, player.state);
    player.shots++;
    player.lastShotAt = this.tick;
    if (this.mode === MODE_ROYALE) this.royaleVisionEvents.add(player.id);
    // Урон считаем здесь, а не при попадании: снаряд после выстрела живёт сам по себе.
    const power =
      (this.mode === MODE_ROYALE
        ? (player.royaleLootMask & (1 << ROYALE_LOOT_DAMAGE) ? ROYALE_LOOT_DAMAGE_MUL : 1)
        : player.fx[BONUS_DAMAGE] > this.tick ? BONUS_DAMAGE_MUL : 1) *
      (player.brain ? 1 : this.expeditionStats().damage);
    // Разброс берётся на выстреле, а не на попадании: снаряд после этого несёт
    // свой урон сам, и рикошет не перекатывает кубик заново.
    const spread = 1 + (Math.random() * 2 - 1) * SHELL_DAMAGE_SPREAD;
    shell.dmg = Math.round(SHELL_DAMAGE * power * spread);
    this.shells.push(shell);
    // Переполнение возможно только при явном флуде — жертвуем самым старым снарядом.
    if (this.shells.length > MAX_SHELLS) this.shells.shift();

    // Слух: выстрел рядом заметен и без визуального контакта — в отличие от
    // hasShot(), тут нарочно нет проверки стен, звук идёт не по лучу зрения.
    const hearing = clamp(this.half * HEARING_FRAC, HEARING_MIN, HEARING_MAX);
    for (const bot of this.players.values()) {
      if (!bot.brain || bot.dead) continue;
      if (Math.hypot(bot.state.x - player.state.x, bot.state.z - player.state.z) <= hearing) {
        this.notice(bot, player);
      }
    }
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
   * Бот узнаёт, где враг, не видя его: попадание по себе или выстрел рядом —
   * тем же механизмом «помню, где видел», что и при потере цели из виду (см.
   * bot.ts think()). Не перебивает бота, который прямо сейчас реально видит
   * цель — случайный выстрел издали от третьего не должен сдёргивать его с боя.
   */
  private notice(bot: Player, source: Player): void {
    if (!bot.brain || bot.brain.engaged) return;
    if (source.id === bot.id || source.team === bot.team || source.dead) return;
    bot.brain.targetId = source.id;
    bot.brain.lastX = source.state.x;
    bot.brain.lastZ = source.state.z;
    bot.brain.lastSeenAt = this.tick;
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
   * Живая геометрия на этот тик: карта плюс остовы подбитых. Труп не убирают
   * до возрождения — в PvE это конец волны, в DM короткий таймер респауна, —
   * и всё это время он держит выстрел и перекрывает путь, как обычный блок.
   * След остова соответствует гусеницам модели, а не кругу попадания живого
   * танка: иначе по краю нарисованного остова выстрел останавливался в пустоте.
   */
  private refreshWrecks(): void {
    const wrecks: Box[] = [];
    for (const p of this.players.values()) {
      if (!p.dead) continue;
      wrecks.push({
        x: p.state.x,
        z: p.state.z,
        w: WRECK_COLLISION_W,
        d: WRECK_COLLISION_D,
        collisionTankRadius: WRECK_TANK_COLLISION_RADIUS,
        h: WRECK_HEIGHT,
      });
    }
    this.liveObstacles = wrecks.length ? [...this.moveObstacles, ...wrecks] : this.moveObstacles;
    // WRECK_HEIGHT ≥ SHELL_HEIGHT — труп сам себе укрытие, отдельный фильтр не нужен.
    this.liveCover = wrecks.length ? [...this.cover, ...wrecks] : this.cover;
    this.liveObstacleIndex = wrecks.length ? new BoxGrid(this.liveObstacles) : this.obstacleIndex;
    this.liveCoverIndex = wrecks.length ? new BoxGrid(this.liveCover) : this.coverIndex;
  }

  /**
   * Проводит снаряд через тик. Путь режется на отрезки: до ближайшего касания,
   * а после отскока — остаток тика заново. Возвращает true, если снаряд отжил своё.
   */
  private flyShell(shell: ShellState, dt: number): boolean {
    for (let segment = 0; segment < MAX_SEGMENTS; segment++) {
      // Именно cover: низкое укрытие снаряд проходит насквозь.
      const wall = sweepShell(shell, dt, this.liveCover, this.half);
      // Один список кандидатов годится и для попадания, и для near-miss:
      // второму нужен чуть больший радиус, поэтому он и задаёт padding.
      const targets = this.tankCandidates(shell, dt, wall ? wall.t : 1);

      // Танк на отрезке важнее стены за ним, поэтому ищем его только до касания.
      const victim = this.firstVictim(shell, dt, wall ? wall.t : 1, targets);
      if (victim) {
        stepShell(shell, dt * victim.t);
        this.damage(victim.player, shell);
        return true;
      }

      const grazed = this.grazed(shell, dt, wall ? wall.t : 1, targets);
      if (grazed.length > 0) {
        const shooter = this.players.get(shell.owner);
        for (const near of grazed) {
          // Трассер прошёл рядом — заметно и без прямого попадания, даже если
          // стрелявший был далеко и звук выстрела туда не долетел (см. tryFire).
          if (shooter) this.notice(near, shooter);
        }
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
    targets: Player[],
  ): { player: Player; t: number } | null {
    let best: { player: Player; t: number } | null = null;
    const shooter = this.players.get(shell.owner);
    for (const target of targets) {
      if (target.dead) continue;
      // В себя можно попасть только рикошетом: иначе снаряд убивал бы стрелка на вылете.
      if (target.id === shell.owner && shell.bounces === 0) continue;
      if (isSquadMode(this.mode) && shooter && target.team === shooter.team) continue;

      const t = sweepTank(shell, dt, target.state);
      if (t === null || t > limit) continue;
      if (best === null || t < best.t) best = { player: target, t };
    }
    return best;
  }

  /**
   * Живые танки, мимо которых снаряд на этом отрезке прошёл близко, но не задел —
   * тот же перебор, что firstVictim, увеличенным радиусом. Своего стрелка не считаю
   * никогда (не пугаться собственного дула), даже на рикошете.
   */
  private grazed(shell: ShellState, dt: number, limit: number, targets: Player[]): Player[] {
    const r = TANK_RADIUS + SHELL_RADIUS + NEAR_MISS_MARGIN;
    const near: Player[] = [];
    for (const target of targets) {
      if (target.dead || target.id === shell.owner) continue;
      const t = sweepCircle(shell, dt, target.state.x, target.state.z, r);
      if (t === null || t > limit) continue;
      // Настоящее попадание уже ушло бы отдельной веткой (firstVictim), сюда не заходя,
      // но на отскоке снаряд мог зацепить кого-то ещё этим же отрезком — не дублируем.
      if (sweepTank(shell, dt, target.state) !== null) continue;
      near.push(target);
    }
    return near;
  }

  /** Один танк попадает ровно в одну ячейку; перестройка стоит O(живых танков). */
  private refreshTankCells(): void {
    this.tankCells.clear();
    for (const player of this.players.values()) {
      if (player.dead) continue;
      const key = this.tankCellKey(player.state.x, player.state.z);
      const cell = this.tankCells.get(key);
      if (cell) cell.push(player);
      else this.tankCells.set(key, [player]);
    }
  }

  /**
   * Все ячейки, до которых снаряд может дотянуться на текущем отрезке, с
   * запасом под радиус near-miss. Центр танка из такой области не теряется на
   * границе ячейки, а лишние кандидаты отсекает точный sweepCircle.
   */
  private tankCandidates(shell: ShellState, dt: number, limit: number): Player[] {
    const padding = TANK_RADIUS + SHELL_RADIUS + NEAR_MISS_MARGIN;
    const endX = shell.x + shell.vx * dt * limit;
    const endZ = shell.z + shell.vz * dt * limit;
    const minX = Math.floor((Math.min(shell.x, endX) - padding) / TANK_CELL_SIZE);
    const maxX = Math.floor((Math.max(shell.x, endX) + padding) / TANK_CELL_SIZE);
    const minZ = Math.floor((Math.min(shell.z, endZ) - padding) / TANK_CELL_SIZE);
    const maxZ = Math.floor((Math.max(shell.z, endZ) + padding) / TANK_CELL_SIZE);
    const candidates: Player[] = [];
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        const cell = this.tankCells.get(`${x}:${z}`);
        if (cell) candidates.push(...cell);
      }
    }
    return candidates;
  }

  private tankCellKey(x: number, z: number): string {
    return `${Math.floor(x / TANK_CELL_SIZE)}:${Math.floor(z / TANK_CELL_SIZE)}`;
  }

  /** Уцелевшее попадание на время сбивает точность. */
  private suppress(target: Player): void {
    target.suppressedUntil = this.tick + SUPPRESS_TICKS;
  }

  private damage(victim: Player, shell: ShellState): void {
    // Зона считается по курсу корпуса в момент попадания, а не по башне: бронирует
    // корпус, и башня, довёрнутая в сторону, зону не меняет.
    const amount = Math.round((shell.dmg ?? SHELL_DAMAGE) * hitZoneDamageMul(shell, victim.state.angle));
    if (this.hurt(victim, amount, shell.owner)) return;
    this.boom(shell, BOOM_HIT);
  }

  /** Взрыв там, где снаряд остановился. */
  private boom(shell: ShellState, kind: BoomKind): void {
    this.booms.push({ x: shell.x, z: shell.z, k: kind, o: shell.owner });
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

    // Цифра всплывает там, где сейчас стоит жертва, — не там, где снаряд взорвался
    // (у тарана взрыва вовсе нет), и одна точка годится и на выстрел, и на таран.
    this.hits.push({
      x: victim.state.x,
      z: victim.state.z,
      amount,
      victimId: victim.id,
      sourceId: killerId,
    });

    victim.hp -= amount;
    if (victim.hp > 0) {
      // Выжил, но словил трассер: даже без визуального контакта бот понимает,
      // с чьей стороны прилетело, и вправе пойти проверить.
      if (killer) this.notice(victim, killer);
      // Попадание рвёт не меньше, чем разрыв рядом — та же контузия.
      this.suppress(victim);
      return false;
    }

    victim.hp = 0;
    victim.dead = true;
    if (this.mode === MODE_ROYALE) this.royaleVisionEvents.add(victim.id);
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
    if (this.mode === MODE_ROYALE) this.emitWave();

    // Бот из комнаты не уходит: его остов остаётся на карте препятствием до
    // конца волны (см. refreshWrecks), а из players его выметет clearBots.
    if (!victim.brain && isCoopMode(this.mode)) {
      // Жизнь одна на волну — в строй вернёт только её зачистка.
      victim.waiting = true;
    }
    return true;
  }

  private spawnState(spawn: { x: number; z: number; angle: number }): TankState {
    return createTankState(spawn.x, spawn.z, spawn.angle);
  }

  private respawn(
    player: Player,
    spawn: { x: number; z: number; angle: number } = spawnPoint(this.spawnCounter++, this.mapId),
  ): void {
    player.state = this.spawnState(spawn);
    player.hp = this.maxHealth(player);
    player.dead = false;
    player.readyAt = this.tick;
    // seq не сбрасываем: клиент продолжает свою нумерацию, ack должен остаться в её шкале.
    player.last = { seq: player.last.seq, throttle: 0, steer: 0, turret: spawn.angle };
    player.queue.length = 0;
  }

  // --- Бонусы ---

  /** Множитель хода от бонуса «Ход»; клиент подставляет в предсказание то же число. */
  private boost(player: Player): number {
    const bonus = this.mode === MODE_ROYALE
      ? (player.royaleLootMask & (1 << ROYALE_LOOT_SPEED) ? ROYALE_LOOT_SPEED_MUL : 1)
      : player.fx[BONUS_SPEED] > this.tick ? BONUS_SPEED_MUL : 1;
    return bonus * (player.brain || this.mode !== MODE_EXPEDITION ? 1 : this.expeditionStats().speed);
  }

  private maxHealth(player: Player): number {
    const base = player.brain ? BOT_HP : MAX_HP;
    if (this.mode === MODE_ROYALE) return base + player.royaleArmor;
    if (player.brain) return BOT_HP;
    if (this.mode !== MODE_EXPEDITION) return MAX_HP;
    return Math.round(MAX_HP * this.expeditionStats().health);
  }

  private expeditionStats(): { speed: number; damage: number; reload: number; health: number } {
    let speed = expeditionPower(this.wave);
    let damage = 1;
    let reload = 1;
    let health = 1;
    for (const id of this.expeditionUpgrades) {
      const upgrade = EXPEDITION_UPGRADES[id];
      if (!upgrade) continue;
      speed *= upgrade.speed;
      damage *= upgrade.damage;
      reload *= upgrade.reload;
      health *= upgrade.health;
    }
    return { speed, damage, reload, health };
  }

  private updateBonuses(): void {
    if (this.mode === MODE_ROYALE) {
      this.updateRoyaleLoot();
      return;
    }
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
    if (this.mode === MODE_ROYALE) {
      this.applyRoyaleLoot(player, kind);
      return;
    }
    if (kind === BONUS_HEAL) {
      // Потолок берётся по самому танку: у бота он свой, а в экспедиции у команды
      // может быть увеличен карточкой «Бронекапсула». Ящики боты не подбирают, но правило
      // должно быть верным само по себе, а не за счёт того, что не срабатывает.
      player.hp = Math.min(this.maxHealth(player), player.hp + BONUS_HEAL_HP);
    } else {
      // Второй ящик того же вида не складывается, а отсчитывает срок заново.
      player.fx[kind] = this.tick + Math.round(BONUS_DURATION_S[kind] * TICK_HZ);
    }
    this.emit({ t: 'pickup', id: player.id, kind });
  }

  /** BR-лут постоянен до конца матча; ремонт остаётся единственным расходником. */
  private applyRoyaleLoot(player: Player, kind: number): void {
    if (kind !== BONUS_HEAL && (player.royaleLootMask & (1 << kind)) !== 0) return;
    if (kind === BONUS_HEAL) {
      player.hp = Math.min(this.maxHealth(player), player.hp + BONUS_HEAL_HP);
    } else if (kind === ROYALE_LOOT_ARMOR) {
      player.royaleLootMask |= 1 << kind;
      player.royaleArmor = ROYALE_LOOT_ARMOR_HP;
      player.hp += ROYALE_LOOT_ARMOR_HP;
    } else {
      player.royaleLootMask |= 1 << kind;
    }
    this.emit({ t: 'pickup', id: player.id, kind });
  }

  /**
   * Контейнеры стоят весь матч и не респавнятся. Подбирать их могут и люди, и
   * боты: спор идёт за конкретную точку, а не за случайный временный эффект.
   */
  private updateRoyaleLoot(): void {
    const reach = TANK_RADIUS + BONUS_RADIUS;
    for (const player of this.players.values()) {
      if (player.dead) continue;
      for (let i = this.bonuses.length - 1; i >= 0; i--) {
        const loot = this.bonuses[i];
        if (Math.hypot(loot.x - player.state.x, loot.z - player.state.z) > reach) continue;
        if (loot.kind !== BONUS_HEAL && (player.royaleLootMask & (1 << loot.kind)) !== 0) continue;
        this.bonuses.splice(i, 1);
        this.applyRoyaleLoot(player, loot.kind);
      }
    }
  }

  private spawnRoyaleLoot(): void {
    this.bonuses.length = 0;
    const scale = this.half / 450;
    for (const [baseX, baseZ, kind] of ROYALE_LOOT_LAYOUT) {
      const spot = this.royaleLootSpot(baseX * scale, baseZ * scale);
      if (!spot) continue;
      this.bonuses.push({
        id: this.nextBonusId++,
        kind,
        x: spot.x,
        z: spot.z,
        until: Number.MAX_SAFE_INTEGER,
      });
    }
    this.bonusAt = Number.MAX_SAFE_INTEGER;
  }

  /** Сдвигает задуманный контейнер к ближайшему свободному месту в том же POI. */
  private royaleLootSpot(x: number, z: number): { x: number; z: number } | null {
    const attempts: Array<[number, number]> = [[0, 0]];
    // Некоторые POI имеют контейнеры/стены ровно в своей геометрической
    // середине. Ищем свободный двор в радиусе района, не превращая точку в
    // случайный спавн: сначала ближайшие клетки, потом более дальний край.
    for (let radius = 8; radius <= 48; radius += 8) {
      attempts.push(
        [radius, 0], [-radius, 0], [0, radius], [0, -radius],
        [radius, radius], [-radius, radius], [radius, -radius], [-radius, -radius],
      );
    }
    for (const [dx, dz] of attempts) {
      const candidate = { x: x + dx, z: z + dz };
      if (Math.abs(candidate.x) > this.half - 8 || Math.abs(candidate.z) > this.half - 8) continue;
      if (this.obstacles.some((box) => {
        const tankRadius = box.collisionTankRadius ?? TANK_RADIUS;
        if (box.collisionPolygon && box.collisionPolygon.length >= 3) {
          return circleIntersectsPolygon(
            candidate.x,
            candidate.z,
            tankRadius + BONUS_RADIUS,
            worldCollisionPolygon(box),
          );
        }
        if (box.collisionRadius !== undefined) {
          return Math.hypot(candidate.x - box.x, candidate.z - box.z) < box.collisionRadius + tankRadius + BONUS_RADIUS;
        }
        const size = boxCollisionSize(box);
        return Math.abs(candidate.x - box.x) < size.w / 2 + tankRadius + BONUS_RADIUS &&
          Math.abs(candidate.z - box.z) < size.d / 2 + tankRadius + BONUS_RADIUS;
      })) continue;
      if (this.bonuses.some((bonus) => Math.hypot(bonus.x - candidate.x, bonus.z - candidate.z) < 22)) continue;
      return candidate;
    }
    return null;
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
    for (let attempt = 0; attempt < 24; attempt++) {
      const x = (Math.random() * 2 - 1) * limit;
      const z = (Math.random() * 2 - 1) * limit;

      let taken = false;
      for (const box of this.obstacles) {
        const tankRadius = box.collisionTankRadius ?? TANK_RADIUS;
        if (box.collisionPolygon && box.collisionPolygon.length >= 3) {
          if (circleIntersectsPolygon(x, z, tankRadius + BONUS_RADIUS, worldCollisionPolygon(box))) {
            taken = true;
            break;
          }
          continue;
        }
        if (box.collisionRadius !== undefined) {
          if (Math.hypot(x - box.x, z - box.z) < box.collisionRadius + tankRadius + BONUS_RADIUS) {
            taken = true;
            break;
          }
          continue;
        }
        const size = boxCollisionSize(box);
        if (Math.abs(x - box.x) < size.w / 2 + tankRadius + BONUS_RADIUS &&
          Math.abs(z - box.z) < size.d / 2 + tankRadius + BONUS_RADIUS) {
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
      player.royaleLootMask = 0;
      player.royaleArmor = 0;
      player.stealth = false;
      player.zoneDamageRemainder = 0;
    }
  }

  private effectMask(player: Player): number {
    let mask = 0;
    for (let kind = 0; kind < BONUS_KINDS; kind++) {
      if (player.fx[kind] > this.tick) mask |= 1 << kind;
    }
    if (this.mode === MODE_ROYALE) mask |= player.royaleLootMask;
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
    teamSize?: number,
    royaleSquadSize?: number,
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

    // BR получает отдельную крупную карту по умолчанию. Явный выбор карты
    // остаётся возможным для будущих тестовых матчей.
    const requestedMap = isMapId(map) ? map : mode === MODE_ROYALE ? ROYALE_MAP_ID : undefined;
    const newMap = requestedMap !== undefined && requestedMap !== this.mapId;
    if (newMap) {
      this.mapId = requestedMap!;
      this.scene = buildScene(this.mapId);
      this.obstacles = this.scene.obstacles;
      this.half = this.scene.half;
      this.cover = coverBoxes(this.obstacles);
      this.bushes = bushBoxes(this.obstacles);
      this.moveObstacles = passableObstacles(this.obstacles);
      this.obstacleIndex = new BoxGrid(this.moveObstacles);
      this.coverIndex = new BoxGrid(this.cover);
      this.bushIndex = new BoxGrid(this.bushes);
      this.liveObstacleIndex = this.obstacleIndex;
      this.liveCoverIndex = this.coverIndex;
      // Геометрию клиент не строит сам — шлём её раньше рестарта, чтобы к первому
      // же снапшоту нового мира у него была правильная карта.
      this.emit({ t: 'map', id: this.mapId, half: this.half, obstacles: this.obstacles });
    }

    const newMode = mode !== undefined && mode !== this.mode;
    if (newMode) this.mode = mode;
    if (newMode && this.mode === MODE_ROYALE && !this.bonusesOn) {
      this.bonusesOn = true;
      this.bonusAt = this.tick;
    }

    // Смена правил перезапускает бой по той же причине, что и смена режима: это
    // не настройка внутри боя, а другой бой. Заодно снимает неприятность, когда
    // подписи гаснут посреди перестрелки.
    const newRules = isRuleset(rules) && rules !== this.rules;
    if (newRules) this.rules = rules;

    // Размер команды сам по себе не боец — перезапускает бой, только пока мы в нём.
    const newTeamSize = isTeamBattleSize(teamSize) && teamSize !== this.teamSize;
    if (newTeamSize) this.teamSize = teamSize!;

    const newRoyaleSquadSize = isRoyaleSquadSize(royaleSquadSize) && royaleSquadSize !== this.royaleSquadSize;
    if (newRoyaleSquadSize) this.royaleSquadSize = royaleSquadSize!;

    if (
      newMap ||
      newMode ||
      newRules ||
      (newTeamSize && this.mode === MODE_TEAM) ||
      (newRoyaleSquadSize && this.mode === MODE_ROYALE)
    ) this.restart();

    this.emitConfig();
  }

  /** Мир начинается заново: боты убраны, счёт обнулён, волны с первой. */
  private restart(): void {
    this.clearBots();
    this.clearBonuses();
    this.shells.length = 0;
    this.resetScores();
    this.wave = 0;
    this.expeditionUpgrades = [];
    this.upgradeChoices = [];
    this.victory = false;
    this.runDifficulty = this.difficulty;
    this.phase = 'break';
    this.phaseUntil = this.tick;
    this.royaleStarted = false;
    this.royaleOver = false;
    this.royalePhase = 'countdown';
    this.royalePhaseUntil = 0;
    this.royaleContacts.clear();
    this.royaleVision.clear();
    this.royaleSight.clear();
    this.royaleVisionEvents.clear();
    this.royaleVisionTick = -Infinity;
    this.royaleIntel.clear();
    this.royaleZone.phase = 'safe';
    this.royaleZone.endsAt = 0;
    this.teamStarted = false;
    this.teamWinner = null;
    this.teamResult = null;
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
        this.expeditionUpgrades = [];
        this.upgradeChoices = [];
        this.victory = false;
      }
      this.phaseUntil = this.tick;
      return;
    }

    if (this.phase === 'upgrade') {
      if (this.tick >= this.phaseUntil) this.chooseUpgrade(this.upgradeChoices[0]);
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
    if (wave === 1) {
      this.resetScores();
      this.victory = false;
    }
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
      player.hp = this.maxHealth(player);
    }
    this.emitWave();
    // Панель настроек должна погасить пометку «ждёт следующей волны».
    if (tookEffect) this.emitConfig();
  }

  private endWave(): void {
    this.best = Math.max(this.best, this.wave);
    // Волна зачищена — трупам ботов пора освободить поле для следующей.
    this.clearBots();
    if (this.mode === MODE_EXPEDITION) {
      if (this.wave >= EXPEDITION_WAVES) {
        this.victory = true;
        this.phase = 'over';
        this.phaseUntil = this.tick + Math.round(WAVE_OVER_S * TICK_HZ);
        this.emitWave();
        return;
      }
      this.upgradeChoices = this.makeUpgradeChoices(this.wave);
      this.phase = 'upgrade';
      this.phaseUntil = this.tick + Math.round(18 * TICK_HZ);
    } else {
      this.phase = 'break';
      this.phaseUntil = this.tick + Math.round(WAVE_BREAK_S * TICK_HZ);
    }
    this.emitWave();
  }

  private gameOver(): void {
    this.best = Math.max(this.best, this.wave);
    this.clearBots();
    this.upgradeChoices = [];
    this.phase = 'over';
    this.victory = false;
    this.phaseUntil = this.tick + Math.round(WAVE_OVER_S * TICK_HZ);
    this.emitWave();
  }

  private makeUpgradeChoices(wave: number): number[] {
    const start = (wave - 1) % EXPEDITION_UPGRADES.length;
    const choices: number[] = [];
    for (let i = 0; i < EXPEDITION_UPGRADE_COUNT; i++) {
      choices.push((start + i) % EXPEDITION_UPGRADES.length);
    }
    return choices;
  }

  /** Первый валидный выбор команды фиксирует улучшение для всей экспедиции. */
  chooseUpgrade(id: number): boolean {
    if (this.mode !== MODE_EXPEDITION || this.phase !== 'upgrade') return false;
    if (!this.upgradeChoices.includes(id)) return false;
    this.expeditionUpgrades.push(id);
    this.upgradeChoices = [];
    for (const player of this.players.values()) {
      if (player.brain) continue;
      player.waiting = false;
      if (player.dead) this.respawn(player);
      player.hp = this.maxHealth(player);
    }
    this.phase = 'break';
    this.phaseUntil = this.tick + Math.round(2 * TICK_HZ);
    this.emitWave();
    return true;
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
      // Настоящий уход из комнаты — здесь, а не в момент гибели: снаряды
      // мёртвого бота могли долететь, пока труп лежал на карте.
      this.forget(player);
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
    const expedition = this.mode === MODE_EXPEDITION;
    const team = this.mode === MODE_TEAM;
    const phase = team ? this.teamPhase : this.phase;
    const until = team
      ? Math.max(0, (this.teamPhaseUntil - this.tick) / TICK_HZ)
      : this.phase === 'fight'
        ? 0
        : Math.max(0, (this.phaseUntil - this.tick) / TICK_HZ);
    return {
      wave: this.wave,
      phase,
      left: this.quotaLeft + this.botCount,
      until,
      best: this.best,
      ...(expedition
        ? {
            power: expeditionPower(this.wave),
            health: this.expeditionStats().health,
            upgrades: [...this.expeditionUpgrades],
            choices: this.upgradeChoices.map((id) => EXPEDITION_UPGRADES[id]),
            victory: this.victory,
          }
        : {}),
      ...(team
        ? {
            teamSize: this.teamSize,
            winner: this.teamWinner ?? undefined,
          }
        : {}),
      ...(this.mode === MODE_ROYALE
        ? {
            royalePhase: this.royaleStarted ? this.royalePhase : undefined,
            royaleUntil:
              this.royaleStarted && this.royalePhaseUntil > 0
                ? Math.max(0, (this.royalePhaseUntil - this.tick) / TICK_HZ)
                : 0,
            royaleAlive: this.royaleStarted
              ? [...this.players.values()].filter((player) => !player.dead).length
              : 0,
          }
        : {}),
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
      active: isCoopMode(this.mode) && this.phase === 'fight' ? this.runDifficulty : this.difficulty,
      stance: this.stance,
      bonuses: this.bonusesOn,
      hostId: this.hostId,
      teamSize: this.teamSize,
      royaleSquadSize: this.royaleSquadSize,
    };
  }

  /** Живых игроков-людей в комнате (боты не в счёт). */
  get humanCount(): number {
    let n = 0;
    for (const player of this.players.values()) if (!player.brain) n++;
    return n;
  }

  /** Ботов ещё в строю — трупы (см. refreshWrecks) в счёт не идут. */
  get botCount(): number {
    let n = 0;
    for (const player of this.players.values()) if (player.brain && !player.dead) n++;
    return n;
  }

  /**
   * Снапшот обычных режимов общий. В BR он собирается для конкретного игрока:
   * сервер не отдаёт координаты непросвеченных живых врагов даже в сетевом пакете.
   * Остовы приходят всегда: они остаются физическими препятствиями и не могут
   * превращаться в невидимую стену.
   */
  snapshotEntries(viewer?: Player): SnapshotEntry[] {
    const entries: SnapshotEntry[] = [];
    for (const p of this.players.values()) {
      if (viewer && this.mode === MODE_ROYALE && !p.dead && !this.royaleVisible(viewer, p)) continue;
      if (
        viewer &&
        this.mode === MODE_ROYALE &&
        p.id !== viewer.id &&
        p.team !== viewer.team &&
        !p.dead
      ) {
        this.rememberRoyaleContact(viewer.team, p);
      }
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
        m: this.maxHealth(p),
        // Поле есть только у тех, у кого эффект реально висит — экономия трафика.
        ...(mask === 0 ? {} : { f: mask }),
        // Счётчик нужен клиенту, чтобы отдача и вспышка означали именно
        // подтверждённый сервером выстрел, а не ранний запрос во время отката.
        q: p.shots,
      });
    }
    return entries;
  }

  private rememberRoyaleContact(team: number, target: Player): void {
    let contacts = this.royaleContacts.get(team);
    if (!contacts) {
      contacts = new Map();
      this.royaleContacts.set(team, contacts);
    }
    contacts.set(target.id, {
      x: target.state.x,
      z: target.state.z,
      until: this.tick + Math.round(5 * TICK_HZ),
    });
  }

  /** Контакты, которые ещё не истекли и уже снова не стали видимыми. */
  snapshotContacts(viewer: Player): SnapshotContact[] {
    if (this.mode !== MODE_ROYALE) return [];
    const contacts = this.royaleContacts.get(viewer.team);
    if (!contacts) return [];

    const out: SnapshotContact[] = [];
    for (const [id, contact] of contacts) {
      const target = this.players.get(id);
      if (!target || target.dead || this.tick >= contact.until) {
        contacts.delete(id);
        continue;
      }
      if (this.royaleVisible(viewer, target)) {
        contacts.delete(id);
        continue;
      }
      out.push({
        i: id,
        x: round(contact.x),
        z: round(contact.z),
        u: Math.max(0, round((contact.until - this.tick) / TICK_HZ)),
      });
    }
    return out;
  }

  private royaleVisible(viewer: Player, target: Player): boolean {
    if (viewer.id === target.id || viewer.team === target.team) return true;
    this.refreshRoyaleVision();
    return this.royaleVision.get(viewer.team)?.has(target.id) ?? false;
  }

  /**
   * Полная сверка видимости: это страховка раз в пять секунд, а не основной
   * путь подсвета. Обычное движение обновляется адресно в
   * refreshRoyaleVisionAfterMovement(), поэтому быстрый таран не ждёт кэша.
   */
  private refreshRoyaleVision(): void {
    if (this.mode !== MODE_ROYALE || !this.royaleStarted) return;
    if (this.tick - this.royaleVisionTick < ROYALE_VISION_REFRESH_TICKS) return;

    const teams = new Set<number>();
    this.royaleVision.clear();
    this.royaleSight.clear();
    for (const player of this.players.values()) {
      if (player.dead) continue;
      const visible = new Set<number>();
      for (const target of this.players.values()) {
        if (target.dead || target.team === player.team) continue;
        if (this.royaleVisibleFrom(player, target)) visible.add(target.id);
      }
      this.royaleSight.set(player.id, visible);
      teams.add(player.team);
    }
    for (const team of teams) this.rebuildRoyaleVision(team);
    this.royaleVisionTick = this.tick;
  }

  /** Собирает засвет сквада из личных линий обзора его живых участников. */
  private rebuildRoyaleVision(team: number): void {
    const visible = new Set<number>();
    for (const player of this.players.values()) {
      if (player.dead || player.team !== team) continue;
      const sight = this.royaleSight.get(player.id);
      if (!sight) continue;
      for (const targetId of sight) visible.add(targetId);
    }
    this.royaleVision.set(team, visible);
  }

  /** Полностью обновляет только то, что видит один сдвинувшийся наблюдатель. */
  private refreshRoyaleSight(viewer: Player): boolean {
    if (viewer.dead) return this.royaleSight.delete(viewer.id);
    const next = new Set<number>();
    for (const target of this.players.values()) {
      if (target.dead || target.team === viewer.team) continue;
      if (this.royaleVisibleFrom(viewer, target)) next.add(target.id);
    }
    const previous = this.royaleSight.get(viewer.id);
    if (previous && previous.size === next.size && [...next].every((id) => previous.has(id))) return false;
    this.royaleSight.set(viewer.id, next);
    return true;
  }

  /** Обновляет одну линию «наблюдатель → цель», когда сдвинулась сама цель. */
  private refreshRoyaleSightTarget(viewer: Player, target: Player): boolean {
    const sight = this.royaleSight.get(viewer.id) ?? new Set<number>();
    const wasVisible = sight.has(target.id);
    const visible = !viewer.dead && !target.dead && viewer.team !== target.team && this.royaleVisibleFrom(viewer, target);
    if (visible) sight.add(target.id);
    else sight.delete(target.id);
    this.royaleSight.set(viewer.id, sight);
    return wasVisible !== visible;
  }

  /**
   * Быстрый путь подсвета BR. Движущийся танк пересчитывает свой обзор после
   * шага физики; стоящие враги одновременно проверяют только его. Поэтому
   * неподвижный наблюдатель замечает въехавшую в его луч цель без ожидания
   * пятисекундного полного кэша, а сервер не делает полный N²-пересчёт для
   * каждого, кто вообще не сдвинулся.
   */
  private refreshRoyaleVisionAfterMovement(previous: Map<number, { x: number; z: number }>): void {
    if (this.mode !== MODE_ROYALE || !this.royaleStarted || this.royalePhase !== 'fight') {
      this.royaleVisionEvents.clear();
      return;
    }

    const movers: Player[] = [];
    const moverIds = new Set<number>();
    for (const player of this.players.values()) {
      const before = previous.get(player.id);
      if (!player.dead && before && Math.hypot(player.state.x - before.x, player.state.z - before.z) > 0.001) {
        movers.push(player);
        moverIds.add(player.id);
      }
      // Ровно на следующем тике после двух секунд выстрел перестаёт выдавать
      // цель: без этой точки стоящий в кусте танк остался бы в засвете до
      // фоновой полной сверки.
      if (player.lastShotAt === this.tick - ROYALE_SHOT_REVEAL_TICKS - 1) {
        this.royaleVisionEvents.add(player.id);
      }
    }

    const changedTeams = new Set<number>();
    // У идущего танка обзор догоняет его новое положение после симуляции.
    for (const mover of movers) {
      if (this.refreshRoyaleSight(mover)) changedTeams.add(mover.team);
    }
    // Стоящие наблюдатели не ждут своего движения: проверяем только цель,
    // которая въехала в их уже существующую линию обзора.
    for (const target of movers) {
      for (const viewer of this.players.values()) {
        if (viewer.dead || viewer.id === target.id || viewer.team === target.team || moverIds.has(viewer.id)) continue;
        if (this.refreshRoyaleSightTarget(viewer, target)) changedTeams.add(viewer.team);
      }
    }

    // Выстрел и смерть меняют видимость без обязательного перемещения.
    for (const targetId of this.royaleVisionEvents) {
      const target = this.players.get(targetId);
      if (!target || target.dead) {
        if (target && this.royaleSight.delete(target.id)) changedTeams.add(target.team);
        for (const [viewerId, sight] of this.royaleSight) {
          if (!sight.delete(targetId)) continue;
          const viewer = this.players.get(viewerId);
          if (viewer) changedTeams.add(viewer.team);
        }
        continue;
      }
      for (const viewer of this.players.values()) {
        if (viewer.dead || viewer.team === target.team) continue;
        if (this.refreshRoyaleSightTarget(viewer, target)) changedTeams.add(viewer.team);
      }
    }
    this.royaleVisionEvents.clear();
    for (const team of changedTeams) this.rebuildRoyaleVision(team);
  }

  /** Принудительный сброс для смены состояния мира и детерминированных проверок. */
  invalidateRoyaleVision(): void {
    this.royaleVisionTick = -Infinity;
  }

  /** Индивидуальный луч, используемый только при обновлении общего кэша. */
  private royaleVisibleFrom(viewer: Player, target: Player): boolean {
    if (target.dead) return false;
    const distance = Math.hypot(target.state.x - viewer.state.x, target.state.z - viewer.state.z);
    if (distance <= 22) return true;
    const recentShot = this.tick - target.lastShotAt <= ROYALE_SHOT_REVEAL_TICKS;
    if (target.stealth && distance > 22) return recentShot && distance <= ROYALE_SHOT_REVEAL_RANGE;

    const targetBush = bushIndexAt(this.bushes, target.state.x, target.state.z);
    const viewerBush = bushIndexAt(this.bushes, viewer.state.x, viewer.state.z);
    if (targetBush >= 0 && targetBush !== viewerBush && recentShot && distance <= ROYALE_SHOT_REVEAL_RANGE) {
      // Выстрел выдаёт куст, но здание всё ещё сохраняет укрытие.
      return hasShot(viewer.state, target.state, this.cover, undefined, this.half, ROYALE_SHOT_REVEAL_RANGE, this.coverIndex);
    }
    if (recentShot && distance <= ROYALE_SHOT_REVEAL_RANGE) {
      return hasShot(viewer.state, target.state, this.cover, this.bushes, this.half, ROYALE_SHOT_REVEAL_RANGE, this.coverIndex, this.bushIndex);
    }
    return distance <= ROYALE_SIGHT_RANGE && hasShot(viewer.state, target.state, this.cover, this.bushes, this.half, ROYALE_SIGHT_RANGE, this.coverIndex, this.bushIndex);
  }

  snapshotShells(viewer?: Player): SnapshotShell[] {
    return this.shells
      .filter((s) => {
        if (!viewer || this.mode !== MODE_ROYALE) return true;
        const owner = this.players.get(s.owner);
        return owner !== undefined && this.royaleVisible(viewer, owner);
      })
      .map((s) => ({
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

  /**
   * Попадания этого тика для конкретного клиента. Стрелок и жертва получают
   * свою цифру независимо от расстояния, а наблюдатель — только рядом с боем.
   * В BR дополнительно проверяем видимость цели, чтобы событие не раскрывало
   * скрытого противника через один лишь урон в снапшоте.
   */
  snapshotHits(viewer: Player): HitFx[] {
    const rangeSq = DAMAGE_EVENT_RANGE * DAMAGE_EVENT_RANGE;
    const result: HitFx[] = [];
    for (const hit of this.hits) {
      const participant = hit.victimId === viewer.id || hit.sourceId === viewer.id;
      if (!participant) {
        const dx = hit.x - viewer.state.x;
        const dz = hit.z - viewer.state.z;
        if (dx * dx + dz * dz > rangeSq) continue;
        if (this.mode === MODE_ROYALE) {
          const victim = this.players.get(hit.victimId);
          if (victim && !this.royaleVisible(viewer, victim)) continue;
        }
      }
      result.push({ x: hit.x, z: hit.z, amount: hit.amount });
    }
    return result;
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

  /** Летящие снаряды как есть — для стендов, которые сами водят think() (bench-pve.ts). */
  get liveShells(): readonly ShellState[] {
    return this.shells;
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
