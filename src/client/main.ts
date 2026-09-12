import {
  alliedTeams,
  BONUS_DAMAGE,
  BONUS_DURATION_S,
  BONUS_HEAL,
  BONUS_KINDS,
  BONUS_NAMES,
  BONUS_RELOAD,
  BONUS_RELOAD_MUL,
  BONUS_SPEED,
  BONUS_SPEED_MUL,
  BONUS_STEALTH,
  BONUS_STEALTH_RANGE,
  MODULE_SLOT_COUNT,
  MODULE_SLOT_NAMES,
  ROYALE_MODULE_BY_ID,
  ROYALE_MODULE_TIER_COLORS,
  DIFFICULTY_NAMES,
  DT,
  hasEffect,
  INTERP_DELAY_MS,
  BOT_HP,
  MAX_HP,
  STANCE_NAMES,
  STANCE_NEUTRAL,
  MODE_DM,
  MODE_EXPEDITION,
  MODE_ROYALE,
  MODE_TEAM,
  MODE_PVE,
  TEAM_BATTLE_SIZES,
  ROYALE_SQUAD_SIZES,
  ROYALE_START_COUNTDOWN_S,
  EXPEDITION_UPGRADES,
  expeditionPower,
  MAP_HALF,
  MUZZLE_OFFSET,
  RELOAD_S,
  RESPAWN_S,
  RULES_ARCADE,
  RULES_REAL,
  SHELL_HEIGHT,
  type GameMode,
  type RoyaleSquadSize,
  type Ruleset,
} from '../shared/constants.js';
import { bushBoxes, bushIndexAt, coverBoxes, passableObstacles, MAP_NAMES } from '../shared/map.js';
import { clamp, lerpAngle, sweepShell } from '../shared/sim.js';
import type { LeaderboardEntry, RoomConfig, RoyaleZoneState, ServerMessage, WaveState } from '../shared/protocol.js';
import {
  BOOM_GROUND,
  BOOM_HIT,
  BOOM_KILL,
  BOOM_RICOCHET,
  TEAM_ONE,
  TEAM_TWO,
  type Boom,
  type BoomKind,
  type Box,
  type HitFx,
  type PlayerInfo,
  type ShellState,
  type SnapshotBonus,
  type SnapshotContact,
  type SnapshotEntry,
  type SnapshotLoadout,
  type SnapshotShell,
} from '../shared/types.js';

import { Controls } from './controls.js';
import { AudioManager } from './audio.js';
import { Net } from './net.js';
import { SelfPrediction } from './prediction.js';
import { BONUS_COLORS, Scene3D, TRACER_LENGTH, type TankFaction } from './render.js';

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Нет элемента #${id}`);
  return node as T;
};

const canvas = el<HTMLCanvasElement>('scene');
const minimap = el('minimap');
const minimapCanvas = el<HTMLCanvasElement>('minimap-canvas');
const minimapStatus = el('minimap-status');
const overlay = el('overlay');
const form = el<HTMLFormElement>('join-form');
const nameInput = el<HTMLInputElement>('name-input');
const joinButton = el<HTMLButtonElement>('join-button');
const status = el('status');
const hud = el('hud');
const hint = el('hint');
const touchLayer = el('touch');
const crosshair = el('crosshair');

const RETICLE_STYLES = [
  ['realistic', 'Реалистичный', 'Тонкое кольцо, точка и небольшие дальномерные засечки.'],
  ['minimal', 'Минималистичный', 'Только маленькая точка и заметный импульс при попадании.'],
  ['arcade', 'Аркадный', 'Крупнее, ярче и с сильнее выраженной анимацией попадания.'],
] as const;
type ReticleStyle = (typeof RETICLE_STYLES)[number][0];
const savedReticle = localStorage.getItem('tanks:reticle');
let reticleStyle: ReticleStyle = RETICLE_STYLES.some(([id]) => id === savedReticle)
  ? (savedReticle as ReticleStyle)
  : 'realistic';
crosshair.dataset.style = reticleStyle;

const scene = new Scene3D(canvas, el('labels'));
const controls = new Controls(canvas, el('stick'), el('stick-knob'), el('fire-button'));
controls.attach();
const audio = new AudioManager();
window.addEventListener('pointerdown', () => audio.unlock(), { passive: true });
window.addEventListener('keydown', () => audio.unlock(), { passive: true });

// --- Состояние мира на клиенте ---

let selfId = 0;
let worldBuilt = false;

const players = new Map<number, PlayerInfo>();
/**
 * Танки, которых игрок уже знает (players.has), но которым ещё не построена
 * 3D-модель: очередь на addTank(). Нужна, потому что BR роняет на карту до
 * 40 ботов одним залпом 'joined' — построить все их меши в один кадр значит
 * подвесить именно тот кадр, на котором игрок только что увидел бой.
 */
const pendingSpawns: PlayerInfo[] = [];

/** Свой танк: предсказание, реконсиляция и сглаживание живут в prediction.ts. */
const self = new SelfPrediction();
/** Блоки, которые держат снаряд: нужны метке прицела. Пересобираются со сменой карты. */
let cover: Box[] = [];
/** Кусты карты — только чтобы просветлить листву вокруг камеры от первого лица (см. drawSelf), больше ни на что на клиенте не влияют. */
let bushes: Box[] = [];
/** Полная геометрия карты для упрощённого вида сверху. */
let minimapObstacles: Box[] = [];
/** Половина стороны текущей карты, м: метка прицела упирается в ту же стену, что снаряд. */
let mapHalf = MAP_HALF;

interface BufferedSnapshot {
  time: number;
  entries: Map<number, SnapshotEntry>;
  shells: SnapshotShell[];
}

/** Снапшоты храним, чтобы рисовать чужие танки с задержкой и интерполяцией. */
const snapshots: BufferedSnapshot[] = [];

interface InterpFrame {
  from: BufferedSnapshot;
  to: BufferedSnapshot;
  t: number;
}

/**
 * Пара соседних снапшотов вокруг renderTime плюс доля между ними. Общий шаг
 * для отрисовки чужих танков и для выбора точки, куда смотрит камера-наблюдатель
 * (drawSelf), — обоим нужен один и тот же момент интерполяции.
 */
function interpFrame(renderTime: number): InterpFrame | null {
  while (snapshots.length > 2 && snapshots[1].time <= renderTime) snapshots.shift();
  if (snapshots.length === 0) return null;

  let index = snapshots.length - 1;
  while (index > 0 && snapshots[index].time > renderTime) index--;

  const from = snapshots[index];
  const to = snapshots[index + 1] ?? from;
  const span = to.time - from.time;
  const t = span > 1e-3 ? clamp((renderTime - from.time) / span, 0, 1) : 1;
  return { from, to, t };
}

/**
 * Взрывы ждут своей очереди столько же, сколько чужие танки: иначе вспышка
 * появлялась бы на 100 мс раньше, чем танк доедет до места попадания.
 */
const pendingBooms: Array<{ at: number; boom: Boom }> = [];

/** Цифры урона ждут ту же задержку, что и взрывы — по той же причине. */
const pendingHits: Array<{ at: number; hit: HitFx }> = [];

/** id снарядов, которые мы уже видели: по новым рисуем вспышку выстрела. */
const knownShells = new Set<number>();

/**
 * Насколько трясёт камеру, если рвануло вплотную; дальше сила падает линейно до
 * нуля на SHAKE_RANGE. Прилетевшее в тебя попадание — это взрыв в нулевом
 * расстоянии, так что отдельного «тряхнуть при уроне» не нужно.
 */
const BOOM_SHAKE: Record<BoomKind, number> = {
  [BOOM_GROUND]: 0.28,
  [BOOM_HIT]: 0.45,
  [BOOM_KILL]: 0.75,
  [BOOM_RICOCHET]: 0.11,
};
/** Дальше этого взрыв уже не чувствуется, м. */
const SHAKE_RANGE = 26;
/** Отдача собственной пушки. Заметна, но целиться не мешает. */
const SELF_SHOT_SHAKE = 0.42;

/** Локальное окно отката: сервер всё равно остаётся источником истины. */
let reloadUntil = 0;
/** Длина текущего отката, мс: с бонусом «Заряжание» он короче. */
let reloadSpan = RELOAD_S * 1000;
/** Пока запрос огня не подтверждён снапшотом, новый не отправляем. */
let firePending = false;
/**
 * Снапшот с подтверждённым q обычно приходит за один-два тика. Таймаут нужен
 * только как страховка: сервер мог отклонить запрос на самой границе отката,
 * и без него клиент навсегда считал бы, что всё ещё ждёт подтверждения.
 */
const FIRE_ACK_TIMEOUT_MS = 550;
let firePendingUntil = 0;
/** Счётчик выстрелов, реально принятых сервером. */
let myShotCount = 0;
let shotCountReady = false;
let myHp = MAX_HP;
let myMaxHp = MAX_HP;
let expeditionMaxHp = MAX_HP;
let myDead = false;
let respawnAt = 0;

// --- Режим комнаты ---

let mapId = 0;
let mode: GameMode = MODE_DM;
let rules: Ruleset = RULES_ARCADE;
/** Выбор хоста. */
let difficulty = 1;
/** Сложность, по которой идёт бой сейчас: посреди волны отстаёт от выбранной. */
let activeDifficulty = 1;
let stance = STANCE_NEUTRAL;
let bonusesOn = false;
let hostId = 0;
/** Выбор хоста для командного боя: 5×5 или 10×10. */
let teamSize = 5;
/** Выбор формата отряда BR: 1 — соло, 2 — дуо, 4 — сквад. */
let royaleSquadSize: RoyaleSquadSize = 4;
let leaderboardEntries: LeaderboardEntry[] = [];
/** Первый config пришёл: до него о «сменах» настроек сообщать нечего. */
let configKnown = false;

/** Чем карта отличается — подпись под выбором. Порядок как в MAP_NAMES. */
const MAP_HINTS = [
  'Срабатывает сразу: бой начинается заново. Открытое поле с укрытиями, длинные дистанции.',
  'Срабатывает сразу: бой начинается заново. Стены с четырьмя воротами — есть что держать.',
  'Срабатывает сразу: бой начинается заново. Кварталы и улицы: близко, тесно, много рикошетов.',
  'Срабатывает сразу: бой начинается заново. Стена делит карту надвое, три прохода.',
  'Срабатывает сразу: бой начинается заново. Брустверы простреливаются насквозь — ехать зигзагом, а видно тебя всегда.',
  'Срабатывает сразу: бой начинается заново. Контейнеры не укрывают: весь парк простреливается поверху.',
  'Срабатывает сразу: бой начинается заново. Открыто и далеко. Барханы держат колёса, но не снаряды.',
  'Срабатывает сразу: бой начинается заново. Большая долина 280×280 с редкими укрытиями и длинными переходами.',
  'Срабатывает сразу: бой начинается заново. Промышленный район 280×280 с цехами, дворами и воротами.',
  'Срабатывает сразу: BR-карта 900×900. Районы, дальние переходы и 24 точки появления.',
];

