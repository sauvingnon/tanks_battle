import type { GameMode } from './constants.js';
import type {
  Boom,
  Box,
  PlayerInfo,
  SnapshotBonus,
  SnapshotEntry,
  SnapshotShell,
} from './types.js';

/**
 * Фаза боя в режиме против ботов.
 * fight — волна на карте, break — передышка перед следующей, over — все пали.
 */
export type WavePhase = 'fight' | 'break' | 'over';

/** Что сейчас происходит в комнате: одно и то же поле в welcome и в wave. */
export interface WaveState {
  /** Номер текущей (или только что проигранной) волны, с 1. */
  wave: number;
  phase: WavePhase;
  /** Сколько ботов волны ещё на карте или ждут выхода. */
  left: number;
  /** Секунд до конца паузы; для fight — 0. */
  until: number;
  /** Лучшая волна за время жизни сервера. */
  best: number;
}

/** Настройки комнаты. Одинаковые поля в welcome и в config. */
export interface RoomConfig {
  /** Индекс карты. Геометрия приходит отдельным сообщением map. */
  mapId: number;
  mode: GameMode;
  /** Выбор хоста. */
  difficulty: number;
  /**
   * Сложность, по которой идёт бой прямо сейчас. Посреди волны отстаёт от
   * difficulty: выбор хоста вступает в силу только на границе волн, и клиенту
   * нужны оба числа, чтобы честно подписать, когда настройка сработает.
   */
  active: number;
  /** Манера боя ботов: дистанция / нейтрал / напор. Действует сразу. */
  stance: number;
  bonuses: boolean;
  hostId: number;
}

/** Клиент -> сервер. */
export type ClientMessage =
  | { t: 'join'; name: string }
  | { t: 'input'; seq: number; th: number; st: number; tu: number; f?: 1 }
  | { t: 'ping'; id: number }
  /** Настройка комнаты; принимается только от хоста. */
  | { t: 'setup'; mode?: GameMode; diff?: number; bonuses?: boolean; map?: number; stance?: number };

/** Сервер -> клиент. */
export type ServerMessage =
  | ({
      t: 'welcome';
      id: number;
      you: PlayerInfo;
      tickHz: number;
      map: { half: number; obstacles: Box[] };
      players: PlayerInfo[];
      wave: WaveState;
    } & RoomConfig)
  | { t: 'joined'; player: PlayerInfo }
  | { t: 'left'; id: number }
  /** Хост сменил настройки, либо хост сменился сам. */
  | ({ t: 'config' } & RoomConfig)
  /** Сменилась карта: клиент пересобирает мир по этой геометрии. */
  | { t: 'map'; id: number; half: number; obstacles: Box[] }
  /** Кто-то поднял ящик: клиент показывает это в ленте и вспышкой. */
  | { t: 'pickup'; id: number; kind: number }
  | ({ t: 'wave' } & WaveState)
  | {
      t: 'snapshot';
      tick: number;
      ack: number;
      players: SnapshotEntry[];
      /** Пусто в большинстве тиков, поэтому поля необязательные — экономия трафика. */
      shells?: SnapshotShell[];
      booms?: Boom[];
      /** Ящики на карте; поле есть, только когда бонусы включены и что-то лежит. */
      bonuses?: SnapshotBonus[];
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
