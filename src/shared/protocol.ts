import type { Boom, Box, PlayerInfo, SnapshotEntry, SnapshotShell } from './types.js';

/** Клиент -> сервер. */
export type ClientMessage =
  | { t: 'join'; name: string }
  | { t: 'input'; seq: number; th: number; st: number; tu: number; f?: 1 }
  | { t: 'ping'; id: number };

/** Сервер -> клиент. */
export type ServerMessage =
  | {
      t: 'welcome';
      id: number;
      you: PlayerInfo;
      tickHz: number;
      map: { half: number; obstacles: Box[] };
      players: PlayerInfo[];
    }
  | { t: 'joined'; player: PlayerInfo }
  | { t: 'left'; id: number }
  | {
      t: 'snapshot';
      tick: number;
      ack: number;
      players: SnapshotEntry[];
      /** Пусто в большинстве тиков, поэтому поля необязательные — экономия трафика. */
      shells?: SnapshotShell[];
      booms?: Boom[];
    }
  | { t: 'kill'; killer: string; victim: string }
  | { t: 'pong'; id: number }
  | { t: 'error'; message: string };

export function encode(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg);
}

export function decode<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