/** Что делает манера боя — подпись под выбором. Порядок как в STANCE_NAMES. */
const STANCE_HINTS = [
  'Срабатывает сразу: держатся втрое дальше и работают огнём. В упор не идёт никто.',
  'Срабатывает сразу: в ближний бой идут только те, кому это разрешает уровень.',
  'Срабатывает сразу: лезут вплотную все разом. Урона прилетает столько же, но разорвать дистанцию не дадут.',
];

const MODE_NAMES: Record<GameMode, string> = {
  [MODE_DM]: 'Все против всех',
  [MODE_PVE]: 'Против ботов',
  [MODE_EXPEDITION]: 'Экспедиция',
  [MODE_ROYALE]: 'Королевская битва',
  [MODE_TEAM]: 'Командный бой',
};

const RULES_NAMES: Record<Ruleset, string> = {
  [RULES_ARCADE]: 'Аркада',
  [RULES_REAL]: 'Реализм',
};

/**
 * Что меняют правила — подпись под выбором. Подписи над танками (ник и
 * полоска HP) от правил не зависят вовсе: они всегда только у товарищей,
 * и никогда — над чужими или над собой.
 */
const RULES_HINTS: Record<Ruleset, string> = {
  [RULES_ARCADE]: 'Срабатывает сразу: бой начинается заново.',
  [RULES_REAL]:
    'Срабатывает сразу: бой начинается заново. Дополнительно включает вид от первого лица без права выключить — камера над танком видит то, чего бот не видит.',
};

/** Маска бонусов, действующих на мой танк; приходит в снапшоте. */
let myEffects = 0;
/**
 * Когда мой эффект кончится, по локальным часам. Отсчёт заводится по событию
 * подбора: сервер шлёт только факт «эффект есть», а секунды считать незачем — они
 * известны из BONUS_DURATION_S. Маска всё равно главнее и гасит чип досрочно.
 */
const effectUntil = new Array<number>(BONUS_KINDS).fill(0);
let wave: WaveState = { wave: 0, phase: 'break', left: 0, until: 0, best: 0 };
let royaleZone: RoyaleZoneState | null = null;
let royaleLoadout: SnapshotLoadout = { inventory: [], equipped: new Array<number>(MODULE_SLOT_COUNT).fill(0) };
let expeditionBasePower = 1;
/** Момент, когда кончится передышка или экран итогов: сервер прислал остаток в секундах. */
let waveUntilAt = 0;
/** До какого момента висит плашка «Волна N»; в паузах она держится сама. */
let bannerHideAt = 0;

// --- Сеть ---

const net = new Net({
  onOpen: () => setStatus('Подключение…'),
  onClose: (reason) => {
    resetWorld();
    showOverlay(reason, true);
  },
  onMessage: handleMessage,
});

function handleMessage(msg: ServerMessage): void {
  switch (msg.t) {
    case 'welcome': {
      selfId = msg.id;
      self.obstacles = passableObstacles(msg.map.obstacles);
      self.half = msg.map.half;
      mapHalf = msg.map.half;
      minimapObstacles = msg.map.obstacles;
      cover = coverBoxes(msg.map.obstacles);
      bushes = bushBoxes(msg.map.obstacles);
      if (!worldBuilt) {
        scene.buildWorld(msg.map.half, msg.map.obstacles, msg.mapId);
        worldBuilt = true;
      }
      for (const info of msg.players) addPlayer(info);
      applyWave(msg.wave);
      applyConfig(msg);
      leaderboardEntries = msg.leaderboard;
      renderLeaderboard();
      hideOverlay();
      break;
    }
    case 'map':
      // Карту строит сервер, клиент только пересобирает по ней сцену и свои
      // препятствия для предсказания.
      self.obstacles = passableObstacles(msg.obstacles);
      self.half = msg.half;
      mapHalf = msg.half;
      minimapObstacles = msg.obstacles;
      cover = coverBoxes(msg.obstacles);
      bushes = bushBoxes(msg.obstacles);
      scene.buildWorld(msg.half, msg.obstacles, msg.id);
      worldBuilt = true;
      break;
    case 'joined':
      addPlayer(msg.player);
      break;
    case 'left':
      // Настоящий уход: гибель как таковая сюда не попадает (см. protocol.ts) —
      // остов уже отыграл своё через обычный dead-флаг снапшота, тут только уборка.
      players.delete(msg.id);
      scene.removeTank(msg.id);
      updateHud();
      break;
    case 'config':
      applyConfig(msg);
      break;
    case 'wave':
      applyWave(msg);
      break;
    case 'pickup':
      onPickup(msg.id, msg.kind);
      break;
    case 'snapshot':
      onSnapshot(
        msg.players,
        msg.ack,
        msg.shells ?? [],
        msg.booms ?? [],
        msg.hits ?? [],
        msg.bonuses ?? [],
        msg.contacts ?? [],
        msg.zone,
        msg.loadout,
      );
      break;
    case 'kill':
      pushKillFeed(msg.killer, msg.victim);
      break;
    case 'leaderboard':
      leaderboardEntries = msg.entries;
      renderLeaderboard();
      break;
    case 'error':
      showOverlay(msg.message, true);
      break;
  }
}

function addPlayer(info: PlayerInfo): void {
  players.set(info.id, info);
  // Свой танк нужен сразу — на нём стоит камера. Остальных (в BR это до
  // 39 ботов разом) откладываем в очередь: updateTank() и снапшоты молча
  // не трогают танк без модели, так что достроить её парой кадров позже
  // безопасно, а вот полсотни addTank() за один кадр — нет.
  if (info.id === selfId) spawnTankVisual(info);
  else pendingSpawns.push(info);
  updateHud();
}

function spawnTankVisual(info: PlayerInfo): void {
  scene.addTank(info.id, info.name, info.color, info.id === selfId, info.bot === 1);
  scene.setTankFaction(info.id, factionOf(info));
  scene.setNameplate(info.id, plated(info));
}

/** Не больше нескольких новых танков за кадр — иначе всплеск ботов в BR подвешивает кадр. */
const SPAWN_BATCH_PER_FRAME = 4;

function spawnPendingTanks(): void {
  for (let i = 0; i < SPAWN_BATCH_PER_FRAME && pendingSpawns.length > 0; i++) {
    const info = pendingSpawns.shift()!;
    // Мог успеть выйти, пока ждал своей очереди на постройку модели.
    if (players.get(info.id) !== info) continue;
    spawnTankVisual(info);
  }
}

function factionOf(info: PlayerInfo): TankFaction {
  if (mode !== MODE_ROYALE && mode !== MODE_TEAM) return 'neutral';
  // Свой красится как союзник, а не отдельным цветом: одна сторона — один цвет,
  // включая тебя самого, иначе на карте появлялся бы третий, никому не нужный оттенок.
  const me = players.get(selfId);
  return me !== undefined && alliedTeams(mode, me.team, info.team) ? 'ally' : 'enemy';
}

function applyFactions(): void {
  for (const info of players.values()) scene.setTankFaction(info.id, factionOf(info));
}

/**
 * Подписан ли этот танк: только если это товарищ — правила боя тут ни при
 * чём, подписи всегда только у своих. Чужой танк надо разглядеть, а не
 * прочитать; там, где товарищей нет вовсе (например, «Все против всех»),
 * не подписан вообще никто.
 *
 * Своя подпись тоже не рисуется: здоровье и так висит в HUD, а ник с
 * полоской над собственной башней висел бы в кадре постоянно без всякой пользы.
 */
function plated(info: PlayerInfo): boolean {
  if (info.id === selfId) return false;
  const me = players.get(selfId);
  return me !== undefined && alliedTeams(mode, me.team, info.team);
}

/**
 * Раздать подписи заново. Нужно после смены правил и после смены режима: в
 * «Все против всех» товарищей нет, и та же самая команда союзником быть
 * перестаёт.
 */
function applyPlates(): void {
  for (const info of players.values()) scene.setNameplate(info.id, plated(info));
}

function applyConfig(next: RoomConfig): void {
  const first = !configKnown;
  const wasMode = mode;
  const wasRules = rules;
  const wasDifficulty = difficulty;
  const wasBonuses = bonusesOn;
  const wasStance = stance;
  const wasTeamSize = teamSize;
  const wasRoyaleSquadSize = royaleSquadSize;

  const wasMap = mapId;

  configKnown = true;
  mapId = next.mapId;
  mode = next.mode;
  rules = next.rules;
  difficulty = next.difficulty;
  activeDifficulty = next.active;
  bonusesOn = next.bonuses;
  stance = next.stance;
  hostId = next.hostId;
  teamSize = next.teamSize;
  royaleSquadSize = next.royaleSquadSize;
  scene.setRoyaleLootVisual(mode === MODE_ROYALE);
  inventoryToggle.hidden = mode !== MODE_ROYALE;
  if (mode !== MODE_ROYALE) inventoryPanel.hidden = true;
  applyFactions();
  if (mode !== MODE_ROYALE) {
    royaleZone = null;
    scene.setRoyaleZone(null);
  }
  if (mode !== MODE_EXPEDITION) expeditionMaxHp = MAX_HP;
  if (mode !== MODE_ROYALE) myMaxHp = MAX_HP;
  expeditionBasePower = mode === MODE_EXPEDITION ? wave.power ?? expeditionPower(wave.wave) : 1;
  refreshSelfBoost();

  if (!bonusesOn) {
    effectUntil.fill(0);
    scene.clearBonuses();
  }
  // Смена режима перезапускает мир на сервере — старую плашку волны держать незачем.
  if (mode !== wasMode) bannerHideAt = 0;
  // Подписи зависят и от правил, и от режима: в «Все против всех» товарищей нет.
  if (first || rules !== wasRules || mode !== wasMode) applyPlates();
  // В реализме вид от первого лица включается принудительно (см. fpvForced) —
  // в аркаде возвращается личный выбор игрока, если он его вообще делал.
  if (first || rules !== wasRules) setFpv(rules === RULES_REAL || fpvManual === 'on', false);

  // О смене настроек говорим всем в ленте: панель открыта не у каждого, а знать,
  // что именно поменялось и когда это сработает, надо обоим.
  if (!first) {
    if (mapId !== wasMap) {
      pushFeed(`Карта: ${MAP_NAMES[mapId]} · бой начат заново`, 'is-setup');
    }
    if (mode !== wasMode) {
      pushFeed(`Режим: ${MODE_NAMES[mode]} · бой начат заново`, 'is-setup');
    }
    if (rules !== wasRules) {
      pushFeed(`Правила: ${RULES_NAMES[rules]} · бой начат заново`, 'is-setup');
    }
    if (difficulty !== wasDifficulty) {
      pushFeed(`Сложность: ${DIFFICULTY_NAMES[difficulty]} · ${whenDifficulty()}`, 'is-setup');
    }
    if (stance !== wasStance) {
      pushFeed(`Манера боя: ${STANCE_NAMES[stance]} · сразу`, 'is-setup');
    }
    if (bonusesOn !== wasBonuses) {
      pushFeed(`Бонусы ${bonusesOn ? 'включены' : 'выключены'} · сразу`, 'is-setup');
    }
    if (teamSize !== wasTeamSize) {
      pushFeed(`Размер команды: ${teamSize}×${teamSize} · сразу`, 'is-setup');
    }
    if (royaleSquadSize !== wasRoyaleSquadSize) {
      pushFeed(`Формат BR: ${royaleSquadLabel(royaleSquadSize)} · сразу`, 'is-setup');
    }
  }

  renderSetup();
  updateModeChip();
  updateHud();
  renderExpeditionChoices();
}

