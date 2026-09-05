import { DT, INTERP_DELAY_MS } from '../shared/constants.js';
import { clamp, lerpAngle } from '../shared/sim.js';
import type { ServerMessage } from '../shared/protocol.js';
import type { PlayerInfo, SnapshotEntry } from '../shared/types.js';

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

const scene = new Scene3D(canvas, el('labels'));
const controls = new Controls(canvas, el('stick'), el('stick-knob'));
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

      const input = self.step(controls.throttle, controls.steer, controls.yaw);
      if (input) net.sendInput(input);
    }
    if (steps === 5) stepAccumulator = 0;
  }

  self.decay(dt);

  drawSelf(dt);
  drawOthers(now - INTERP_DELAY_MS);
  scene.render();
  updateSpeed();
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
  selfId = 0;
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

requestAnimationFrame((now) => {
  lastFrame = now;
  requestAnimationFrame(frame);
});
