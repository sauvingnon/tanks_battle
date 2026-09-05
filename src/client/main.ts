import {
  DT,
  INTERP_DELAY_MS,
  MAX_HP,
  MUZZLE_OFFSET,
  RELOAD_S,
  RESPAWN_S,
} from '../shared/constants.js';
import { clamp, lerpAngle } from '../shared/sim.js';
import type { ServerMessage } from '../shared/protocol.js';
import {
  BOOM_HIT,
  BOOM_KILL,
  type Boom,
  type PlayerInfo,
  type SnapshotEntry,
  type SnapshotShell,
} from '../shared/types.js';

import { Controls } from './controls.js';
import { Net } from './net.js';
import { SelfPrediction } from './prediction.js';
import { Scene3D } from './render.js';

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
const controls = new Controls(canvas, el('stick'), el('stick-knob'), el('fire-button'));
controls.attach();

// --- Состояние мира на клиенте ---

let selfId = 0;
let worldBuilt = false;

const players = new Map<number, PlayerInfo>();

/** Свой танк: предсказание, реконсиляция и сглаживание живут в prediction.ts. */
const self = new SelfPrediction();

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

/** id снарядов, которые мы уже видели: по новым рисуем вспышку выстрела. */
const knownShells = new Set<number>();

/** Своя перезарядка считается локально — она нужна только для полоски в HUD. */
let reloadUntil = 0;
let myHp = MAX_HP;
let myDead = false;
let respawnAt = 0;

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
      if (!worldBuilt) {
        scene.buildWorld(msg.map.half, msg.map.obstacles);
        worldBuilt = true;
      }
      for (const info of msg.players) addPlayer(info);
      hideOverlay();
      break;
    }
    case 'joined':
      addPlayer(msg.player);
      break;
    case 'left':
      players.delete(msg.id);
      scene.removeTank(msg.id);
      updateHud();
      break;
    case 'snapshot':
      onSnapshot(msg.players, msg.ack, msg.shells ?? [], msg.booms ?? []);
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
  scene.addTank(info.id, info.name, info.color, info.id === selfId);
  updateHud();
}

function onSnapshot(
  entries: SnapshotEntry[],
  ack: number,
  shells: SnapshotShell[],
  booms: Boom[],
): void {
  const now = performance.now();
  const map = new Map<number, SnapshotEntry>();
  for (const entry of entries) map.set(entry.i, entry);
  snapshots.push({ time: now, entries: map, shells });

  // Взрывы показываем в тот же момент, в который до места дойдёт картинка мира.
  for (const boom of booms) pendingBooms.push({ at: now + INTERP_DELAY_MS, boom });

  const mine = map.get(selfId);
  if (!mine) return;

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
      if (wantFire) reloadUntil = now + RELOAD_S * 1000;

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
}

/** Взрывы, у которых подошло время. */
function playBooms(now: number): void {
  while (pendingBooms.length > 0 && pendingBooms[0].at <= now) {
    const { boom } = pendingBooms.shift()!;
    scene.boom(boom.x, boom.z, boom.k);
    // Отметка о попадании — только стрелявшему и только по живой цели.
    if (boom.o === selfId && (boom.k === BOOM_HIT || boom.k === BOOM_KILL)) showHitmarker();
  }
}

function drawSelf(dt: number): void {
  // alpha — доля времени до следующего шага симуляции: кадр рисуется между шагами,
  // иначе на скорости картинка идёт ступеньками по 30 Гц.
  const state = self.sample(stepAccumulator / DT);
  if (!state) return;

  scene.updateTank(selfId, state.x, state.z, state.angle, state.turret);
  scene.updateCamera(state.x, state.z, controls.yaw, controls.pitch, dt);
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
    scene.setTankHealth(id, target.h, target.d === 0);
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
      // Первый кадр снаряда: показываем вспышку у ствола стрелявшего.
      if (!knownShells.has(shell.i)) {
        knownShells.add(shell.i);
        if (shell.o !== selfId) {
          scene.muzzleFlash(
            shell.x - Math.sin(shell.a) * MUZZLE_OFFSET * 0.25,
            shell.z - Math.cos(shell.a) * MUZZLE_OFFSET * 0.25,
          );
        }
      }
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

function updateHud(): void {
  hudOnline.textContent = String(players.size);
}

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
  const line = document.createElement('div');
  line.className = 'kill-line';
  line.textContent = `${killer} 💥 ${victim}`;
  killFeed.prepend(line);
  while (killFeed.childElementCount > 4) killFeed.lastElementChild?.remove();
  window.setTimeout(() => line.remove(), 6000);
}

/** Кэш последних значений: писать в стиль каждый кадр — лишний пересчёт раскладки. */
let reloadShown = '';
let respawnShown = '';

function updateReloadHud(now: number): void {
  const left = reloadUntil - now;
  const ready = left <= 0;
  const width = ready ? '100%' : `${Math.round(100 - (left / (RELOAD_S * 1000)) * 100)}%`;
  if (width === reloadShown) return;
  reloadShown = width;
  hudReloadFill.style.width = width;
  hudReload.classList.toggle('is-ready', ready);
}

function updateDeathScreen(now = performance.now()): void {
  deathScreen.hidden = !myDead;
  if (!myDead) {
    respawnShown = '';
    return;
  }
  const left = String(Math.max(0, Math.ceil((respawnAt - now) / 1000)));
  if (left === respawnShown) return;
  respawnShown = left;
  deathTimer.textContent = left;
}

let speedTimer = 0;
function updateSpeed(): void {
  // Цифры обновляем 10 раз в секунду — иначе они мельтешат и грузят layout.
  const now = performance.now();
  if (now - speedTimer < 100) return;
  speedTimer = now;
  hudSpeed.textContent = String(Math.round(Math.abs(self.speed) * 3.6));
  hudPing.textContent = net.latency > 0 ? String(net.latency) : '—';
}

function setStatus(text: string, isError = false): void {
  status.textContent = text;
  status.classList.toggle('is-error', isError);
}

function hideOverlay(): void {
  overlay.classList.add('is-hidden');
  hud.hidden = false;
  crosshair.hidden = false;
  setStatus('');
  joinButton.disabled = false;

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
  joinButton.disabled = false;
  joinButton.textContent = 'Переподключиться';
  setStatus(message, isError);
}

function resetWorld(): void {
  for (const id of players.keys()) scene.removeTank(id);
  players.clear();
  snapshots.length = 0;
  pendingBooms.length = 0;
  knownShells.clear();
  scene.clearShells();
  selfId = 0;
  myHp = MAX_HP;
  myDead = false;
  reloadUntil = 0;
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
