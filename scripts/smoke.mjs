/**
 * Дымовой тест сервера: два игрока заходят, едут и должны увидеть друг друга.
 * Запуск (сервер должен быть уже поднят): npm run smoke
 *
 * Использует встроенный в Node 22+ WebSocket — отдельных зависимостей не нужно.
 *
 * Как читать вывод, чтобы не искать несуществующие баги:
 *
 * - `послано` заметно меньше, чем DURATION * 30. Это часы самого теста: setInterval
 *   в Node изрядно дрейфует и выдаёт ~22 срабатывания в секунду вместо 30. Сервер
 *   тут ни при чём — сверять надо `ack` с `послано`, а не с ожидаемым числом.
 * - `Тест-1` проезжает всего ~6.6 м. Он едет строго прямо от точки спавна (0, 60)
 *   и упирается в блок на z=48. Это работающие коллизии, а не застревание.
 */
const HTTP_URL = process.env.SMOKE_HTTP ?? 'http://127.0.0.1:8080';
const WS_URL = process.env.SMOKE_WS ?? 'ws://127.0.0.1:8080/ws';
const DURATION_MS = Number(process.argv[2] ?? 3000);
const SEND_INTERVAL_MS = 1000 / 30;
const TWO_PI = Math.PI * 2;
const F_SHELLS = 1 << 0;
const FULL_HP = 1000;

/** Декодируем только поля снапшота, которые проверяет smoke-тест. */
function decodeSnapshot(buf) {
  const view = new DataView(buf);
  let offset = 0;
  const flags = view.getUint8(offset);
  offset += 1;
  offset += 4; // tick
  const ack = view.getUint32(offset, true);
  offset += 4;
  const count = view.getUint16(offset, true);
  offset += 2;
  const players = [];
  for (let index = 0; index < count; index++) {
    const i = view.getUint32(offset, true);
    offset += 4;
    const x = view.getInt16(offset, true) / 10;
    offset += 2;
    const z = view.getInt16(offset, true) / 10;
    offset += 2;
    const a = (view.getUint16(offset, true) * TWO_PI) / 65536;
    offset += 2;
    offset += 2; // turret
    const s = view.getInt16(offset, true) / 100;
    offset += 2;
    const h = view.getUint16(offset, true) / 10;
    offset += 2;
    offset += 2 + 2 + 1 + 4; // max HP, effects, dead, score
    players.push({ i, x, z, a, s, h });
  }
  const shells = flags & F_SHELLS ? new Array(view.getUint16(offset, true)) : undefined;
  return { t: 'snapshot', ack, players, shells };
}

async function decodeServerMessage(data) {
  if (typeof data === 'string') return JSON.parse(data);
  if (data instanceof Blob) return decodeSnapshot(await data.arrayBuffer());
  if (data instanceof ArrayBuffer) return decodeSnapshot(data);
  if (ArrayBuffer.isView(data)) return decodeSnapshot(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

function drive(name, throttle, steer) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let id = 0;
    let sent = 0;
    let snapshots = 0;
    let ack = 0;
    let first = null;
    let last = null;
    let travelled = 0;
    let shellsSeen = 0;
    let sender;

    const stop = setTimeout(() => {
      clearInterval(sender);
      ws.close();
      resolve({ name, id, sent, snapshots, ack, first, last, travelled, shellsSeen });
    }, DURATION_MS);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'join', name }));
      sender = setInterval(() => {
        sent++;
        const msg = { t: 'input', seq: sent, th: throttle, st: steer, tu: 0 };
        // Раз в 60 инпутов жмём на спуск: перезарядка на сервере длиннее,
        // так что часть выстрелов законно не пройдёт — нам важен сам факт.
        if (sent % 60 === 10) msg.f = 1;
        ws.send(JSON.stringify(msg));
      }, SEND_INTERVAL_MS);
    });

    ws.addEventListener('message', async (event) => {
      const msg = await decodeServerMessage(event.data);
      if (!msg) return;
      if (msg.t === 'welcome') id = msg.id;
      if (msg.t !== 'snapshot') return;
      snapshots++;
      ack = msg.ack;
      if (msg.shells?.length) shellsSeen += msg.shells.length;
      const me = msg.players.find((p) => p.i === id);
      if (!me) return;
      first ??= { x: me.x, z: me.z, a: me.a };
      if (last) travelled += Math.hypot(me.x - last.x, me.z - last.z);
      last = { x: me.x, z: me.z, a: me.a, speed: me.s, hp: me.h, visible: msg.players.length };
    });

    ws.addEventListener('error', () => {
      clearTimeout(stop);
      clearInterval(sender);
      reject(new Error(`не удалось соединиться с ${WS_URL}`));
    });
  });
}

const health = await fetch(`${HTTP_URL}/health`).then((r) => r.json());
console.log('health:', health);

// Один едет прямо, второй едет и одновременно крутится на месте.
const [straight, turning] = await Promise.all([drive('Тест-1', 1, 0), drive('Тест-2', 1, 1)]);

const checks = [];
for (const p of [straight, turning]) {
  console.log(
    `${p.name}: id=${p.id} послано=${p.sent} снапшотов=${p.snapshots} ack=${p.ack} ` +
      `путь=${p.travelled.toFixed(2)} м скорость=${p.last.speed.toFixed(2)} м/с ` +
      `доворот=${(p.last.a - p.first.a).toFixed(2)} рад hp=${p.last.hp} ` +
      `видит=${p.last.visible} танков снарядов в кадрах=${p.shellsSeen}`,
  );
  checks.push([`${p.name}: сервер шлёт снапшоты`, p.snapshots > DURATION_MS / 100]);
  // Отставание ack от отправленного показывает, что сервер не успевает разгребать очередь.
  checks.push([`${p.name}: инпуты подтверждены`, p.sent - p.ack <= 3]);
  checks.push([`${p.name}: видит обоих игроков`, p.last.visible === 2]);
  // Путь, а не смещение: танк с рулём едет по кругу и возвращается почти в точку старта.
  checks.push([`${p.name}: танк проехал дистанцию`, p.travelled > 5]);
  checks.push([`${p.name}: сервер прислал полное здоровье`, p.last.hp === FULL_HP]);
  // Единственная проверка, что флаг огня доживает до сервера через JSON и nginx.
  checks.push([`${p.name}: выстрел долетел до сервера`, p.shellsSeen > 0]);
}
checks.push(['поворот корпуса работает', Math.abs(turning.last.a - turning.first.a) > 0.5]);
checks.push(['id игроков различаются', straight.id !== turning.id]);

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
}

console.log(failed === 0 ? 'SMOKE OK' : `SMOKE FAILED: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
