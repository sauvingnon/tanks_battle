import type { GameMode, RoyaleSquadSize, Ruleset } from '../shared/constants.js';
import { decode, decodeSnapshot, encode, type ClientMessage, type ServerMessage } from '../shared/protocol.js';
import type { Input } from '../shared/types.js';

export interface NetHandlers {
  onMessage: (msg: ServerMessage) => void;
  onOpen: () => void;
  onClose: (reason: string) => void;
}

/** Адрес сокета берём от текущей страницы: в dev его проксирует vite, в проде — nginx. */
function socketUrl(): string {
  const override = import.meta.env.VITE_WS_URL;
  if (override) return override;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws`;
}

export class Net {
  latency = 0;

  private ws: WebSocket | null = null;
  private pingTimer: number | null = null;
  private pingSentAt = 0;
  private pingId = 0;

  constructor(private readonly handlers: NetHandlers) {}

  connect(name: string): void {
    const ws = new WebSocket(socketUrl());
    // Snapshot приходит бинарём; без этого браузер отдал бы его как Blob.
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.send({ t: 'join', name });
      this.handlers.onOpen();
      this.startPing();
    };

    ws.onmessage = (event) => {
      const msg: ServerMessage | null =
        event.data instanceof ArrayBuffer ? decodeSnapshot(event.data) : decode<ServerMessage>(String(event.data));
      if (!msg) return;
      if (msg.t === 'pong' && msg.id === this.pingId) {
        // RTT замеряем по своему же таймстемпу — часы сервера не нужны.
        this.latency = Math.round(performance.now() - this.pingSentAt);
        return;
      }
      this.handlers.onMessage(msg);
    };

    ws.onclose = () => {
      this.stopPing();
      this.handlers.onClose('Соединение с сервером потеряно');
    };

    ws.onerror = () => {
      // Подробности недоступны из соображений безопасности браузера;
      // onclose всё равно сработает следом и сообщит игроку.
    };
  }

  /** Настройка комнаты. Сервер примет её только от хоста. */
  sendSetup(setup: {
    mode?: GameMode;
    rules?: Ruleset;
    diff?: number;
    bonuses?: boolean;
    map?: number;
    stance?: number;
    teamSize?: number;
    royaleSquadSize?: RoyaleSquadSize;
  }): void {
    this.send({ t: 'setup', ...setup });
  }

  sendInput(input: Input): void {
    this.send({
      t: 'input',
      seq: input.seq,
      th: round(input.throttle),
      st: round(input.steer),
      tu: round(input.turret),
      // Поле шлём только в тик выстрела: оно бывает раз в полторы секунды.
      ...(input.fire ? { f: 1 as const } : {}),
    });
  }

  sendUpgrade(id: number): void {
    this.send({ t: 'upgrade', id });
  }

  manageLoadout(op: 'equip' | 'drop' | 'drop-equipped', index: number): void {
    this.send({ t: 'loadout', op, index });
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
  }

  private startPing(): void {
    this.stopPing();
    const tick = () => {
      this.pingId++;
      this.pingSentAt = performance.now();
      this.send({ t: 'ping', id: this.pingId });
    };
    tick();
    this.pingTimer = window.setInterval(tick, 2000);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  close(): void {
    this.stopPing();
    this.ws?.close();
    this.ws = null;
  }
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
