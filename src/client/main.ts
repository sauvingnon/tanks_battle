import {
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
  DIFFICULTY_NAMES,
  DT,
  hasEffect,
  INTERP_DELAY_MS,
  BOT_HP,
  MAX_HP,
  STANCE_NAMES,
  STANCE_NEUTRAL,
  MODE_DM,
  MODE_PVE,
  MUZZLE_OFFSET,
  RELOAD_S,
  RESPAWN_S,
  SHELL_HEIGHT,
  type GameMode,
} from '../shared/constants.js';
import { coverBoxes, MAP_NAMES } from '../shared/map.js';
import { clamp, lerpAngle, sweepShell } from '../shared/sim.js';
import type { RoomConfig, ServerMessage, WaveState } from '../shared/protocol.js';
import {
  BOOM_GROUND,
  BOOM_HIT,
  BOOM_KILL,
  BOOM_RICOCHET,
  type Boom,
  type BoomKind,
  type Box,
  type PlayerInfo,
  type ShellState,
  type SnapshotBonus,
  type SnapshotEntry,
  type SnapshotShell,
} from '../shared/types.js';

import { Controls } from './controls.js';
import { Net } from './net.js';
import { SelfPrediction } from './prediction.js';
import { BONUS_COLORS, Scene3D } from './render.js';

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Нет элемента #${id}`);
  return node as T;
};

const canvas = el<HTMLCanvasElement>('scene');
const overlay = el('overlay');
const form = el<HTMLFormElement>('join-form');
const nameInput = el<HTMLInputElement>('name-input');
const joinButton = el<HTMLButtonElement>('join-button');
const status = el('status');
const hud = el('hud');
const hint = el('hint');
const touchLayer = el('touch');
const crosshair = el('crosshair');

const scene = new Scene3D(canvas, el('labels'));
const controls = new Controls(
  canvas,
  el('stick'),
  el('stick-knob'),
  el('fire-button'),
  el('aim'),
  el('aim-knob'),
);
controls.attach();

// --- Состояние мира на клиенте ---

let selfId = 0;
let worldBuilt = false;

const players = new Map<number, PlayerInfo>();

/** Свой танк: предсказание, реконсиляция и сглаживание живут в prediction.ts. */
const self = new SelfPrediction();
/** Блоки, которые держат снаряд: нужны метке прицела. Пересобираются со сменой карты. */
let cover: Box[] = [];

interface BufferedSnapshot {
  time: number;
  entries: Map<number, SnapshotEntry>;
  shells: SnapshotShell[];
}

/** Снапшоты храним, чтобы рисовать чужие танки с задержкой и интерполяцией. */
const snapshots: BufferedSnapshot[] = [];

/**
 * Взрывы ждут своей очереди столько же, сколько чужие танки: иначе вспышка
 * появлялась бы на 100 мс раньше, чем танк доедет до места попадания.
 */
const pendingBooms: Array<{ at: number; boom: Boom }> = [];

/**
 * Подбитые, которых сервер уже удалил из комнаты. Ждут той же задержки, что и
 * взрывы: сообщение о гибели приходит на 100 мс раньше, чем картинка мира до
 * этого момента доедет, и без очереди бот загорался бы до попадания по нему.
 */
const pendingWrecks: Array<{ at: number; id: number }> = [];

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

/** Своя перезарядка считается локально — она нужна только для полоски в HUD. */
let reloadUntil = 0;
/** Длина текущего отката, мс: с бонусом «Заряжание» он короче. */
let reloadSpan = RELOAD_S * 1000;
let myHp = MAX_HP;
let myDead = false;
let respawnAt = 0;

// --- Режим комнаты ---