/** Когда выбранная сложность вступит в силу. Сервер меняет её на границе волн. */
function whenDifficulty(): string {
  if (mode !== MODE_PVE && mode !== MODE_EXPEDITION && mode !== MODE_ROYALE && mode !== MODE_TEAM) {
    return 'вступит в силу в режиме с ботами';
  }
  if (mode === MODE_TEAM) return 'со следующего раунда';
  if (wave.phase !== 'fight') return 'с ближайшей волны';
  return `с волны ${wave.wave + 1}`;
}

function royaleSquadLabel(size: RoyaleSquadSize): string {
  return size === 1 ? 'соло' : size === 2 ? 'дуо' : 'сквад';
}

function applyWave(next: WaveState): void {
  // Плашку показываем только на смене волны: во время боя сообщение приходит
  // на каждого вышедшего бота, и она мигала бы весь бой.
  const started = next.phase === 'fight' && next.wave !== wave.wave;
  const previousUpgradeCount = wave.upgrades?.length ?? 0;
  wave = next;
  expeditionMaxHp = next.health !== undefined
    ? Math.round(MAX_HP * next.health)
    : mode === MODE_EXPEDITION
      ? Math.round(MAX_HP * (next.health ?? 1))
      : MAX_HP;
  updateHealthHud();
  if (mode === MODE_EXPEDITION && (next.upgrades?.length ?? 0) > previousUpgradeCount) {
    const id = next.upgrades?.[next.upgrades.length - 1];
    const upgrade = id === undefined ? undefined : EXPEDITION_UPGRADES[id];
    if (upgrade) pushFeed(`Улучшение команды: ${upgrade.name}`, 'is-setup');
  }
  expeditionBasePower = mode === MODE_EXPEDITION ? next.power ?? expeditionPower(next.wave) : 1;
  refreshSelfBoost();
  renderExpeditionChoices();
  waveUntilAt = performance.now() + (next.royaleUntil ?? next.until) * 1000;
  if (started) bannerHideAt = performance.now() + 3000;
  updateModeChip();
  updateHud();
  // В подписи настроек стоит номер следующей волны — он только что изменился.
  if (!setupPanel.hidden) renderSetup();
}

function refreshSelfBoost(): void {
  const upgradeSpeed =
    mode === MODE_EXPEDITION
      ? (wave.upgrades ?? []).reduce(
          (value, id) => value * (EXPEDITION_UPGRADES[id]?.speed ?? 1),
          1,
        )
      : 1;
  self.boost =
    expeditionBasePower *
    upgradeSpeed *
    (mode === MODE_ROYALE ? royaleModuleMultiplier('speed') : hasEffect(myEffects, BONUS_SPEED) ? BONUS_SPEED_MUL : 1);
}

function royaleModuleMultiplier(stat: 'reload' | 'speed'): number {
  return royaleLoadout.equipped.reduce((value, id) => value * (ROYALE_MODULE_BY_ID.get(id)?.[stat] ?? 1), 1);
}

function expeditionReloadMultiplier(): number {
  if (mode !== MODE_EXPEDITION) return 1;
  return (wave.upgrades ?? []).reduce(
    (value, id) => value * (EXPEDITION_UPGRADES[id]?.reload ?? 1),
    1,
  );
}

function onSnapshot(
  entries: SnapshotEntry[],
  ack: number,
  shells: SnapshotShell[],
  booms: Boom[],
  hits: HitFx[],
  bonuses: SnapshotBonus[],
  contacts: SnapshotContact[],
  zone?: RoyaleZoneState,
  loadout?: SnapshotLoadout,
): void {
  const now = performance.now();
  royaleZone = zone ?? (mode === MODE_ROYALE ? royaleZone : null);
  scene.setRoyaleZone(royaleZone);
  scene.syncContactMarkers(mode === MODE_ROYALE ? contacts : []);
  if (mode === MODE_ROYALE) updateModeChip();
  // Ящики стоят на месте, интерполировать нечего — ставим их сразу.
  scene.syncBonuses(bonuses);
  if (loadout) {
    const changed = !sameLoadout(royaleLoadout, loadout);
    royaleLoadout = loadout;
    refreshSelfBoost();
    if (changed) {
      renderRoyaleLoadout();
      updateEffectsHud();
    }
  }
  const map = new Map<number, SnapshotEntry>();
  for (const entry of entries) map.set(entry.i, entry);
  snapshots.push({ time: now, entries: map, shells });

  // Взрывы показываем в тот же момент, в который до места дойдёт картинка мира.
  for (const boom of booms) pendingBooms.push({ at: now + INTERP_DELAY_MS, boom });
  for (const hit of hits) pendingHits.push({ at: now + INTERP_DELAY_MS, hit });

  const mine = map.get(selfId);
  if (!mine) return;

  // Эффекты сервер шлёт маской. «Ход» обязан попасть в предсказание тем же
  // множителем, что и на сервере, иначе своя же машина поедет мимо реконсиляции.
  const mask = mine.f ?? 0;
  if (mask !== myEffects) {
    myEffects = mask;
    refreshSelfBoost();
    updateEffectsHud();
  }

  if (mine.m !== undefined && mine.m !== myMaxHp) {
    myMaxHp = mine.m;
    updateHealthHud();
  }

  // Серверный счётчик подтверждает запрос и снимает блокировку следующего.
  // Саму отдачу мы уже показали в момент нажатия: ждать снапшот здесь нельзя —
  // тогда пушка и корпус отзываются с задержкой сети, а первый q после входа
  // вообще может стать исходным значением без видимого выстрела.
  if (mine.q !== undefined) {
    if (!shotCountReady) {
      myShotCount = mine.q;
      shotCountReady = true;
    } else if (mine.q > myShotCount) {
      myShotCount = mine.q;
      firePending = false;
      firePendingUntil = 0;
    }
  }

  if (mine.h !== myHp) {
    if (mine.h < myHp) flashDamage();
    myHp = mine.h;
    updateHealthHud();
  }
  if (Boolean(mine.d) !== myDead) {
    myDead = Boolean(mine.d);
    self.alive = !myDead;
    if (myDead) {
      respawnAt = now + RESPAWN_S * 1000;
      // Запрос, отправленный прямо перед попаданием, больше не должен
      // блокировать огонь после респавна, если сервер его не принял.
      firePending = false;
      firePendingUntil = 0;
      reloadUntil = 0;
    }
    updateDeathScreen();
  }

  const wasReady = self.ready;
  self.reconcile(
    { x: mine.x, z: mine.z, angle: mine.a, speed: mine.s, turret: mine.t },
    ack,
  );
  // При первом появлении разворачиваем камеру туда же, куда смотрит башня.
  if (!wasReady) controls.yaw = mine.t;
}

// --- Игровой цикл ---

let lastFrame = performance.now();
let stepAccumulator = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastFrame) / 1000, 0.25);
  lastFrame = now;

  controls.update();
  spawnPendingTanks();

  if (self.ready) {
    stepAccumulator += dt;
    let steps = 0;
    // Фиксированный шаг: тот же DT, что и на сервере, иначе предсказание разъедется.
    while (stepAccumulator >= DT && steps < 5) {
      stepAccumulator -= DT;
      steps++;

      // Перезарядку считает сервер; локальный таймер нужен, чтобы полоска в HUD
      // не дёргалась и чтобы не спамить в сеть заведомо холостыми выстрелами.
      if (firePending && now >= firePendingUntil) firePending = false;
      const wantFire = controls.fire && !myDead && !firePending && now >= reloadUntil;
      if (wantFire) {
        // Отдача должна совпасть с нажатием, а не с приходом снапшота: иначе
        // ствол и подвеска выглядят сломанными при любом пинге. Сервер всё ещё
        // решает, появится ли снаряд; q выше лишь подтвердит этот запрос.
        reloadSpan =
          RELOAD_S *
          1000 *
          expeditionReloadMultiplier() *
          (mode === MODE_ROYALE ? royaleModuleMultiplier('reload') : hasEffect(myEffects, BONUS_RELOAD) ? BONUS_RELOAD_MUL : 1);
        reloadUntil = now + reloadSpan;
        crosshair.classList.remove('is-firing');
        void crosshair.offsetWidth;
        crosshair.classList.add('is-firing');
        audio.playShot();
        scene.tankFired(selfId, true);
        scene.addShake(SELF_SHOT_SHAKE);
        firePending = true;
        firePendingUntil = now + FIRE_ACK_TIMEOUT_MS;
      }

      const input = self.step(controls.throttle, controls.steer, controls.yaw, wantFire);
      if (input) net.sendInput(input);
    }
    if (steps === 5) stepAccumulator = 0;
  }

  self.decay(dt);

  const renderTime = now - INTERP_DELAY_MS;
  updateRoyaleDrop(now);
  drawSelf(dt, renderTime);
  drawOthers(renderTime);
  drawMinimap(renderTime);
  playBooms(now);
  playHits(now);
  scene.render(dt);
  updateSpeed();
  updateReloadHud(now);
  updateDeathScreen(now);
  updateBanner(now);
}

/** Взрывы, у которых подошло время. */
function playBooms(now: number): void {
  while (pendingBooms.length > 0 && pendingBooms[0].at <= now) {
    const { boom } = pendingBooms.shift()!;
    scene.boom(boom.x, boom.z, boom.k);

    const distance = Math.hypot(boom.x - selfX, boom.z - selfZ);
    audio.playBoom(boom.k, distance);
    const near = 1 - distance / SHAKE_RANGE;
    if (near > 0) scene.addShake(BOOM_SHAKE[boom.k] * near);

    // Отметка о попадании — только стрелявшему и только по живой цели.
    if (boom.o === selfId && (boom.k === BOOM_HIT || boom.k === BOOM_KILL)) showHitmarker();
  }
}

/** Цифры урона, у которых подошло время всплыть. */
function playHits(now: number): void {
  while (pendingHits.length > 0 && pendingHits[0].at <= now) {
    const { hit } = pendingHits.shift()!;
    scene.damageNumber(hit.x, hit.z, hit.amount);
    audio.playHit(Math.hypot(hit.x - selfX, hit.z - selfZ));
  }
}

