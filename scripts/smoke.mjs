/**
 * Дымовой тест сервера: два игрока заходят, едут и должны увидеть друг друга.
 * Запуск (сервер должен быть уже поднят): npm run smoke
 *
 * Использует встроенный в Node 22+ WebSocket — отдельных зависимостей не нужно.
 */
const HTTP_URL = process.env.SMOKE_HTTP ?? 'http://127.0.0.1:8080';
const WS_URL = process.env.SMOKE_WS ?? 'ws://127.0.0.1:8080/ws';
const DURATION_MS = Number(process.argv[2] ?? 3000);
const SEND_INTERVAL_MS = 1000 / 30;

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
    let sender;

    const stop = setTimeout(() => {
      clearInterval(sender);
      ws.close();
      resolve({ name, id, sent, snapshots, ack, first, last, travelled });
    }, DURATION_MS);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'join', name }));
      sender = setInterval(() => {
        sent++;
        ws.send(JSON.stringify({ t: 'input', seq: sent, th: throttle, st: steer, tu: 0 }));
      }, SEND_INTERVAL_MS);
    });

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.t === 'welcome') id = msg.id;
      if (msg.t !== 'snapshot') return;
      snapshots++;
      ack = msg.ack;
      const me = msg.players.find((p) => p.i === id);
      if (!me) return;
      first ??= { x: me.x, z: me.z, a: me.a };
      if (last) travelled += Math.hypot(me.x - last.x, me.z - last.z);
      last = { x: me.x, z: me.z, a: me.a, speed: me.s, visible: msg.players.length };
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
      `доворот=${(p.last.a - p.first.a).toFixed(2)} рад видит=${p.last.visible} танков`,
  );
  checks.push([`${p.name}: сервер шлёт снапшоты`, p.snapshots > DURATION_MS / 100]);
  // Отставание ack от отправленного показывает, что сервер не успевает разгребать очередь.
  checks.push([`${p.name}: инпуты подтверждены`, p.sent - p.ack <= 3]);
  checks.push([`${p.name}: видит обоих игроков`, p.last.visible === 2]);
  // Путь, а не смещение: танк с рулём едет по кругу и возвращается почти в точку старта.
  checks.push([`${p.name}: танк проехал дистанцию`, p.travelled > 5]);
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
