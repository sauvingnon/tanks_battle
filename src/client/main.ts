import { DT, INTERP_DELAY_MS } from '../shared/constants.js';
import { clamp, lerpAngle, stepTank, wrapAngle } from '../shared/sim.js';
import type { ServerMessage } from '../shared/protocol.js';
import type { Box, Input, PlayerInfo, SnapshotEntry, TankState } from '../shared/types.js';

import { Controls } from './controls.js';
import { Net } from './net.js';
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

const scene = new Scene3D(canvas, el('labels'));
const controls = new Controls(canvas, el('stick'), el('stick-knob'));
controls.attach();

// --- Состояние мира на клиенте ---

let selfId = 0;
let worldBuilt = false;
let obstacles: Box[] = [];

const players = new Map<number, PlayerInfo>();

/** Предсказанное состояние своего танка: им управляем локально, без ожидания сервера. */
let predicted: TankState | null = null;
/** Инпуты, ещё не подтверждённые сервером, — их переигрываем после каждого снапшота. */
const pending: Input[] = [];
let seq = 0;

/** Разница между предсказанием и поправкой сервера, гасится плавно, чтобы не было рывков. */
const visualError = { x: 0, z: 0, angle: 0 };
const MAX_VISUAL_ERROR = 4;

interface BufferedSnapshot {
  time: number;
  entries: Map<number, SnapshotEntry>;
}

/** Снапшоты храним, чтобы рисовать чужие танки с задержкой и интерполяцией. */
const snapshots: BufferedSnapshot[] = [];

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
      obstacles = msg.map.obstacles;
      if (!worldBuilt) {
        scene.buildWorld(msg.map.half, obstacles);
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
      onSnapshot(msg.players, msg.ack);
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

function onSnapshot(entries: SnapshotEntry[], ack: number): void {
  const map = new Map<number, SnapshotEntry>();
  for (const entry of entries) map.set(entry.i, entry);
  snapshots.push({ time: performance.now(), entries: map });

  const mine = map.get(selfId);
  if (!mine) return;

  if (!predicted) {
    // Первый снапшот: принимаем позицию сервера как есть и разворачиваем к ней камеру.
    predicted = { x: mine.x, z: mine.z, angle: mine.a, speed: mine.s, turret: mine.t };
    controls.yaw = mine.t;
    return;
  }

  const beforeX = predicted.x + visualError.x;
  const beforeZ = predicted.z + visualError.z;
  const beforeAngle = wrapAngle(predicted.angle + visualError.angle);

  // Сервер — источник истины: берём его состояние и переигрываем неподтверждённое.
  predicted.x = mine.x;
  predicted.z = mine.z;
  predicted.angle = mine.a;
  predicted.speed = mine.s;
  predicted.turret = mine.t;

  while (pending.length > 0 && pending[0].seq <= ack) pending.shift();
  for (const input of pending) stepTank(predicted, input, DT, obstacles);

  // Расхождение не выправляем мгновенно — гасим за пару кадров.
  const dx = beforeX - predicted.x;
  const dz = beforeZ - predicted.z;
  if (Math.hypot(dx, dz) > MAX_VISUAL_ERROR) {
    visualError.x = 0;
    visualError.z = 0;
    visualError.angle = 0;
  } else {
    visualError.x = dx;
    visualError.z = dz;
    visualError.angle = wrapAngle(beforeAngle - predicted.angle);
  }
}

// --- Игровой цикл ---

let lastFrame = performance.now();
let stepAccumulator = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastFrame) / 1000, 0.25);
  lastFrame = now;

  controls.update();

  if (predicted) {
    stepAccumulator += dt;
    let steps = 0;
    // Фиксированный шаг: тот же DT, что и на сервере, иначе предсказание разъедется.
    while (stepAccumulator >= DT && steps < 5) {
      stepAccumulator -= DT;
      steps++;

      const input: Input = {
        seq: ++seq,
        throttle: controls.throttle,
        steer: controls.steer,
        turret: controls.yaw,
      };
      pending.push(input);
      stepTank(predicted, input, DT, obstacles);
      net.sendInput(input);
    }
    if (steps === 5) stepAccumulator = 0;
    // Страховка от бесконечного роста, если ack почему-то не приходит.
    if (pending.length > 180) pending.splice(0, pending.length - 180);
  }

  const decay = Math.exp(-dt * 9);
  visualError.x *= decay;
  visualError.z *= decay;
  visualError.angle *= decay;

  drawSelf(dt);
  drawOthers(now - INTERP_DELAY_MS);
  scene.render();
  updateSpeed();
}

function drawSelf(dt: number): void {
  if (!predicted) return;
  const x = predicted.x + visualError.x;
  const z = predicted.z + visualError.z;
  const angle = wrapAngle(predicted.angle + visualError.angle);
  scene.updateTank(selfId, x, z, angle, predicted.turret);
  scene.updateCamera(x, z, controls.yaw, controls.pitch, dt);
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
    if (id === selfId) continue;
    if (!players.has(id)) continue; // снапшот обогнал сообщение joined
    const start = from.entries.get(id) ?? target;
    scene.updateTank(
      id,
      start.x + (target.x - start.x) * t,
      start.z + (target.z - start.z) * t,
      lerpAngle(start.a, target.a, t),
      lerpAngle(start.t, target.t, t),
    );
  }
}

// --- Интерфейс ---

const hudOnline = el('hud-online');
const hudPing = el('hud-ping');
const hudSpeed = el('hud-speed');

function updateHud(): void {
  hudOnline.textContent = String(players.size);
}

let speedTimer = 0;
function updateSpeed(): void {
  // Цифры обновляем 10 раз в секунду — иначе они мельтешат и грузят layout.
  const now = performance.now();
  if (now - speedTimer < 100) return;
  speedTimer = now;
  hudSpeed.textContent = predicted ? String(Math.round(Math.abs(predicted.speed) * 3.6)) : '0';
  hudPing.textContent = net.latency > 0 ? String(net.latency) : '—';
}

function setStatus(text: string, isError = false): void {
  status.textContent = text;
  status.classList.toggle('is-error', isError);
}

function hideOverlay(): void {
  overlay.classList.add('is-hidden');
  hud.hidden = false;
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
  pending.length = 0;
  predicted = null;
  seq = 0;
  selfId = 0;
  visualError.x = 0;
  visualError.z = 0;
  visualError.angle = 0;
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

requestAnimationFrame((now) => {
  lastFrame = now;
  requestAnimationFrame(frame);
});