function drawSelf(dt: number, renderTime: number): void {
  // alpha — доля времени до следующего шага симуляции: кадр рисуется между шагами,
  // иначе на скорости картинка идёт ступеньками по 30 Гц.
  const state = self.sample(stepAccumulator / DT);
  if (!state) {
    crosshair.hidden = true;
    return;
  }

  selfX = state.x;
  selfZ = state.z;
  scene.updateTank(selfId, state.x, state.z, state.angle, state.turret);
  audio.updateEngine(self.speed, !myDead);

  // Мёртвый в PvE смотрит не в свою неподвижную точку, а на живого товарища —
  // иначе спектатор всю волну глядит в один и тот же кусок земли.
  const camera = myDead && (mode === MODE_PVE || mode === MODE_EXPEDITION || mode === MODE_ROYALE || mode === MODE_TEAM)
    ? spectateCamera(renderTime)
    : null;
  setSpectateTarget(camera?.id ?? 0);
  const camX = camera?.x ?? state.x;
  const camZ = camera?.z ?? state.z;

  // Камера в FPV крутится свободно и мгновенно за мышью — это глаза, а не
  // ствол. Честность с ботом не в скорости взгляда, а в том, что реально
  // стреляет ствол: он и так доворачивается с TURRET_RATE, независимо от
  // камеры (см. updateTank выше — рисуется по настоящему state.turret), и
  // выстрел раньше, чем довернётся, всё равно уйдёт мимо. Синхронизировать с
  // ним ещё и обзор было лишним — так живой человек головой не смотрит.
  if (fpv) scene.updateFirstPersonCamera(camX, camZ, controls.yaw, controls.pitch, dt);
  else scene.updateCamera(camX, camZ, controls.yaw, controls.pitch, dt, controls.distance);
  // Куст, внутри которого физически камера, целиком прячется — иначе взгляд
  // от первого лица упирается в стену из десятков полупрозрачных кубиков
  // подряд, а это на глаз неотличимо от сплошной (см. setActiveBush).
  scene.setActiveBush(fpv ? bushIndexAt(bushes, camX, camZ) : -1);
  drawAim(state.x, state.z, state.turret);
}

/** Своё последнее нарисованное положение: по нему считается дальность маскировки. */
let selfX = 0;
let selfZ = 0;

/** id товарища, на которого сейчас переключена камера; 0 — камера на себе. */
let spectateId = 0;

/**
 * Живых по сторонам командного боя — считаем сами по ростеру и последнему
 * снапшоту, а не ждём отдельное сообщение от сервера: тогда счёт в HUD не
 * отстаёт от кадра, а падает ровно в момент гибели.
 */
function teamAliveCounts(): { a: number; b: number } {
  const latest = snapshots[snapshots.length - 1];
  let a = 0;
  let b = 0;
  for (const [id, info] of players) {
    if (info.team !== TEAM_ONE && info.team !== TEAM_TWO) continue;
    if (latest?.entries.get(id)?.d === 1) continue;
    if (info.team === TEAM_ONE) a++;
    else b++;
  }
  return { a, b };
}

/**
 * Ближайший живой союзник и его положение на текущий момент интерполяции —
 * той же формулой, что рисует чужие танки в drawOthers, чтобы камера ехала за
 * той же сглаженной точкой, а не дёргалась отдельно от самого танка на экране.
 */
function spectateCamera(renderTime: number): { id: number; x: number; z: number } | null {
  const frame = interpFrame(renderTime);
  if (!frame) return null;
  const me = players.get(selfId);
  if (!me) return null;

  let bestId = 0;
  let bestDist = Infinity;
  for (const [id, entry] of frame.to.entries) {
    if (id === selfId || entry.d !== 0) continue;
    const info = players.get(id);
    if (!info || !alliedTeams(mode, me.team, info.team)) continue;
    const dist = Math.hypot(entry.x - selfX, entry.z - selfZ);
    if (dist < bestDist) {
      bestDist = dist;
      bestId = id;
    }
  }
  if (bestId === 0) return null;

  const target = frame.to.entries.get(bestId)!;
  const start = frame.from.entries.get(bestId) ?? target;
  const t = frame.t;
  return { id: bestId, x: start.x + (target.x - start.x) * t, z: start.z + (target.z - start.z) * t };
}

/** Подпись «смотришь за …» в карточке смерти: видна, только пока камера чужая. */
function setSpectateTarget(id: number): void {
  if (id === spectateId) return;
  spectateId = id;
  const info = id !== 0 ? players.get(id) : undefined;
  deathSpectate.hidden = !info;
  if (info) deathSpectate.textContent = `Смотришь за игроком ${info.name}`;
}

/** Докуда добьёт метка прицела, если на пути ничего нет, м. */
const AIM_RANGE = 140;

/**
 * Метка встаёт туда, куда смотрит ствол, а не в центр экрана. Башня доворачивается
 * с задержкой и стреляет от дульного среза, поэтому центр кадра — это не точка
 * попадания, и целиться по нему нельзя. Луч считается тем же свипом, что и снаряд,
 * так что метка садится ровно на то препятствие, в которое упрётся выстрел.
 */
function drawAim(x: number, z: number, turret: number): void {
  if (myDead) {
    crosshair.hidden = true;
    return;
  }

  const dx = Math.sin(turret);
  const dz = Math.cos(turret);
  const probe: ShellState = {
    id: 0,
    owner: selfId,
    x: x + dx * MUZZLE_OFFSET,
    z: z + dz * MUZZLE_OFFSET,
    vx: dx * AIM_RANGE,
    vz: dz * AIM_RANGE,
    life: 1,
    bounces: 0,
  };
  // dt = 1, поэтому свип разбирает ровно отрезок длиной AIM_RANGE.
  // Метка прицела упирается в укрытия, а не во всё подряд: низкий блок она проходит.
  const wall = sweepShell(probe, 1, cover, mapHalf);
  const travel = wall ? wall.t : 1;

  const point = scene.project(
    probe.x + probe.vx * travel,
    SHELL_HEIGHT,
    probe.z + probe.vz * travel,
  );
  crosshair.hidden = point === null;
  if (point) {
    crosshair.style.transform = `translate(${Math.round(point.x)}px, ${Math.round(point.y)}px)`;
  }
}

function drawOthers(renderTime: number): void {
  const frame = interpFrame(renderTime);
  if (!frame) return;
  const { from, to, t } = frame;

  if (mode === MODE_ROYALE) {
    // Отсутствие врага в снапшоте — это намеренный «не засвечен», а не потеря
    // пакета. Союзники и свой танк сервер присылает всегда.
    for (const info of players.values()) {
      if (info.id === selfId) continue;
      const me = players.get(selfId);
      const ally = me !== undefined && alliedTeams(mode, me.team, info.team);
      scene.setTankVisibility(info.id, ally || to.entries.has(info.id));
    }
  }

  for (const [id, target] of to.entries) {
    if (!players.has(id)) continue; // снапшот обогнал сообщение joined
    // Здоровье и «жив ли» берём и для себя тоже: свой танк рисуется предсказанием,
    // но его полоска и видимость живут по тем же данным, что и у остальных.
    scene.setTankHealth(
      id,
      target.h,
      target.d === 0,
      target.m ?? (players.get(id)?.bot ? BOT_HP : expeditionMaxHp),
    );
    // Свой танк под маскировкой видно всегда: прятать его от себя незачем.
    // Кусты на экран не влияют — они рвут обзор только у ИИ ботов (see bot.ts):
    // человек всегда видит всех, кого видел бы без кустов вовсе.
    scene.setTankStealth(
      id,
      id !== selfId &&
        hasEffect(target.f ?? 0, BONUS_STEALTH) &&
        Math.hypot(target.x - selfX, target.z - selfZ) > BONUS_STEALTH_RANGE,
    );
    if (mode === MODE_ROYALE) scene.setTankVisibility(id, true);
    if (id === selfId) continue;

    const start = from.entries.get(id) ?? target;
    scene.updateTank(
      id,
      start.x + (target.x - start.x) * t,
      start.z + (target.z - start.z) * t,
      lerpAngle(start.a, target.a, t),
      lerpAngle(start.t, target.t, t),
    );
  }

  drawShells(from, to, t);
}