let mapId = 0;
let mode: GameMode = MODE_DM;
/** Выбор хоста. */
let difficulty = 1;
/** Сложность, по которой идёт бой сейчас: посреди волны отстаёт от выбранной. */
let activeDifficulty = 1;
let stance = STANCE_NEUTRAL;
let bonusesOn = false;
let hostId = 0;
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
      self.obstacles = msg.map.obstacles;
      cover = coverBoxes(msg.map.obstacles);
      if (!worldBuilt) {
        scene.buildWorld(msg.map.half, msg.map.obstacles);
        worldBuilt = true;
      }
      for (const info of msg.players) addPlayer(info);
      applyWave(msg.wave);
      applyConfig(msg);
      hideOverlay();
      break;
    }
    case 'map':
      // Карту строит сервер, клиент только пересобирает по ней сцену и свои
      // препятствия для предсказания.
      self.obstacles = msg.obstacles;
      cover = coverBoxes(msg.obstacles);
      scene.buildWorld(msg.half, msg.obstacles);
      worldBuilt = true;
      break;
    case 'joined':
      addPlayer(msg.player);
      break;
    case 'left':
      players.delete(msg.id);
      // Подбитый уходит со сцены не сразу: он ещё должен догореть, и попасть в
      // тот же момент, что и его взрыв, — иначе остов вспыхивает раньше выстрела.
      if (msg.killed) pendingWrecks.push({ at: performance.now() + INTERP_DELAY_MS, id: msg.id });
      else scene.removeTank(msg.id);
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
      onSnapshot(msg.players, msg.ack, msg.shells ?? [], msg.booms ?? [], msg.bonuses ?? []);
      break;
    case 'kill':
      pushKillFeed(msg.killer, msg.victim);
      break;
    case 'error':
      showOverlay(msg.message, true);
      break;
  }
}

function addPlayer(info: PlayerInfo): void {
  players.set(info.id, info);
  scene.addTank(info.id, info.name, info.color, info.id === selfId, info.bot === 1);
  updateHud();
}

