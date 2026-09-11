import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

import { DT, MODE_ROYALE, SNAPSHOT_EVERY, TICK_HZ, isMode, isRuleset } from '../shared/constants.js';
import {
  decode,
  encode,
  encodeSnapshot,
  type ClientMessage,
  type ServerMessage,
  type SnapshotPayload,
} from '../shared/protocol.js';
import * as leaderboard from './leaderboard.js';
import { Room, type Player, type TeamRoundResult } from './room.js';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS ?? 32);

/** Статика отдаётся только при локальном запуске; в проде этим занимается nginx. */
const STATIC_DIR = resolve(fileURLToPath(new URL('../../dist', import.meta.url)));
const SERVE_STATIC = existsSync(STATIC_DIR);

// Комната сама рассылает то, что рождается внутри неё: появление и гибель ботов,
// смену волны, смену настроек. Ботам слать нечего — у них нет сокета.
const room = new Room((msg) => broadcast(msg));

// --- HTTP ---

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        players: room.humanCount,
        bots: room.botCount,
        mode: room.mode,
        tick: room.tickCount,
      }),
    );
    return;
  }
  if (SERVE_STATIC) {
    serveStatic(req, res);
    return;
  }
  res.writeHead(404).end('not found');
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  // normalize + проверка префикса — чтобы ../.. не вывел за пределы dist.
  let filePath = join(STATIC_DIR, normalize(urlPath));
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(STATIC_DIR, 'index.html');
  }
  if (!existsSync(filePath)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
}

// --- WebSocket ---

const wss = new WebSocketServer({ noServer: true });

http.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '').split('?')[0];
  if (path !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

interface Session {
  player: Player | null;
  alive: boolean;
}

const sessions = new WeakMap<WebSocket, Session>();

wss.on('connection', (ws) => {
  const session: Session = { player: null, alive: true };
  sessions.set(ws, session);

  ws.on('pong', () => {
    session.alive = true;
  });

  ws.on('message', (raw) => {
    const msg = decode<ClientMessage>(raw.toString());
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'join') {
      if (session.player) return; // повторный join игнорируем
      if (room.humanCount >= MAX_PLAYERS) {
        send(ws, { t: 'error', message: 'Комната заполнена, попробуй позже' });
        ws.close();
        return;
      }
      const player = room.add(msg.name, (data) => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      });
      session.player = player;

      send(ws, {
        t: 'welcome',
        id: player.id,
        you: room.info(player),
        tickHz: TICK_HZ,
        map: { half: room.half, obstacles: room.obstacles },
        players: room.allInfo(),
        ...room.config(),
        wave: room.waveState(),
        leaderboard: leaderboard.top(),
      });
      broadcastExcept(player.id, { t: 'joined', player: room.info(player) });
      console.log(`[+] ${player.name} (#${player.id}), онлайн: ${room.humanCount}`);
      return;
    }

    if (msg.t === 'setup') {
      // Настраивает только хост: иначе любой мог бы переключить режим посреди боя.
      if (!session.player || session.player.id !== room.hostId) return;
      room.setup(
        isMode(msg.mode) ? msg.mode : undefined,
        msg.diff,
        typeof msg.bonuses === 'boolean' ? msg.bonuses : undefined,
        msg.map,
        msg.stance,
        isRuleset(msg.rules) ? msg.rules : undefined,
        msg.teamSize,
        msg.royaleSquadSize,
      );
      return;
    }

    if (msg.t === 'upgrade') {
      if (!session.player || !Number.isInteger(msg.id)) return;
      room.chooseUpgrade(msg.id);
      return;
    }

    if (msg.t === 'input') {
      const player = session.player;
      if (!player) return;
      if (!isFiniteNumber(msg.seq) || !isFiniteNumber(msg.th) || !isFiniteNumber(msg.st) || !isFiniteNumber(msg.tu)) return;
      room.pushInput(player, {
        seq: msg.seq | 0,
        throttle: msg.th,
        steer: msg.st,
        turret: msg.tu,
        fire: msg.f === 1,
      });
      return;
    }

    if (msg.t === 'ping') {
      send(ws, { t: 'pong', id: msg.id });
    }
  });

  ws.on('close', () => {
    const player = session.player;
    if (!player) return;
    room.remove(player.id);
    broadcastExcept(player.id, { t: 'left', id: player.id });
    console.log(`[-] ${player.name} (#${player.id}), онлайн: ${room.humanCount}`);
  });

  ws.on('error', () => ws.terminate());
});