/** Лёгкая карта сверху: рисуется только поверх HUD и не зависит от Three.js-сцены. */
function drawMinimap(renderTime: number): void {
  if (minimap.hidden || mapHalf <= 0) return;
  const cssSize = minimapCanvas.clientWidth;
  if (cssSize <= 0) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelSize = Math.round(cssSize * dpr);
  if (minimapCanvas.width !== pixelSize || minimapCanvas.height !== pixelSize) {
    minimapCanvas.width = pixelSize;
    minimapCanvas.height = pixelSize;
  }
  const ctx = minimapCanvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssSize, cssSize);

  const pad = 2;
  const size = cssSize - pad * 2;
  const worldToMap = (x: number, z: number): [number, number] => [
    pad + ((x + mapHalf) / (mapHalf * 2)) * size,
    pad + ((z + mapHalf) / (mapHalf * 2)) * size,
  ];
  const radiusToMap = (radius: number): number => (radius / (mapHalf * 2)) * size;

  ctx.fillStyle = 'rgba(27, 43, 42, 0.95)';
  ctx.fillRect(pad, pad, size, size);
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad, pad, size, size);
  ctx.clip();
  for (const box of minimapObstacles) {
    const [x, z] = worldToMap(box.x - box.w / 2, box.z - box.d / 2);
    const w = Math.max(1, (box.w / (mapHalf * 2)) * size);
    const h = Math.max(1, (box.d / (mapHalf * 2)) * size);
    ctx.fillStyle = box.style === 'road' || box.style === 'sidewalk'
      ? 'rgba(128, 141, 135, 0.28)'
      : box.style === 'tree'
        ? 'rgba(47, 99, 67, 0.52)'
        : 'rgba(112, 119, 111, 0.68)';
    ctx.fillRect(x, z, w, h);
  }

  const zone = royaleZone;
  if (mode === MODE_ROYALE && zone && zone.r > 0) {
    // Затемнение опасной части карты: даже огромный стартовый круг корректно обрежется рамкой.
    ctx.fillStyle = 'rgba(224, 69, 67, 0.22)';
    ctx.beginPath();
    ctx.rect(pad, pad, size, size);
    const [cx, cz] = worldToMap(zone.x, zone.z);
    ctx.moveTo(cx + radiusToMap(zone.r), cz);
    ctx.arc(cx, cz, radiusToMap(zone.r), 0, Math.PI * 2);
    ctx.fill('evenodd');

    if (zone.phase !== 'over' && zone.nextR > 0) {
      const [nx, nz] = worldToMap(zone.nextX, zone.nextZ);
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = zone.phase === 'final' ? '#ff6473' : '#8fe6ff';
      ctx.beginPath();
      ctx.arc(nx, nz, radiusToMap(zone.nextR), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (Math.hypot(nx - cx, nz - cz) > 3) {
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = '#d8f5ff';
        ctx.beginPath();
        ctx.moveTo(cx, cz);
        ctx.lineTo(nx, nz);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = zone.phase === 'final' ? '#ff6473' : zone.phase === 'shrinking' ? '#ffad6d' : '#8fe6ff';
    ctx.beginPath();
    ctx.arc(cx, cz, radiusToMap(zone.r), 0, Math.PI * 2);
    ctx.stroke();
  }

  const frame = interpFrame(renderTime);
  const me = players.get(selfId);
  if (frame && me) {
    for (const [id, target] of frame.to.entries) {
      if (target.d !== 0 || id === selfId) continue;
      const info = players.get(id);
      if (!info) continue;
      const start = frame.from.entries.get(id) ?? target;
      const x = start.x + (target.x - start.x) * frame.t;
      const z = start.z + (target.z - start.z) * frame.t;
      const [mx, mz] = worldToMap(x, z);
      if (!alliedTeams(mode, me.team, info.team)) continue;
      ctx.fillStyle = '#76d9ff';
      ctx.beginPath();
      ctx.arc(mx, mz, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const [selfMapX, selfMapZ] = worldToMap(selfX, selfZ);
  const selfState = self.sample(stepAccumulator / DT);
  const selfAngle = selfState?.angle ?? 0;
  ctx.save();
  ctx.translate(selfMapX, selfMapZ);
  // Canvas Y направлен вниз, поэтому для совпадения с Three.js вращаем в обратную сторону.
  ctx.rotate(-selfAngle);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#102021';
  ctx.lineWidth = 1;
  ctx.beginPath();
  // В мире угол 0 смотрит в +Z, а +Z на миникарте направлен вниз.
  ctx.moveTo(0, 5);
  ctx.lineTo(3.5, -4);
  ctx.lineTo(0, -2.5);
  ctx.lineTo(-3.5, -4);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  ctx.restore();

  minimapStatus.textContent = mode === MODE_ROYALE && zone
    ? zone.phase === 'shrinking' ? `сжатие · ${Math.ceil(zone.until)}с`
      : zone.phase === 'final' ? 'финал'
        : zone.phase === 'over' ? 'матч завершён' : `следующая зона · ${Math.ceil(zone.until)}с`
    : '';
}

/**
 * Снаряды интерполируются вместе с танками — тем же t по тем же снапшотам,
 * иначе снаряд и цель жили бы в разных моментах времени.
 */
function drawShells(from: BufferedSnapshot, to: BufferedSnapshot, t: number): void {
  const previous = new Map<number, SnapshotShell>();
  for (const shell of from.shells) previous.set(shell.i, shell);

  const list = to.shells.map((shell) => {
    const start = previous.get(shell.i);
    const ownerFrom = from.entries.get(shell.o) ?? to.entries.get(shell.o);
    const ownerTo = to.entries.get(shell.o) ?? ownerFrom;
    const ownerX = ownerFrom && ownerTo ? ownerFrom.x + (ownerTo.x - ownerFrom.x) * t : null;
    const ownerZ = ownerFrom && ownerTo ? ownerFrom.z + (ownerTo.z - ownerFrom.z) * t : null;
    const muzzleX = ownerX === null ? null : ownerX + Math.sin(shell.a) * MUZZLE_OFFSET;
    const muzzleZ = ownerZ === null ? null : ownerZ + Math.cos(shell.a) * MUZZLE_OFFSET;
    // Пока снаряд не отлетел от дула, хвост не может быть длиннее пути,
    // который уже пройден: иначе трассер рисовался бы внутри орудия.
    const trailAt = (x: number, z: number) =>
      muzzleX === null || muzzleZ === null ? TRACER_LENGTH : Math.min(TRACER_LENGTH, Math.hypot(x - muzzleX, z - muzzleZ));
    if (!start) {
      // Первый кадр снаряда начинается прямо у дула, а не в первой уже
      // продвинутой серверной позиции. За интервал снапшота он догоняет
      // авторитетную точку — без телепорта трассера на пару метров вперёд.
      if (!knownShells.has(shell.i)) {
        knownShells.add(shell.i);
        // Танк стрелявшего мог ещё не доехать сообщением joined; тогда остаётся
        // вспышка по координатам снаряда, отмотанным назад к дульному срезу.
        if (shell.o !== selfId) {
          audio.playShot(Math.hypot(shell.x - selfX, shell.z - selfZ));
        }
        if (shell.o !== selfId && !scene.tankFired(shell.o)) {
          scene.muzzleFlash(
            shell.x - Math.sin(shell.a) * MUZZLE_OFFSET * 0.25,
            shell.z - Math.cos(shell.a) * MUZZLE_OFFSET * 0.25,
            shell.a,
          );
        }
      }
      if (muzzleX !== null && muzzleZ !== null) {
        const x = muzzleX + (shell.x - muzzleX) * t;
        const z = muzzleZ + (shell.z - muzzleZ) * t;
        return {
          id: shell.i,
          x,
          z,
          angle: shell.a,
          trail: trailAt(x, z),
        };
      }
      return { id: shell.i, x: shell.x, z: shell.z, angle: shell.a, trail: trailAt(shell.x, shell.z) };
    }
    // Между снапшотами был отскок: прямая от старой точки к новой срезала бы угол,
    // и снаряд на кадр-другой ушёл бы в стену. Показываем сразу новое положение.
    if (start.b !== shell.b) {
      return { id: shell.i, x: shell.x, z: shell.z, angle: shell.a, trail: trailAt(shell.x, shell.z) };
    }
    const x = start.x + (shell.x - start.x) * t;
    const z = start.z + (shell.z - start.z) * t;
    return {
      id: shell.i,
      x,
      z,
      angle: shell.a,
      trail: trailAt(x, z),
    };
  });

  scene.syncShells(list);
  // Множество id могло бы расти вечно — чистим, когда снарядов в мире нет.
  if (list.length === 0 && knownShells.size > 0) knownShells.clear();
}

// --- Интерфейс ---

const hudOnline = el('hud-online');
const hudAlive = el('hud-alive');
const hudAliveValue = el('hud-alive-value');
const hudPing = el('hud-ping');
const hudSpeed = el('hud-speed');
const hudHpFill = el('hud-hp-fill');
const hudHpValue = el('hud-hp-value');
const hudReloadFill = el('hud-reload-fill');
const hudReload = el('hud-reload');
const damageFlash = el('damage-flash');
const hitmarker = el('hitmarker');
const killFeed = el('kill-feed');
const deathScreen = el('death');
const deathTimer = el('death-timer');
const deathNote = el('death-note');
const deathRespawn = el('death-respawn');
const deathSpectate = el('death-spectate');
const hudMode = el('hud-mode');
const hudFx = el('hud-fx');
const banner = el('wave-banner');
const bannerTitle = el('wave-title');
const bannerSub = el('wave-sub');
const expeditionPanel = el('expedition');
const expeditionCards = el('expedition-cards');
const expeditionStats = el('expedition-stats');
const setupPanel = el('setup');
const setupNote = el('setup-note');
const setupToggle = el<HTMLButtonElement>('setup-toggle');
const setupOwner = el('setup-owner');
const setupMaps = el('setup-maps');
const setupModes = el('setup-modes');
const setupTeamsizeLabel = el('setup-teamsize-label');
const setupTeamsize = el('setup-teamsize');
const hintTeamsize = el('hint-teamsize');
const setupRoyaleSizeLabel = el('setup-royale-size-label');
const setupRoyaleSize = el('setup-royale-size');
const hintRoyaleSize = el('hint-royale-size');
const setupRules = el('setup-rules');
const setupDiffs = el('setup-diffs');
const setupStances = el('setup-stances');
const setupBonuses = el<HTMLInputElement>('setup-bonuses');
const setupBloom = el<HTMLInputElement>('setup-bloom');
const setupWeather = el<HTMLInputElement>('setup-weather');
const setupFpv = el<HTMLInputElement>('setup-fpv');
const setupReticles = el('setup-reticles');
const hintChase = el('hint-chase');
const hintFpvView = el('hint-fpv');
const hintMap = el('hint-map');
const hintMode = el('hint-mode');
const hintRules = el('hint-rules');
const hintDiff = el('hint-diff');
const hintStance = el('hint-stance');
const hintBonuses = el('hint-bonuses');
const hintBloom = el('hint-bloom');
const hintWeather = el('hint-weather');
const hintView = el('hint-view');
const hintReticle = el('hint-reticle');
const leaderboardToggle = el<HTMLButtonElement>('leaderboard-toggle');
const leaderboardPanel = el('leaderboard');
const leaderboardRows = el('leaderboard-rows');
const inventoryToggle = el<HTMLButtonElement>('inventory-toggle');
const inventoryPanel = el('inventory');
const inventorySlots = el('inventory-slots');
const inventoryBag = el('inventory-bag');

function renderExpeditionChoices(): void {
  const show = mode === MODE_EXPEDITION && wave.phase === 'upgrade' && (wave.choices?.length ?? 0) > 0;
  expeditionPanel.hidden = !show;
  if (!show) return;
  const speed = expeditionBasePower * (wave.upgrades ?? []).reduce(
    (value, id) => value * (EXPEDITION_UPGRADES[id]?.speed ?? 1),
    1,
  );
  const damage = (wave.upgrades ?? []).reduce(
    (value, id) => value * (EXPEDITION_UPGRADES[id]?.damage ?? 1),
    1,
  );
  const reload = expeditionReloadMultiplier();
  const health = (wave.upgrades ?? []).reduce(
    (value, id) => value * (EXPEDITION_UPGRADES[id]?.health ?? 1),
    1,
  );
  expeditionStats.textContent =
    `Сейчас: ход ${Math.round(speed * 100)}% · урон ${Math.round(damage * 100)}% · перезарядка ${Math.round(reload * 100)}% · HP ${Math.round(health * 100)}%`;
  expeditionCards.replaceChildren();
  for (const choice of wave.choices ?? []) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'expedition-card';
    card.innerHTML = `<b>${choice.name}</b><span>${choice.description}</span>`;
    card.addEventListener('click', () => net.sendUpgrade(choice.id), { once: true });
    expeditionCards.appendChild(card);
  }
}

function updateHud(): void {
  // Ботов в «в бою» не считаем: это счётчик живых людей.
  let humans = 0;
  for (const info of players.values()) if (info.bot !== 1) humans++;
  hudOnline.textContent = String(humans);
  hudAlive.hidden = mode !== MODE_ROYALE;
  hudAliveValue.textContent = String(wave.royaleAlive ?? 0);
}

function moduleColor(id: number): string {
  const tier = ROYALE_MODULE_BY_ID.get(id)?.tier ?? 1;
  return `#${ROYALE_MODULE_TIER_COLORS[tier].toString(16).padStart(6, '0')}`;
}

function moduleCard(id: number, emptyLabel?: string): HTMLElement {
  const item = ROYALE_MODULE_BY_ID.get(id);
  const card = document.createElement('div');
  card.className = `module-card${item ? '' : ' is-empty'}`;
  card.style.setProperty('--module', item ? moduleColor(id) : '#65747b');
  if (item) card.innerHTML = `<b>T${item.tier} · ${item.name}</b><small>${item.short}</small>`;
  else card.innerHTML = `<b>${emptyLabel ?? 'Пусто'}</b><small>Нет модуля</small>`;
  return card;
}

function sameLoadout(a: SnapshotLoadout, b: SnapshotLoadout): boolean {
  if (a.inventory.length !== b.inventory.length || a.equipped.length !== b.equipped.length) return false;
  return a.inventory.every((id, index) => id === b.inventory[index]) &&
    a.equipped.every((id, index) => id === b.equipped[index]);
}

/** Рисуем только собственный рюкзак: содержимое противников клиент не получает. */
function renderRoyaleLoadout(): void {
  inventorySlots.replaceChildren();
  inventoryBag.replaceChildren();
  for (let slot = 0; slot < MODULE_SLOT_COUNT; slot++) {
    const card = moduleCard(royaleLoadout.equipped[slot] ?? 0, MODULE_SLOT_NAMES[slot]);
    inventorySlots.appendChild(card);
  }
  royaleLoadout.inventory.forEach((id, index) => {
    const item = ROYALE_MODULE_BY_ID.get(id);
    const wrapper = document.createElement('div');
    wrapper.className = 'module-item';
    wrapper.style.setProperty('--module', item ? moduleColor(id) : '#65747b');
    const card = moduleCard(id);
    card.title = 'Выбери действие ниже';
    card.classList.add('is-interactive');
    card.addEventListener('click', () => net.manageLoadout('equip', index));
    wrapper.appendChild(card);
    const actions = document.createElement('div');
    actions.className = 'module-actions';
    const equip = document.createElement('button');
    equip.type = 'button';
    equip.className = 'module-action is-primary';
    equip.textContent = 'Установить';
    equip.disabled = !item || item.slot < 0 || item.heal !== undefined;
    equip.title = equip.disabled ? 'Расходуется автоматически при подборе' : 'Установить в слот модуля';
    equip.addEventListener('click', (event) => {
      event.stopPropagation();
      net.manageLoadout('equip', index);
    });
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'module-action';
    drop.textContent = 'Выбросить';
    drop.addEventListener('click', (event) => {
      event.stopPropagation();
      net.manageLoadout('drop', index);
    });
    actions.append(equip, drop);
    wrapper.appendChild(actions);
    inventoryBag.appendChild(wrapper);
  });
}

// --- Волны ---

function updateModeChip(): void {
  // Правила пишем в чип, только когда они не аркадные: слово «аркада» ничего
  // не сообщает — так игра выглядела всегда, — а места в чипе немного.
  const map =
    (rules === RULES_REAL ? `${RULES_NAMES[rules]} · ` : '') + (MAP_NAMES[mapId] ?? '');
  if (mode === MODE_DM) {
    hudMode.textContent = `${map} · все против всех`;
    return;
  }
  if (mode === MODE_TEAM) {
    if (wave.phase === 'over') {
      const myTeam = players.get(selfId)?.team;
      const result = wave.winner === 'draw' ? 'ничья' : wave.winner === myTeam ? 'победа' : 'поражение';
      hudMode.textContent = `${map} · командный бой ${teamSize}×${teamSize} · ${result} · новый раунд через ${Math.max(0, Math.ceil((waveUntilAt - performance.now()) / 1000))}с`;
      return;
    }
    const { a, b } = teamAliveCounts();
    hudMode.textContent = `${map} · командный бой ${teamSize}×${teamSize} · ${a}:${b}`;
    return;
  }
  if (mode === MODE_ROYALE) {
    const zone = royaleZone;
    const royalePhase = wave.royalePhase;
    const zoneText = royalePhase === 'countdown'
      ? `высадка через ${Math.ceil(wave.royaleUntil ?? 0)}с`
      : royalePhase === 'over'
        ? 'матч завершён'
        : !zone
      ? 'зона готовится'
      : zone.phase === 'shrinking'
        ? `зона сжимается · ${Math.ceil(zone.until)}с`
        : zone.phase === 'final'
          ? 'финальная зона'
          : zone.phase === 'over'
            ? 'матч завершён'
            : `зона через ${Math.ceil(zone.until)}с`;
    hudMode.textContent = `${map} · королевская битва · ${zoneText}`;
    return;
  }
  if (wave.phase === 'fight') {
    const power = mode === MODE_EXPEDITION ? ` · сила ${Math.round((wave.power ?? 1) * 100)}%` : '';
    hudMode.textContent = `${map} · волна ${wave.wave} · осталось ${wave.left}${power}`;
    return;
  }
  hudMode.textContent = `${map} · ${wave.phase === 'upgrade' ? 'мастерская' : wave.phase === 'break' ? 'передышка' : wave.victory ? 'экспедиция завершена' : 'забег окончен'}`;
}

/** Кэш последней надписи: плашка обновляется каждый кадр, а меняется раз в секунду. */
let bannerShown = '';

function updateBanner(now: number): void {
  if (mode === MODE_ROYALE) {
    updateRoyaleBanner();
    return;
  }
  if (mode === MODE_TEAM) {
    updateTeamBanner();
    return;
  }
  const visible =
    (mode === MODE_PVE || mode === MODE_EXPEDITION) && wave.wave > 0 && (wave.phase !== 'fight' || now < bannerHideAt);
  if (!visible) {
    if (!banner.hidden) {
      banner.hidden = true;
      bannerShown = '';
    }
    return;
  }

  const left = Math.max(0, Math.ceil((waveUntilAt - now) / 1000));
  let title: string;
  let sub: string;

  if (wave.phase === 'fight') {
    title = `Волна ${wave.wave}`;
    sub = `противников: ${wave.left}`;
  } else if (wave.phase === 'upgrade') {
    title = 'Мастерская';
    sub = 'выбери улучшение для всей команды';
  } else if (wave.phase === 'break') {
    title = `Волна ${wave.wave} зачищена`;
    sub = `следующая через ${left} · павшие возвращаются в строй`;
  } else {
    title = wave.victory ? 'Экспедиция завершена' : 'Забег окончен';
    sub = wave.victory
      ? `15 волн пройдено · заново через ${left}`
      : `дошли до волны ${wave.wave} · рекорд ${wave.best} · заново через ${left}`;
  }

  const key = `${title}|${sub}`;
  if (key !== bannerShown) {
    bannerShown = key;
    bannerTitle.textContent = title;
    bannerSub.textContent = sub;
  }
  banner.classList.toggle('is-over', wave.phase === 'over');
  banner.hidden = false;
}

function updateRoyaleBanner(): void {
  const phase = wave.royalePhase;
  if (phase !== 'countdown' && phase !== 'over') {
    if (!banner.hidden) {
      banner.hidden = true;
      bannerShown = '';
    }
    return;
  }

  const title = phase === 'countdown' ? 'Высадка' : 'Матч завершён';
  const sub = phase === 'countdown'
    ? `Старт через ${Math.max(0, Math.ceil(wave.royaleUntil ?? 0))} · состав готов`
    : 'Наблюдение за сквадом';
  const key = `${title}|${sub}`;
  if (key !== bannerShown) {
    bannerShown = key;
    bannerTitle.textContent = title;
    bannerSub.textContent = sub;
  }
  banner.classList.toggle('is-over', phase === 'over');
  banner.classList.toggle('is-win', false);
  banner.hidden = false;
}

/** Итог раунда командного боя: без волн — только «решено / не решено». */
function updateTeamBanner(): void {
  if (wave.phase !== 'over') {
    if (!banner.hidden) {
      banner.hidden = true;
      bannerShown = '';
    }
    return;
  }

  const left = Math.max(0, Math.ceil((waveUntilAt - performance.now()) / 1000));
  const myTeam = players.get(selfId)?.team;
  const title = wave.winner === 'draw' ? 'Ничья' : wave.winner === myTeam ? 'Победа' : 'Поражение';
  const sub = `Новый раунд через ${left}`;

  const key = `${title}|${sub}`;
  if (key !== bannerShown) {
    bannerShown = key;
    bannerTitle.textContent = title;
    bannerSub.textContent = sub;
  }
  banner.classList.toggle('is-over', title === 'Поражение');
  banner.classList.toggle('is-win', title === 'Победа');
  banner.hidden = false;
}

// --- Панель настроек ---

MAP_NAMES.forEach((label, index) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.map = String(index);
  button.addEventListener('click', () => net.sendSetup({ map: index }));
  setupMaps.appendChild(button);
});

for (const [value, label] of [
  [MODE_DM, 'Все против всех'],
  [MODE_PVE, 'Против ботов'],
  [MODE_EXPEDITION, 'Экспедиция'],
  [MODE_ROYALE, 'Королевская битва'],
  [MODE_TEAM, 'Командный бой'],
] as Array<[GameMode, string]>) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.mode = value;
  button.addEventListener('click', () => net.sendSetup({ mode: value }));
  setupModes.appendChild(button);
}

for (const size of TEAM_BATTLE_SIZES) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = `${size}×${size}`;
  button.dataset.teamsize = String(size);
  button.addEventListener('click', () => net.sendSetup({ teamSize: size }));
  setupTeamsize.appendChild(button);
}

for (const size of ROYALE_SQUAD_SIZES) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = size === 1 ? 'Соло' : size === 2 ? 'Дуо' : 'Сквад';
  button.dataset.royaleSize = String(size);
  button.addEventListener('click', () => net.sendSetup({ royaleSquadSize: size }));
  setupRoyaleSize.appendChild(button);
}