function applyConfig(next: RoomConfig): void {
  const first = !configKnown;
  const wasMode = mode;
  const wasDifficulty = difficulty;
  const wasBonuses = bonusesOn;
  const wasStance = stance;

  const wasMap = mapId;

  configKnown = true;
  mapId = next.mapId;
  mode = next.mode;
  difficulty = next.difficulty;
  activeDifficulty = next.active;
  bonusesOn = next.bonuses;
  stance = next.stance;
  hostId = next.hostId;

  if (!bonusesOn) {
    effectUntil.fill(0);
    scene.clearBonuses();
  }
  // Смена режима перезапускает мир на сервере — старую плашку волны держать незачем.
  if (mode !== wasMode) bannerHideAt = 0;

  // О смене настроек говорим всем в ленте: панель открыта не у каждого, а знать,
  // что именно поменялось и когда это сработает, надо обоим.
  if (!first) {
    if (mapId !== wasMap) {
      pushFeed(`Карта: ${MAP_NAMES[mapId]} · бой начат заново`, 'is-setup');
    }
    if (mode !== wasMode) {
      pushFeed(`Режим: ${MODE_NAMES[mode]} · бой начат заново`, 'is-setup');
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
  }

  renderSetup();
  updateModeChip();
}

/** Когда выбранная сложность вступит в силу. Сервер меняет её на границе волн. */
function whenDifficulty(): string {
  if (mode !== MODE_PVE) return 'вступит в силу в режиме «Против ботов»';
  if (wave.phase !== 'fight') return 'с ближайшей волны';
  return `с волны ${wave.wave + 1}`;
}

function applyWave(next: WaveState): void {
  // Плашку показываем только на смене волны: во время боя сообщение приходит
  // на каждого вышедшего бота, и она мигала бы весь бой.
  const started = next.phase === 'fight' && next.wave !== wave.wave;
  wave = next;
  waveUntilAt = performance.now() + next.until * 1000;
  if (started) bannerHideAt = performance.now() + 3000;
  updateModeChip();
  // В подписи настроек стоит номер следующей волны — он только что изменился.
  if (!setupPanel.hidden) renderSetup();
}

function onSnapshot(
  entries: SnapshotEntry[],
  ack: number,
  shells: SnapshotShell[],
  booms: Boom[],
  bonuses: SnapshotBonus[],
): void {
  const now = performance.now();
  // Ящики стоят на месте, интерполировать нечего — ставим их сразу.
  scene.syncBonuses(bonuses);
  const map = new Map<number, SnapshotEntry>();
  for (const entry of entries) map.set(entry.i, entry);
  snapshots.push({ time: now, entries: map, shells });

  // Взрывы показываем в тот же момент, в который до места дойдёт картинка мира.
  for (const boom of booms) pendingBooms.push({ at: now + INTERP_DELAY_MS, boom });

  const mine = map.get(selfId);
  if (!mine) return;

  // Эффекты сервер шлёт маской. «Ход» обязан попасть в предсказание тем же
  // множителем, что и на сервере, иначе своя же машина поедет мимо реконсиляции.
  const mask = mine.f ?? 0;
  if (mask !== myEffects) {
    myEffects = mask;
    self.boost = hasEffect(mask, BONUS_SPEED) ? BONUS_SPEED_MUL : 1;
    updateEffectsHud();
  }

  if (mine.h !== myHp) {
    if (mine.h < myHp) flashDamage();
    myHp = mine.h;
    updateHealthHud();
  }
  if (Boolean(mine.d) !== myDead) {
    myDead = Boolean(mine.d);
    self.alive = !myDead;
    if (myDead) respawnAt = now + RESPAWN_S * 1000;
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

  if (self.ready) {
    stepAccumulator += dt;
    let steps = 0;
    // Фиксированный шаг: тот же DT, что и на сервере, иначе предсказание разъедется.
    while (stepAccumulator >= DT && steps < 5) {
      stepAccumulator -= DT;
      steps++;

      // Перезарядку считает сервер; локальный таймер нужен, чтобы полоска в HUD
      // не дёргалась и чтобы не спамить в сеть заведомо холостыми выстрелами.
      const wantFire = controls.fire && !myDead && now >= reloadUntil;
      if (wantFire) {
        // Бонус «Заряжание» укорачивает откат — полоска должна знать об этом,
        // иначе она поедет вдвое медленнее, чем пушка на самом деле готова.
        reloadSpan = RELOAD_S * 1000 * (hasEffect(myEffects, BONUS_RELOAD) ? BONUS_RELOAD_MUL : 1);
        reloadUntil = now + reloadSpan;
        // Свой выстрел показываем сразу, не дожидаясь снапшота: та же перезарядка
        // считается и на сервере, так что отказать он может только в спорный тик.
        scene.tankFired(selfId);
        scene.addShake(SELF_SHOT_SHAKE);
      }

      const input = self.step(controls.throttle, controls.steer, controls.yaw, wantFire);
      if (input) net.sendInput(input);
    }
    if (steps === 5) stepAccumulator = 0;
  }

  self.decay(dt);

  drawSelf(dt);
  drawOthers(now - INTERP_DELAY_MS);
  playBooms(now);
  scene.render(dt);
  updateSpeed();
  updateReloadHud(now);
  updateDeathScreen(now);
  updateBanner(now);
}

/** Взрывы и остовы, у которых подошло время. */
function playBooms(now: number): void {
  while (pendingWrecks.length > 0 && pendingWrecks[0].at <= now) {
    scene.removeTank(pendingWrecks.shift()!.id, true);
  }
  while (pendingBooms.length > 0 && pendingBooms[0].at <= now) {
    const { boom } = pendingBooms.shift()!;
    scene.boom(boom.x, boom.z, boom.k);

    const distance = Math.hypot(boom.x - selfX, boom.z - selfZ);
    const near = 1 - distance / SHAKE_RANGE;
    if (near > 0) scene.addShake(BOOM_SHAKE[boom.k] * near);

    // Отметка о попадании — только стрелявшему и только по живой цели.
    if (boom.o === selfId && (boom.k === BOOM_HIT || boom.k === BOOM_KILL)) showHitmarker();
  }
}

function drawSelf(dt: number): void {
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
  if (topView) scene.updateTopCamera(state.x, state.z, controls.distance, dt);
  else scene.updateCamera(state.x, state.z, controls.yaw, controls.pitch, dt, controls.distance);
  drawAim(state.x, state.z, state.turret);
}

/** Своё последнее нарисованное положение: по нему считается дальность маскировки. */
let selfX = 0;
let selfZ = 0;

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
  const wall = sweepShell(probe, 1, cover);
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
  // Выбрасываем снапшоты, которые уже не нужны для интерполяции.
  while (snapshots.length > 2 && snapshots[1].time <= renderTime) snapshots.shift();
  if (snapshots.length === 0) return;

  let index = snapshots.length - 1;
  while (index > 0 && snapshots[index].time > renderTime) index--;

  const from = snapshots[index];
  const to = snapshots[index + 1] ?? from;
  const span = to.time - from.time;
  const t = span > 1e-3 ? clamp((renderTime - from.time) / span, 0, 1) : 1;

  for (const [id, target] of to.entries) {
    if (!players.has(id)) continue; // снапшот обогнал сообщение joined
    // Здоровье и «жив ли» берём и для себя тоже: свой танк рисуется предсказанием,
    // но его полоска и видимость живут по тем же данным, что и у остальных.
    scene.setTankHealth(id, target.h, target.d === 0, players.get(id)?.bot ? BOT_HP : MAX_HP);
    // Свой танк под маскировкой видно всегда: прятать его от себя незачем.
    scene.setTankStealth(
      id,
      id !== selfId &&
        hasEffect(target.f ?? 0, BONUS_STEALTH) &&
        Math.hypot(target.x - selfX, target.z - selfZ) > BONUS_STEALTH_RANGE,
    );
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

/**
 * Снаряды интерполируются вместе с танками — тем же t по тем же снапшотам,
 * иначе снаряд и цель жили бы в разных моментах времени.
 */
function drawShells(from: BufferedSnapshot, to: BufferedSnapshot, t: number): void {
  const previous = new Map<number, SnapshotShell>();
  for (const shell of from.shells) previous.set(shell.i, shell);

  const list = to.shells.map((shell) => {
    const start = previous.get(shell.i);
    if (!start) {
      // Первый кадр снаряда: показываем выстрел у ствола стрелявшего. Свой уже
      // отыгран в момент нажатия — второй раз его рисовать нечего.
      if (!knownShells.has(shell.i)) {
        knownShells.add(shell.i);
        // Танк стрелявшего мог ещё не доехать сообщением joined; тогда остаётся
        // вспышка по координатам снаряда, отмотанным назад к дульному срезу.
        if (shell.o !== selfId && !scene.tankFired(shell.o)) {
          scene.muzzleFlash(
            shell.x - Math.sin(shell.a) * MUZZLE_OFFSET * 0.25,
            shell.z - Math.cos(shell.a) * MUZZLE_OFFSET * 0.25,
            shell.a,
          );
        }
      }
      return { id: shell.i, x: shell.x, z: shell.z, angle: shell.a };
    }
    // Между снапшотами был отскок: прямая от старой точки к новой срезала бы угол,
    // и снаряд на кадр-другой ушёл бы в стену. Показываем сразу новое положение.
    if (start.b !== shell.b) {
      return { id: shell.i, x: shell.x, z: shell.z, angle: shell.a };
    }
    return {
      id: shell.i,
      x: start.x + (shell.x - start.x) * t,
      z: start.z + (shell.z - start.z) * t,
      angle: shell.a,
    };
  });

  scene.syncShells(list);
  // Множество id могло бы расти вечно — чистим, когда снарядов в мире нет.
  if (list.length === 0 && knownShells.size > 0) knownShells.clear();
}

// --- Интерфейс ---

const hudOnline = el('hud-online');
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
const hudMode = el('hud-mode');
const hudFx = el('hud-fx');
const banner = el('wave-banner');
const bannerTitle = el('wave-title');
const bannerSub = el('wave-sub');
const setupPanel = el('setup');
const setupToggle = el<HTMLButtonElement>('setup-toggle');
const setupOwner = el('setup-owner');
const setupMaps = el('setup-maps');
const setupModes = el('setup-modes');
const setupDiffs = el('setup-diffs');
const setupStances = el('setup-stances');
const setupBonuses = el<HTMLInputElement>('setup-bonuses');
const setupBloom = el<HTMLInputElement>('setup-bloom');
const setupTop = el<HTMLInputElement>('setup-top');
const hintChase = el('hint-chase');
const hintTopView = el('hint-top');
const aimStick = el('aim');
const hintMap = el('hint-map');
const hintMode = el('hint-mode');
const hintDiff = el('hint-diff');
const hintStance = el('hint-stance');
const hintBonuses = el('hint-bonuses');
const hintBloom = el('hint-bloom');
const hintView = el('hint-view');

function updateHud(): void {
  // Ботов в «в бою» не считаем: это счётчик живых людей.
  let humans = 0;
  for (const info of players.values()) if (info.bot !== 1) humans++;
  hudOnline.textContent = String(humans);
}

// --- Волны ---

function updateModeChip(): void {
  const map = MAP_NAMES[mapId] ?? '';
  if (mode === MODE_DM) {
    hudMode.textContent = `${map} · все против всех`;
    return;
  }
  if (wave.phase === 'fight') {
    hudMode.textContent = `${map} · волна ${wave.wave} · осталось ${wave.left}`;
    return;
  }
  hudMode.textContent = `${map} · ${wave.phase === 'break' ? 'передышка' : 'забег окончен'}`;
}

/** Кэш последней надписи: плашка обновляется каждый кадр, а меняется раз в секунду. */
let bannerShown = '';

function updateBanner(now: number): void {
  const visible =
    mode === MODE_PVE && wave.wave > 0 && (wave.phase !== 'fight' || now < bannerHideAt);
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
  } else if (wave.phase === 'break') {
    title = `Волна ${wave.wave} зачищена`;
    sub = `следующая через ${left} · павшие возвращаются в строй`;
  } else {
    title = 'Забег окончен';
    sub = `дошли до волны ${wave.wave} · рекорд ${wave.best} · заново через ${left}`;
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
] as Array<[GameMode, string]>) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.mode = value;
  button.addEventListener('click', () => net.sendSetup({ mode: value }));
  setupModes.appendChild(button);
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
 * Вид сверху — тоже личная настройка, и в сеть она не уходит: сервер шлёт всем
 * одни и те же снапшоты, а во что их превращать, каждый решает сам. Поэтому в
 * одной комнате спокойно уживаются телефон с видом сверху и ПК с видом сзади.
 *
 * На тач-устройстве он стоит по умолчанию: обзор пальцем в трёх измерениях на
 * телефоне — это отдельная работа, за которую платят снятой рукой с руля.
 */
let topView =
  (localStorage.getItem('tanks:view') ?? (controls.isTouch ? 'top' : 'chase')) === 'top';
applyView();

function applyView(): void {
  controls.setTopView(topView);
  scene.setTopView(topView);
  aimStick.hidden = !topView;
  hintChase.hidden = topView;
  hintTopView.hidden = !topView;
}

function setTopView(on: boolean): void {
  if (on === topView) return;
  topView = on;
  localStorage.setItem('tanks:view', on ? 'top' : 'chase');
  applyView();
  renderSetup();
}

setupTop.addEventListener('change', () => setTopView(setupTop.checked));

function renderSetup(): void {
  const isHost = selfId !== 0 && selfId === hostId;
  const host = players.get(hostId);
  setupOwner.textContent = isHost ? 'настраиваешь ты' : host ? `настраивает ${host.name}` : '';

  setupBonuses.checked = bonusesOn;
  setupBonuses.disabled = !isHost;

  // Две галки в панели, которые работают у всех: они не про бой.
  setupTop.checked = topView;
  hintView.textContent = topView
    ? controls.isTouch
      ? 'Карта под тобой, север сверху. Левый палец — ход, правый — башня; уведи его дальше от центра, и танк стреляет.'
      : 'Карта под тобой, север сверху. Курсор наводит башню, мышь не захватывается.'
    : 'Выключено: камера за танком. На телефоне обзор придётся крутить пальцем — тем же, которым стреляешь.';

  setupBloom.checked = bloomOn;
  hintBloom.textContent = bloomOn
    ? 'Трассеры, вспышки и взрывы разгораются. Если кадры проседают — сними.'
    : 'Выключено: кадр рисуется одним проходом, без размытия по всему экрану.';

  for (const button of setupMaps.querySelectorAll('button')) {
    button.classList.toggle('is-on', Number(button.dataset.map) === mapId);
    button.disabled = !isHost;
  }
  for (const button of setupModes.querySelectorAll('button')) {
    button.classList.toggle('is-on', button.dataset.mode === mode);
    button.disabled = !isHost;
  }
  const pending = mode === MODE_PVE && activeDifficulty !== difficulty;
  for (const button of setupDiffs.querySelectorAll('button')) {
    const tier = Number(button.dataset.diff);
    button.classList.toggle('is-on', tier === difficulty);
    // Пока выбор не вступил в силу, отдельно помечаем то, по чему идёт бой.
    button.classList.toggle('is-live', pending && tier === activeDifficulty);
    // Сложность имеет смысл только в режиме ботов.
    button.disabled = !isHost || mode !== MODE_PVE;
  }

  for (const button of setupStances.querySelectorAll('button')) {
    button.classList.toggle('is-on', Number(button.dataset.stance) === stance);
    button.disabled = !isHost;
  }
  hintStance.textContent = STANCE_HINTS[stance];

  // Главное, чего не хватало: когда настройка сработает.
  hintMap.textContent = MAP_HINTS[mapId];
  hintMode.textContent = 'Срабатывает сразу: бой начинается заново, счёт обнуляется.';
  hintBonuses.textContent = bonusesOn
    ? 'Срабатывает сразу: выключение уберёт ящики и снимет действующие усиления.'
    : 'Срабатывает сразу: ящики начнут появляться на карте.';

  if (mode !== MODE_PVE) {
    hintDiff.textContent = 'Работает только в режиме «Против ботов».';
  } else if (pending) {
    hintDiff.textContent =
      `Сейчас в бою: ${DIFFICULTY_NAMES[activeDifficulty]}. ` +
      `Выбранная включится ${whenDifficulty()} — вышедшие боты не переучиваются.`;
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

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return;
  if (hud.hidden) return; // до входа в бой настраивать нечего
  if (event.code === 'KeyM') toggleSetup();
  else if (event.code === 'KeyV') setTopView(!topView);
});

function updateHealthHud(): void {
  const fraction = clamp(myHp / MAX_HP, 0, 1);
  hudHpFill.style.width = `${(fraction * 100).toFixed(0)}%`;
  hudHpFill.style.background = `hsl(${Math.round(fraction * 105)} 70% 48%)`;
  hudHpValue.textContent = String(myHp);
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

/** Чипы действующих эффектов; «Ремонт» мгновенный, поэтому чипа у него нет. */
const TIMED_BONUSES = [BONUS_DAMAGE, BONUS_RELOAD, BONUS_SPEED, BONUS_STEALTH];
const fxChips = new Map<number, HTMLElement>();

for (const kind of TIMED_BONUSES) {
  const chip = document.createElement('span');
  chip.className = 'hud-chip fx-chip';
  chip.style.setProperty('--fx', `#${BONUS_COLORS[kind].toString(16).padStart(6, '0')}`);
  chip.hidden = true;
  hudFx.appendChild(chip);
  fxChips.set(kind, chip);
}

function onPickup(id: number, kind: number): void {
  const who = players.get(id);
  pushFeed(`${who?.name ?? 'Кто-то'} ⚡ ${BONUS_NAMES[kind]}`, 'is-bonus');
  if (id !== selfId) return;

  // Секунды считаем сами: сервер шлёт только факт «эффект висит», а длительность
  // и так известна обеим сторонам. Если маска погаснет раньше — чип уйдёт с ней.
  if (kind !== BONUS_HEAL) {
    effectUntil[kind] = performance.now() + BONUS_DURATION_S[kind] * 1000;
  }
  updateEffectsHud();
}

function updateEffectsHud(now = performance.now()): void {
  for (const kind of TIMED_BONUSES) {
    const chip = fxChips.get(kind)!;
    const on = hasEffect(myEffects, kind);
    chip.hidden = !on;
    if (!on) continue;
    const left = Math.max(0, Math.ceil((effectUntil[kind] - now) / 1000));
    const text = `${BONUS_NAMES[kind]} ${left}`;
    if (chip.textContent !== text) chip.textContent = text;
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
  const show = myDead && !(mode === MODE_PVE && wave.phase === 'over');
  deathScreen.hidden = !show;
  if (!show) {
    respawnShown = '';
    return;
  }

  // В режиме ботов жизнь одна на волну, поэтому обратного отсчёта нет.
  const byWave = mode === MODE_PVE;
  deathRespawn.hidden = byWave;
  deathNote.hidden = !byWave;

  const text = byWave
    ? wave.phase === 'break'
      ? 'В строю со следующей волной'
      : 'В строю, когда волна будет зачищена'
    : String(Math.max(0, Math.ceil((respawnAt - now) / 1000)));

  if (text === respawnShown) return;
  respawnShown = text;
  if (byWave) deathNote.textContent = text;
  else deathTimer.textContent = text;
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
  // Прицел покажется сам, как только появится своё состояние: его место
  // считается от ствола, а не от центра экрана.
  setupToggle.hidden = false;
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
  crosshair.hidden = true;
  hint.hidden = true;
  touchLayer.hidden = true;
  setupToggle.hidden = true;
  setupPanel.hidden = true;
  banner.hidden = true;
  joinButton.disabled = false;
  joinButton.textContent = 'Переподключиться';
  setStatus(message, isError);
}

function resetWorld(): void {
  // Именно clearTanks, а не обход players: догорающие остовы из комнаты уже вышли.
  scene.clearTanks();
  players.clear();
  snapshots.length = 0;
  pendingBooms.length = 0;
  pendingWrecks.length = 0;
  knownShells.clear();
  scene.clearShells();
  selfId = 0;
  hostId = 0;
  configKnown = false;
  // Пока нас не было, хост мог сменить карту — на переподключении собираем мир заново.
  worldBuilt = false;
  myHp = MAX_HP;
  myDead = false;
  reloadUntil = 0;
  wave = { wave: 0, phase: 'break', left: 0, until: 0, best: 0 };
  bannerHideAt = 0;
  myEffects = 0;
  effectUntil.fill(0);
  scene.clearBonuses();
  updateEffectsHud();
  updateHealthHud();
  updateDeathScreen();
  self.reset();
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