/** Отсекаем «мёртвые» соединения, которые не закрылись штатно. */
setInterval(() => {
  for (const ws of wss.clients) {
    const session = sessions.get(ws);
    if (!session) continue;
    if (!session.alive) {
      ws.terminate();
      continue;
    }
    session.alive = false;
    ws.ping();
  }
}, 20_000);

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(encode(msg));
}

function broadcast(msg: ServerMessage): void {
  const data = encode(msg);
  for (const player of room.players.values()) {
    if (player.brain) continue; // бот в сети не сидит
    player.send(data);
  }
}

function broadcastExcept(exceptId: number, msg: ServerMessage): void {
  const data = encode(msg);
  for (const player of room.players.values()) {
    if (player.brain || player.id === exceptId) continue;
    player.send(data);
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Раунд командного боя закончился — пишем исход в доску лидеров и рассылаем новый топ. */
function applyTeamResult(result: TeamRoundResult): void {
  leaderboard.recordRound(
    result.entries.map((entry) => ({
      name: entry.name,
      kills: entry.kills,
      result: result.winner === 'draw' ? 'draw' : entry.team === result.winner ? 'win' : 'loss',
    })),
  );
  broadcast({ t: 'leaderboard', entries: leaderboard.top() });
}

// --- Игровой цикл ---

const STEP_MS = DT * 1000;
let previous = performance.now();
let accumulator = 0;

setInterval(() => {
  const now = performance.now();
  accumulator += now - previous;
  previous = now;

  // Догоняем пропущенные тики, но не больше 5 за раз: если сервер надолго завис,
  // лучше «потерять» время, чем выдать игрокам рывок на полсекунды вперёд.
  let steps = 0;
  while (accumulator >= STEP_MS && steps < 5) {
    room.update();
    accumulator -= STEP_MS;
    steps++;
  }
  if (steps === 5) accumulator = 0;
  if (steps === 0) return;

  // Фраги рассылаем всегда, даже если снапшот в этом тике пропускается.
  for (const kill of room.drainKills()) {
    broadcast({ t: 'kill', killer: kill.killer, victim: kill.victim });
  }

  const teamResult = room.drainTeamResult();
  if (teamResult) applyTeamResult(teamResult);

  if (room.tickCount % SNAPSHOT_EVERY !== 0) return;
  if (room.humanCount === 0) return;

  // В обычных режимах список танков можно было сериализовать один раз. В BR
  // список зависит от наблюдателя: сервер обязан не отправлять скрытые цели.
  const zone = room.royaleZoneState();
  for (const player of room.players.values()) {
    if (player.brain) continue;
    // Поля-массивы опускаем, когда пусто: снаряды и взрывы бывают в считаных
    // процентах тиков, а decodeSnapshot различает «пусто» и «отсутствует».
    const payload: SnapshotPayload = {
      tick: room.tickCount,
      ack: player.ack,
      players: room.snapshotEntries(player),
    };
    if (room.shellCount > 0) payload.shells = room.snapshotShells(player);
    if (room.boomEvents.length > 0) payload.booms = room.boomEvents;
    if (room.hitEvents.length > 0) payload.hits = room.hitEvents;
    if (room.bonusCount > 0) payload.bonuses = room.snapshotBonuses();
    if (zone) payload.zone = zone;
    if (room.mode === MODE_ROYALE) payload.contacts = room.snapshotContacts(player);
    player.send(encodeSnapshot(payload));
  }
}, STEP_MS / 2);

http.listen(PORT, HOST, () => {
  console.log(`Сервер танков слушает http://${HOST}:${PORT} (тик ${TICK_HZ} Гц)`);
  console.log(SERVE_STATIC ? `Статика: ${STATIC_DIR}` : 'Статика не собрана — отдаёт vite/nginx');
});