for (const value of [RULES_ARCADE, RULES_REAL] as Ruleset[]) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = RULES_NAMES[value];
  button.dataset.rules = value;
  button.addEventListener('click', () => net.sendSetup({ rules: value }));
  setupRules.appendChild(button);
}

DIFFICULTY_NAMES.forEach((label, index) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.diff = String(index);
  button.addEventListener('click', () => net.sendSetup({ diff: index }));
  setupDiffs.appendChild(button);
});

STANCE_NAMES.forEach((label, index) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.stance = String(index);
  button.addEventListener('click', () => net.sendSetup({ stance: index }));
  setupStances.appendChild(button);
});

for (const [id, label] of RETICLE_STYLES) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.reticle = id;
  button.addEventListener('click', () => {
    reticleStyle = id;
    crosshair.dataset.style = reticleStyle;
    localStorage.setItem('tanks:reticle', reticleStyle);
    renderSetup();
  });
  setupReticles.appendChild(button);
}

setupBonuses.addEventListener('change', () => net.sendSetup({ bonuses: setupBonuses.checked }));

/**
 * Свечение — личная настройка, в сеть она не уходит: три прохода размытия по
 * полному кадру стоят заметно, и что тянет одна машина, не тянет другая.
 * Выбор помним между заходами, иначе его пришлось бы снимать каждый раз.
 */
