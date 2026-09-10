import type { ExpeditionUpgrade, GameMode, RoyaleSquadSize, Ruleset } from './constants.js';
import type {
  Boom,
  Box,
  HitFx,
  PlayerInfo,
  SnapshotBonus,
  SnapshotContact,
  SnapshotEntry,
  SnapshotShell,
} from './types.js';

/**
 * Фаза боя в режиме против ботов.
 * fight — волна на карте, break — передышка перед следующей, over — все пали.
 */
export type WavePhase = 'fight' | 'break' | 'upgrade' | 'over';

/** Состояние круга в королевской битве. Координаты — в метрах карты. */
export interface RoyaleZoneState {
  x: number;
  z: number;
  /** Текущий радиус безопасной зоны. */
  r: number;
  /** Радиус, к которому идёт следующий этап сжатия. */
  nextR: number;
  /** Сколько секунд до следующего изменения состояния. */
  until: number;
  phase: 'safe' | 'shrinking' | 'final' | 'over';
  /** Урон за секунду вне круга. */
  damage: number;
}

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
  /** Текущая сила танка в экспедиции и уже выбранные улучшения. */
  power?: number;
  /** Множитель максимального здоровья команды в экспедиции. */
  health?: number;
  upgrades?: number[];
  choices?: ExpeditionUpgrade[];
  /** Победа в экспедиции, в отличие от проигрыша в фазе over. */
  victory?: boolean;
  /**
   * Размер команды в командном бою (5 или 10 на сторону). Живой счёт по
   * сторонам клиент считает сам по ростеру и снапшоту — так он не отстаёт
   * от кадра, в отличие от этого сообщения, которое шлётся только на
   * границах раунда.
   */
  teamSize?: number;
  /** Кто выиграл раунд командного боя: номер команды или ничья по таймеру. */
  winner?: number | 'draw';
  /** Состояние матча BR: предстарт, бой или завершение. */
  royalePhase?: 'countdown' | 'fight' | 'over';
  /** Секунд до перехода BR в следующую фазу. */
  royaleUntil?: number;
}

/** Одна строка доски лидеров. */
export interface LeaderboardEntry {
  name: string;
  wins: number;
  losses: number;
  draws: number;
  kills: number;
}

/** Настройки комнаты. Одинаковые поля в welcome и в config. */
export interface RoomConfig {
  /** Индекс карты. Геометрия приходит отдельным сообщением map. */
  mapId: number;
  mode: GameMode;
  /**
   * Аркада или реализм. Ось, независимая от mode: она задаёт не с кем драться,
   * а что игроку показывают про противника.
   */
  rules: Ruleset;
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
  /** Выбор хоста для командного боя: 5×5 или 10×10. */
  teamSize: number;
  /** Формат отряда в королевской битве: 1, 2 или 4 игрока. */
  royaleSquadSize: RoyaleSquadSize;
}

/** Клиент -> сервер. */
export type ClientMessage =
  | { t: 'join'; name: string }
  | { t: 'input'; seq: number; th: number; st: number; tu: number; f?: 1 }
  | { t: 'ping'; id: number }
  | { t: 'upgrade'; id: number }
  /** Настройка комнаты; принимается только от хоста. */
  | {
      t: 'setup';
      mode?: GameMode;
      rules?: Ruleset;
      diff?: number;
      bonuses?: boolean;
      map?: number;
      stance?: number;
      teamSize?: number;
      royaleSquadSize?: RoyaleSquadSize;
    };

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
      leaderboard: LeaderboardEntry[];
    } & RoomConfig)
  | { t: 'joined'; player: PlayerInfo }
  /**
   * Танк ушёл из комнаты насовсем: отключился человек, или волна зачистила
   * остов подбитого бота. Гибель как таковая сюда не попадает — труп остаётся
   * в комнате как обычный игрок с dead=1 в снапшоте, пока не возродится.
   */
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
      /** Сумма урона по каждому попаданию этого тика — снаряд или таран. */
      hits?: HitFx[];
      /** Ящики на карте; поле есть, только когда бонусы включены и что-то лежит. */
      bonuses?: SnapshotBonus[];
      /** Круг отправляется только в королевской битве. */
      zone?: RoyaleZoneState;
      /** Последние известные точки скрытых врагов — только в королевской битве. */
      contacts?: SnapshotContact[];
    }
  | { t: 'kill'; killer: string; victim: string }
  /** Доска лидеров обновилась — после каждого завершённого раунда командного боя. */
  | { t: 'leaderboard'; entries: LeaderboardEntry[] }
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