let bloomOn = localStorage.getItem('tanks:bloom') !== 'off';
scene.setBloom(bloomOn);
setupBloom.addEventListener('change', () => {
  bloomOn = setupBloom.checked;
  localStorage.setItem('tanks:bloom', bloomOn ? 'on' : 'off');
  scene.setBloom(bloomOn);
  renderSetup();
});

/**
 * Динамическая погода — тоже личная настройка: сервер о ней ничего не знает,
 * это чисто визуальный цикл на клиенте. Включена — весь бой погода меняется
 * случайным циклом и не останавливается, пока не сменится карта. Выключена —
 * карта держит стартовый профиль без переходов.
 */
let weatherOn = localStorage.getItem('tanks:weather') !== 'off';
scene.setDynamicWeather(weatherOn);
setupWeather.addEventListener('change', () => {
  weatherOn = setupWeather.checked;
  localStorage.setItem('tanks:weather', weatherOn ? 'on' : 'off');
  scene.setDynamicWeather(weatherOn);
  renderSetup();
});

/**
 * Вид от первого лица — от прицела башни, буквально вид игрока и бота почти
 * на равных: то же ограниченное поле зрения, тот же довод ствола (взгляд
 * идёт за реальным углом башни, см. drawSelf).
 *
 * В «Реализме» вид от третьего лица прямо запрещён — камера над танком
 * видит то, чего бот никогда не увидит, а весь смысл вида в равенстве.
 * Поэтому там fpv не личный выбор, а требование правил: fpvForced() всегда
 * побеждает. Личный выбор (fpvManual) при этом никуда не девается — просто
 * ждёт, пока правила снова станут аркадными, и тогда возвращает то, что
 * игрок выбрал сам (клавишей F или чекбоксом).
 */
let fpvManual = localStorage.getItem('tanks:fpv'); // 'on' | 'off' | null — null, пока не тронуто руками
// Настоящее значение (принудительно в реализме, личный выбор в аркаде)
// выставляет applyConfig() сразу же на первом 'welcome'.
let fpv = fpvManual === 'on';
applyView();

/** В «Реализме» вид от третьего лица запрещён: играть с камерой над танком нечестно. */
function fpvForced(): boolean {
  return rules === RULES_REAL;
}

function applyView(): void {
  hintChase.hidden = fpv;
  hintFpvView.hidden = !fpv;
}

function setFpv(on: boolean, manual: boolean): void {
  // Выключить нельзя, пока правила это запрещают — ни с клавиши, ни чекбоксом.
  if (!on && fpvForced()) return;
  if (manual) {
    fpvManual = on ? 'on' : 'off';
    localStorage.setItem('tanks:fpv', fpvManual);
  }
  if (on === fpv) return;
  fpv = on;
  applyView();
  renderSetup();
}

setupFpv.addEventListener('change', () => setFpv(setupFpv.checked, true));

function renderSetup(): void {
  const isHost = selfId !== 0 && selfId === hostId;
  const host = players.get(hostId);
  setupOwner.textContent = isHost ? 'настраиваешь ты' : host ? `настраивает ${host.name}` : '';

  setupBonuses.checked = bonusesOn;
  setupBonuses.disabled = !isHost;

  // Про волны — только там, где волны есть. В «Все против всех» это пять строк
  // не о том, и панель без них заметно короче.
  setupNote.hidden = mode !== MODE_PVE && mode !== MODE_EXPEDITION && mode !== MODE_ROYALE && mode !== MODE_TEAM;
  setupNote.textContent =
    mode === MODE_ROYALE
      ? `Большая карта 900×900: формат ${royaleSquadLabel(royaleSquadSize)}, союзные боты, одна жизнь и зона, которая постепенно сжимается.`
      : mode === MODE_TEAM
        ? 'Раунд без возрождения: погиб — смотришь за живым союзником до конца раунда. Побеждает сторона, уничтожившая всех; если за 5 минут бой не решён — ничья, и начинается новый раунд.'
        : 'Волны растут: сначала числом, потом выучкой. В «Экспедиции» забег длится 15 волн, а между ними команда выбирает одно общее улучшение.';

  setupTeamsizeLabel.hidden = mode !== MODE_TEAM;
  setupTeamsize.hidden = mode !== MODE_TEAM;
  hintTeamsize.hidden = mode !== MODE_TEAM;
  for (const button of setupTeamsize.querySelectorAll('button')) {
    button.classList.toggle('is-on', Number(button.dataset.teamsize) === teamSize);
    button.disabled = !isHost;
  }
  hintTeamsize.textContent = 'Срабатывает сразу: новый раунд с новым составом сторон.';

  setupRoyaleSizeLabel.hidden = mode !== MODE_ROYALE;
  setupRoyaleSize.hidden = mode !== MODE_ROYALE;
  hintRoyaleSize.hidden = mode !== MODE_ROYALE;
  for (const button of setupRoyaleSize.querySelectorAll('button')) {
    button.classList.toggle('is-on', Number(button.dataset.royaleSize) === royaleSquadSize);
    button.disabled = !isHost;
  }
  hintRoyaleSize.textContent = 'Срабатывает сразу: матч перезапустится с выбранным размером отряда.';

  // Галка в панели, которая работает у всех: она не про бой.
  setupFpv.checked = fpv;
  setupFpv.disabled = fpvForced();
  hintView.textContent = fpv
    ? fpvForced()
      ? 'Включён правилами «Реализм» и не выключается: камера сидит у башни и доворачивается не быстрее самой башни — тем же обзором, что и у бота.'
      : 'Камера сидит у башни и смотрит только туда, куда наводишь, — ни кругового обзора, ни вида на себя со стороны, как у бота.'
    : 'Выключено: камера за танком. На телефоне обзор придётся крутить пальцем — тем же, которым стреляешь.';

  setupBloom.checked = bloomOn;
  hintBloom.textContent = bloomOn
    ? 'Трассеры, вспышки и взрывы разгораются. Если кадры проседают — сними.'
    : 'Выключено: кадр рисуется одним проходом, без размытия по всему экрану.';

  setupWeather.checked = weatherOn;
  hintWeather.textContent = weatherOn
    ? 'Погода весь бой идёт случайным циклом — от ясной до дождя, тумана и снега — и останавливается только со сменой карты.'
    : 'Выключено: карта держит один стартовый профиль погоды без переходов.';

  for (const button of setupReticles.querySelectorAll('button')) {
    button.classList.toggle('is-on', button.dataset.reticle === reticleStyle);
  }
  hintReticle.textContent = RETICLE_STYLES.find(([id]) => id === reticleStyle)?.[2] ?? '';

  for (const button of setupMaps.querySelectorAll('button')) {
    button.classList.toggle('is-on', Number(button.dataset.map) === mapId);
    button.disabled = !isHost;
  }
  for (const button of setupModes.querySelectorAll('button')) {
    button.classList.toggle('is-on', button.dataset.mode === mode);
    button.disabled = !isHost;
  }
  for (const button of setupRules.querySelectorAll('button')) {
    button.classList.toggle('is-on', button.dataset.rules === rules);
    button.disabled = !isHost;
  }
  const botMode = mode === MODE_PVE || mode === MODE_EXPEDITION || mode === MODE_ROYALE || mode === MODE_TEAM;
  const pending = botMode && activeDifficulty !== difficulty;
  for (const button of setupDiffs.querySelectorAll('button')) {
    const tier = Number(button.dataset.diff);
    button.classList.toggle('is-on', tier === difficulty);
    // Пока выбор не вступил в силу, отдельно помечаем то, по чему идёт бой.
    button.classList.toggle('is-live', pending && tier === activeDifficulty);
    // Сложность имеет смысл только в режиме ботов.
    button.disabled = !isHost || !botMode;
  }

  for (const button of setupStances.querySelectorAll('button')) {
    button.classList.toggle('is-on', Number(button.dataset.stance) === stance);
    button.disabled = !isHost;
  }
  hintStance.textContent = STANCE_HINTS[stance];

  // Главное, чего не хватало: когда настройка сработает.
  hintMap.textContent = MAP_HINTS[mapId];
  hintMode.textContent =
    mode === MODE_ROYALE
      ? 'Срабатывает сразу: включит карту «Рубеж» 900×900 и начнёт новый матч.'
      : mode === MODE_TEAM
        ? 'Срабатывает сразу: разведёт игроков по двум сторонам через одного и начнёт раунд.'
        : 'Срабатывает сразу: бой начинается заново, счёт обнуляется.';
  hintRules.textContent = RULES_HINTS[rules];
  hintBonuses.textContent = bonusesOn
    ? 'Срабатывает сразу: выключение уберёт ящики и снимет действующие усиления.'
    : 'Срабатывает сразу: ящики начнут появляться на карте.';

  if (!botMode) {
    hintDiff.textContent = 'Работает только в режиме «Против ботов».';
  } else if (pending) {
    hintDiff.textContent =
      `Сейчас в бою: ${DIFFICULTY_NAMES[activeDifficulty]}. ` +
      `Выбранная включится ${whenDifficulty()} — вышедшие боты не переучиваются.`;
  } else if (mode === MODE_TEAM) {
    hintDiff.textContent = 'Действует с нового раунда.';
  } else if (wave.phase === 'fight') {
    hintDiff.textContent = 'Смена включится со следующей волны: эту доигрываем как есть.';
  } else {
    hintDiff.textContent = 'Срабатывает с ближайшей волны.';
  }
}

function toggleSetup(open = setupPanel.hidden): void {
  setupPanel.hidden = !open;
  // С захваченным курсором по кнопкам не кликнешь.
  if (open && document.pointerLockElement) document.exitPointerLock();
  if (open) renderSetup();
}

setupToggle.addEventListener('click', () => toggleSetup());

/** Доска лидеров — своя маленькая панель, открывается тем же жестом, что настройки. */
function toggleLeaderboard(open = leaderboardPanel.hidden): void {
  leaderboardPanel.hidden = !open;
  if (open && document.pointerLockElement) document.exitPointerLock();
  if (open) renderLeaderboard();
}

function renderLeaderboard(): void {
  leaderboardRows.innerHTML = '';
  if (leaderboardEntries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'leaderboard-empty';
    empty.textContent = 'Пока пусто — сыграйте раунд командного боя.';
    leaderboardRows.appendChild(empty);
    return;
  }
  leaderboardEntries.forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = 'leaderboard-row';
    row.innerHTML =
      `<span class="leaderboard-rank">${index + 1}</span>` +
      `<span class="leaderboard-name">${escapeHtml(entry.name)}</span>` +
      `<span>${entry.wins}П</span>` +
      `<span>${entry.losses}Пр</span>` +
      `<span>${entry.draws}Н</span>` +
      `<span>${entry.kills} фрагов</span>`;
    leaderboardRows.appendChild(row);
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

leaderboardToggle.addEventListener('click', () => toggleLeaderboard());
inventoryToggle.addEventListener('click', () => {
  if (mode === MODE_ROYALE) inventoryPanel.hidden = !inventoryPanel.hidden;
});

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return;
  if (hud.hidden) return; // до входа в бой настраивать нечего
  if (event.code === 'KeyM') toggleSetup();
  else if (event.code === 'KeyF') setFpv(!fpv, true);
  else if (event.code === 'KeyI' && mode === MODE_ROYALE) inventoryPanel.hidden = !inventoryPanel.hidden;
});

function updateHealthHud(): void {
  const maxHp = mode === MODE_ROYALE ? myMaxHp : expeditionMaxHp;
  const fraction = clamp(myHp / maxHp, 0, 1);
  hudHpFill.style.width = `${(fraction * 100).toFixed(0)}%`;
  hudHpFill.style.background = `hsl(${Math.round(fraction * 105)} 70% 48%)`;
  hudHpValue.textContent = mode === MODE_EXPEDITION || mode === MODE_ROYALE
    ? `${myHp}/${maxHp}`
    : String(myHp);
}

/** Красная засветка по краям экрана, когда прилетело. */
function flashDamage(): void {
  damageFlash.classList.remove('is-on');
  void damageFlash.offsetWidth; // перезапуск CSS-анимации требует reflow
  damageFlash.classList.add('is-on');
}

function showHitmarker(): void {
  hitmarker.classList.remove('is-on');
  void hitmarker.offsetWidth;
  hitmarker.classList.add('is-on');
}

function pushKillFeed(killer: string, victim: string): void {
  pushFeed(`${killer} 💥 ${victim}`);
}

function pushFeed(text: string, extra = ''): void {
  const line = document.createElement('div');
  line.className = extra ? `kill-line ${extra}` : 'kill-line';
  line.textContent = text;
  killFeed.prepend(line);
  while (killFeed.childElementCount > 4) killFeed.lastElementChild?.remove();
  window.setTimeout(() => line.remove(), 6000);
}

// --- Бонусы ---

/** Чипы старых таймерных бонусов; «Ремонт» мгновенный, поэтому чипа у него нет. */
const TIMED_BONUSES = [BONUS_DAMAGE, BONUS_RELOAD, BONUS_SPEED, BONUS_STEALTH];
const fxChips = new Map<number, HTMLElement>();
const royaleModuleChips = new Array<HTMLElement>(MODULE_SLOT_COUNT);

for (const kind of TIMED_BONUSES) {
  const chip = document.createElement('span');
  chip.className = 'hud-chip fx-chip';
  chip.style.setProperty('--fx', `#${BONUS_COLORS[kind].toString(16).padStart(6, '0')}`);
  chip.hidden = true;
  hudFx.appendChild(chip);
  fxChips.set(kind, chip);
}
for (let slot = 0; slot < MODULE_SLOT_COUNT; slot++) {
  const chip = document.createElement('span');
  chip.className = 'hud-chip fx-chip';
  chip.hidden = true;
  hudFx.appendChild(chip);
  royaleModuleChips[slot] = chip;
}

function onPickup(id: number, kind: number): void {
  const who = players.get(id);
  const name = mode === MODE_ROYALE ? ROYALE_MODULE_BY_ID.get(kind)?.name : BONUS_NAMES[kind];
  pushFeed(`${who?.name ?? 'Кто-то'} ◆ ${name ?? 'Контейнер'}`, 'is-bonus');
  if (id !== selfId) return;

  // Секунды считаем сами: сервер шлёт только факт «эффект висит», а длительность
  // и так известна обеим сторонам. Если маска погаснет раньше — чип уйдёт с ней.
  if (mode !== MODE_ROYALE && kind !== BONUS_HEAL) {
    effectUntil[kind] = performance.now() + BONUS_DURATION_S[kind] * 1000;
  }
  updateEffectsHud();
}

function updateEffectsHud(now = performance.now()): void {
  for (const kind of TIMED_BONUSES) {
    const chip = fxChips.get(kind)!;
    const on = mode !== MODE_ROYALE && hasEffect(myEffects, kind);
    chip.hidden = !on;
    if (!on) continue;
    const left = Math.max(0, Math.ceil((effectUntil[kind] - now) / 1000));
    const text = `${BONUS_NAMES[kind]} ${left}`;
    if (chip.textContent !== text) chip.textContent = text;
  }
  for (let slot = 0; slot < MODULE_SLOT_COUNT; slot++) {
    const chip = royaleModuleChips[slot];
    const item = ROYALE_MODULE_BY_ID.get(royaleLoadout.equipped[slot] ?? 0);
    const on = mode === MODE_ROYALE && item !== undefined;
    chip.hidden = !on;
    if (item) {
      chip.style.setProperty('--fx', moduleColor(item.id));
      chip.textContent = `T${item.tier} ${item.name}`;
    }
  }
}

/** Кэш последних значений: писать в стиль каждый кадр — лишний пересчёт раскладки. */
let reloadShown = '';
let respawnShown = '';

function updateReloadHud(now: number): void {
  const left = reloadUntil - now;
  const ready = left <= 0;
  const width = ready ? '100%' : `${Math.round(100 - (left / reloadSpan) * 100)}%`;
  if (width === reloadShown) return;
  reloadShown = width;
  hudReloadFill.style.width = width;
  hudReload.classList.toggle('is-ready', ready);
}

function updateDeathScreen(now = performance.now()): void {
  // Итоги забега показывает плашка волны — две карточки разом были бы лишними.
  const byWave = mode === MODE_PVE || mode === MODE_EXPEDITION;
  const byRoyale = mode === MODE_ROYALE;
  const show = myDead && !(byWave && wave.phase === 'over');
  deathScreen.hidden = !show;
  if (!show) {
    respawnShown = '';
    return;
  }

  // В BR и режиме ботов жизнь одна: после гибели можно только наблюдать.
  deathRespawn.hidden = byWave || byRoyale;
  deathNote.hidden = !byWave && !byRoyale;

  const text = byRoyale
    ? 'Твой танк уничтожен · наблюдение за сквадом'
    : byWave
    ? wave.phase === 'break' || wave.phase === 'upgrade'
      ? 'В строю со следующей волной'
      : 'В строю, когда волна будет зачищена'
    : String(Math.max(0, Math.ceil((respawnAt - now) / 1000)));

  if (text === respawnShown) return;
  respawnShown = text;
  if (byWave || byRoyale) deathNote.textContent = text;
  else deathTimer.textContent = text;
}

function updateRoyaleDrop(now: number): void {
  if (mode !== MODE_ROYALE || wave.royalePhase !== 'countdown') {
    scene.setRoyaleDrop(1, mapHalf);
    return;
  }
  const total = ROYALE_START_COUNTDOWN_S * 1000;
  const left = Math.max(0, waveUntilAt - now);
  scene.setRoyaleDrop(1 - left / total, mapHalf);
}

let speedTimer = 0;
function updateSpeed(): void {
  // Цифры обновляем 10 раз в секунду — иначе они мельтешат и грузят layout.
  const now = performance.now();
  if (now - speedTimer < 100) return;
  speedTimer = now;
  hudSpeed.textContent = String(Math.round(Math.abs(self.speed) * 3.6));
  hudPing.textContent = net.latency > 0 ? String(net.latency) : '—';
  // Обратный отсчёт бонусов тикает здесь же — десяти раз в секунду хватает.
  updateEffectsHud(now);
}

function setStatus(text: string, isError = false): void {
  status.textContent = text;
  status.classList.toggle('is-error', isError);
}

function hideOverlay(): void {
  overlay.classList.add('is-hidden');
  hud.hidden = false;
  minimap.hidden = false;
  // Прицел покажется сам, как только появится своё состояние: его место
  // считается от ствола, а не от центра экрана.
  setupToggle.hidden = false;
  leaderboardToggle.hidden = false;
  setStatus('');
  joinButton.disabled = false;
  renderSetup();

  if (controls.isTouch) {
    touchLayer.hidden = false;
    hint.hidden = true;
  } else {
    hint.hidden = false;
    window.setTimeout(() => hint.classList.add('is-faded'), 9000);
  }
}

function showOverlay(message: string, isError = false): void {
  overlay.classList.remove('is-hidden');
  hud.hidden = true;
  minimap.hidden = true;
  crosshair.hidden = true;
  hint.hidden = true;
  touchLayer.hidden = true;
  setupToggle.hidden = true;
  setupPanel.hidden = true;
  leaderboardToggle.hidden = true;
  leaderboardPanel.hidden = true;
  banner.hidden = true;
  expeditionPanel.hidden = true;
  joinButton.disabled = false;
  joinButton.textContent = 'Переподключиться';
  setStatus(message, isError);
}

function resetWorld(): void {
  // Именно clearTanks, а не обход players: догорающие остовы из комнаты уже вышли.
  audio.stopEngine();
  scene.clearTanks();
  players.clear();
  snapshots.length = 0;
  minimapObstacles = [];
  pendingBooms.length = 0;
  pendingHits.length = 0;
  knownShells.clear();
  scene.clearShells();
  selfId = 0;
  hostId = 0;
  configKnown = false;
  // Пока нас не было, хост мог сменить карту — на переподключении собираем мир заново.
  worldBuilt = false;
  myHp = MAX_HP;
  myMaxHp = MAX_HP;
  expeditionMaxHp = MAX_HP;
  myDead = false;
  spectateId = 0;
  deathSpectate.hidden = true;
  reloadUntil = 0;
  reloadSpan = RELOAD_S * 1000;
  firePending = false;
  firePendingUntil = 0;
  myShotCount = 0;
  shotCountReady = false;
  wave = { wave: 0, phase: 'break', left: 0, until: 0, best: 0 };
  expeditionBasePower = 1;
  bannerHideAt = 0;
  myEffects = 0;
  effectUntil.fill(0);
  royaleLoadout = { inventory: [], equipped: new Array<number>(MODULE_SLOT_COUNT).fill(0) };
  inventoryPanel.hidden = true;
  renderRoyaleLoadout();
  scene.clearBonuses();
  updateEffectsHud();
  updateHealthHud();
  updateDeathScreen();
  self.reset();
  expeditionPanel.hidden = true;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  localStorage.setItem('tanks:name', name);
  joinButton.disabled = true;
  setStatus('Подключение…');
  net.connect(name);
});

nameInput.value = localStorage.getItem('tanks:name') ?? '';
nameInput.focus();
updateHealthHud();

requestAnimationFrame((now) => {
  lastFrame = now;
  requestAnimationFrame(frame);
});
