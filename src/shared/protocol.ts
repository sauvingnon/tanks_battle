import type { ExpeditionUpgrade, GameMode, RoyaleSquadSize, Ruleset } from './constants.js';
import type {
  Boom,
  Box,
  HitFx,
  PlayerInfo,
  SnapshotBonus,
  SnapshotContact,
  SnapshotEntry,
  SnapshotLoadout,
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
  /** Центр, к которому переместится зона на следующем этапе. */
  nextX: number;
  nextZ: number;
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
  /** Общее число живых танков в BR, включая скрытых противников. */
  royaleAlive?: number;
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
  /** Операция со своим BR-рюкзаком; сервер сам проверяет слот и владение. */
  | { t: 'loadout'; op: 'equip' | 'drop' | 'drop-equipped'; index: number }
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
      /** Личный инвентарь — никогда не отправляется соперникам. */
      loadout?: SnapshotLoadout;
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

/**
 * Бинарный кодек ровно для snapshot — единственного сообщения, которое реально
 * весит: до 40 танков в BR, персонально на игрока, десятки раз в секунду. Всё
 * остальное (join/setup/wave/kill/...) редкое и лёгкое, там текстовый JSON
 * читаемее и трогать его незачем.
 *
 * Формат: little-endian, без тега типа сообщения — WebSocket сам различает
 * текстовый и бинарный фрейм, decode() на клиенте смотрит на это раньше, чем
 * лезть внутрь.
 */
export type SnapshotMessage = Extract<ServerMessage, { t: 'snapshot' }>;
export type SnapshotPayload = Omit<SnapshotMessage, 't'>;

const TWO_PI = Math.PI * 2;
// 0.1 м на позицию и радиус зоны — с запасом даже для самой большой карты
// (полукатет 450 м, т.е. ±4500 после масштаба, Int16 держит ±32767).
const POS_SCALE = 10;
// 0.01 м/с — танки не быстрее пары десятков м/с даже с бонусом скорости.
const SPEED_SCALE = 100;
// 0.1 хп — урон приходит с дробным множителем (броня/урон BR), а не целым.
const HP_SCALE = 10;
// 0.1 секунды — таймеры зоны и меток контактов.
const SEC_SCALE = 10;
// Угол уже нормализован wrapAngle() до (-PI, PI], здесь ещё раз мод 2PI —
// на случай не завёрнутого значения вроде shell.a.
const ANGLE_SCALE = 65536 / TWO_PI;

const ZONE_PHASE_CODES = ['safe', 'shrinking', 'final', 'over'] as const;

const F_SHELLS = 1 << 0;
const F_BOOMS = 1 << 1;
const F_HITS = 1 << 2;
const F_BONUSES = 1 << 3;
const F_ZONE = 1 << 4;
const F_CONTACTS = 1 << 5;
const F_LOADOUT = 1 << 6;

const HEADER_SIZE = 11; // flags:u8 + tick:u32 + ack:u32 + playerCount:u16
const PLAYER_SIZE = 26; // i:u32 x:i16 z:i16 a:u16 t:u16 s:i16 h:u16 m:u16 f:u16 d:u8 c:u8 q:u32
const SHELL_SIZE = 15; // i:u32 o:u32 x:i16 z:i16 a:u16 b:u8
const BOOM_SIZE = 9; // x:i16 z:i16 k:u8 o:u32
const HIT_SIZE = 6; // x:i16 z:i16 amount:u16
const BONUS_SIZE = 9; // i:u32 k:u8 x:i16 z:i16
const ZONE_SIZE = 16; // x:i16 z:i16 nextX:i16 nextZ:i16 r:u16 nextR:u16 until:u16 phase:u8 damage:u8
const CONTACT_SIZE = 10; // i:u32 x:i16 z:i16 u:u16
const LOADOUT_SLOTS = 5;

function clampI16(v: number): number {
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}

function clampU16(v: number): number {
  return v < 0 ? 0 : v > 65535 ? 65535 : v;
}

function packPos(v: number): number {
  return clampI16(Math.round(v * POS_SCALE));
}

function unpackPos(v: number): number {
  return v / POS_SCALE;
}

function packSpeed(v: number): number {
  return clampI16(Math.round(v * SPEED_SCALE));
}

function unpackSpeed(v: number): number {
  return v / SPEED_SCALE;
}

function packHp(v: number): number {
  return clampU16(Math.round(v * HP_SCALE));
}

function unpackHp(v: number): number {
  return v / HP_SCALE;
}

function packSec(v: number): number {
  return clampU16(Math.round(Math.max(0, v) * SEC_SCALE));
}

function unpackSec(v: number): number {
  return v / SEC_SCALE;
}

function packAngle(v: number): number {
  let n = v % TWO_PI;
  if (n < 0) n += TWO_PI;
  return Math.round(n * ANGLE_SCALE) & 0xffff;
}

function unpackAngle(v: number): number {
  return v / ANGLE_SCALE;
}

class Writer {
  readonly buf: ArrayBuffer;
  private readonly view: DataView;
  private offset = 0;

  constructor(size: number) {
    this.buf = new ArrayBuffer(size);
    this.view = new DataView(this.buf);
  }

  u8(v: number): void {
    this.view.setUint8(this.offset, v);
    this.offset += 1;
  }

  u16(v: number): void {
    this.view.setUint16(this.offset, v, true);
    this.offset += 2;
  }

  i16(v: number): void {
    this.view.setInt16(this.offset, v, true);
    this.offset += 2;
  }

  u32(v: number): void {
    this.view.setUint32(this.offset, v, true);
    this.offset += 4;
  }
}

class Reader {
  private readonly view: DataView;
  private offset = 0;

  constructor(buf: ArrayBuffer) {
    this.view = new DataView(buf);
  }

  u8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  i16(): number {
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
}

export function encodeSnapshot(p: SnapshotPayload): ArrayBuffer {
  const flags =
    (p.shells !== undefined ? F_SHELLS : 0) |
    (p.booms !== undefined ? F_BOOMS : 0) |
    (p.hits !== undefined ? F_HITS : 0) |
    (p.bonuses !== undefined ? F_BONUSES : 0) |
    (p.zone !== undefined ? F_ZONE : 0) |
    (p.contacts !== undefined ? F_CONTACTS : 0) |
    (p.loadout !== undefined ? F_LOADOUT : 0);

  let size = HEADER_SIZE + p.players.length * PLAYER_SIZE;
  if (p.shells) size += 2 + p.shells.length * SHELL_SIZE;
  if (p.booms) size += 2 + p.booms.length * BOOM_SIZE;
  if (p.hits) size += 2 + p.hits.length * HIT_SIZE;
  if (p.bonuses) size += 2 + p.bonuses.length * BONUS_SIZE;
  if (p.zone) size += ZONE_SIZE;
  if (p.contacts) size += 2 + p.contacts.length * CONTACT_SIZE;
  if (p.loadout) size += 1 + p.loadout.inventory.length + LOADOUT_SLOTS;

  const w = new Writer(size);
  w.u8(flags);
  w.u32(p.tick >>> 0);
  w.u32(p.ack >>> 0);
  w.u16(p.players.length);
  for (const e of p.players) {
    w.u32(e.i >>> 0);
    w.i16(packPos(e.x));
    w.i16(packPos(e.z));
    w.u16(packAngle(e.a));
    w.u16(packAngle(e.t));
    w.i16(packSpeed(e.s));
    w.u16(packHp(e.h));
    w.u16(packHp(e.m ?? 0));
    w.u16(e.f ?? 0);
    w.u8(e.d);
    w.u8(e.c ?? 0);
    w.u32((e.q ?? 0) >>> 0);
  }
  if (p.shells) {
    w.u16(p.shells.length);
    for (const s of p.shells) {
      w.u32(s.i >>> 0);
      w.u32(s.o >>> 0);
      w.i16(packPos(s.x));
      w.i16(packPos(s.z));
      w.u16(packAngle(s.a));
      w.u8(s.b);
    }
  }
  if (p.booms) {
    w.u16(p.booms.length);
    for (const b of p.booms) {
      w.i16(packPos(b.x));
      w.i16(packPos(b.z));
      w.u8(b.k);
      w.u32(b.o >>> 0);
    }
  }
  if (p.hits) {
    w.u16(p.hits.length);
    for (const h of p.hits) {
      w.i16(packPos(h.x));
      w.i16(packPos(h.z));
      w.u16(packHp(h.amount));
    }
  }
  if (p.bonuses) {
    w.u16(p.bonuses.length);
    for (const b of p.bonuses) {
      w.u32(b.i >>> 0);
      w.u8(b.k);
      w.i16(packPos(b.x));
      w.i16(packPos(b.z));
    }
  }
  if (p.zone) {
    w.i16(packPos(p.zone.x));
    w.i16(packPos(p.zone.z));
    w.i16(packPos(p.zone.nextX));
    w.i16(packPos(p.zone.nextZ));
    w.u16(clampU16(Math.round(p.zone.r * POS_SCALE)));
    w.u16(clampU16(Math.round(p.zone.nextR * POS_SCALE)));
    w.u16(packSec(p.zone.until));
    w.u8(Math.max(0, ZONE_PHASE_CODES.indexOf(p.zone.phase)));
    w.u8(clampU16(Math.round(p.zone.damage)) & 0xff);
  }
  if (p.contacts) {
    w.u16(p.contacts.length);
    for (const c of p.contacts) {
      w.u32(c.i >>> 0);
      w.i16(packPos(c.x));
      w.i16(packPos(c.z));
      w.u16(packSec(c.u));
    }
  }
  if (p.loadout) {
    w.u8(p.loadout.inventory.length);
    for (const id of p.loadout.inventory) w.u8(id);
    for (let slot = 0; slot < LOADOUT_SLOTS; slot++) w.u8(p.loadout.equipped[slot] ?? 0);
  }
  return w.buf;
}

export function decodeSnapshot(buf: ArrayBuffer): SnapshotMessage {
  const r = new Reader(buf);
  const flags = r.u8();
  const tick = r.u32();
  const ack = r.u32();
  const playerCount = r.u16();

  const players: SnapshotEntry[] = [];
  for (let i = 0; i < playerCount; i++) {
    players.push({
      i: r.u32(),
      x: unpackPos(r.i16()),
      z: unpackPos(r.i16()),
      a: unpackAngle(r.u16()),
      t: unpackAngle(r.u16()),
      s: unpackSpeed(r.i16()),
      h: unpackHp(r.u16()),
      m: unpackHp(r.u16()),
      f: r.u16(),
      d: r.u8() as 0 | 1,
      c: r.u8() as 0 | 1 | 2,
      q: r.u32(),
    });
  }

  const msg: SnapshotMessage = { t: 'snapshot', tick, ack, players };

  if (flags & F_SHELLS) {
    const n = r.u16();
    const shells: SnapshotShell[] = [];
    for (let i = 0; i < n; i++) {
      shells.push({
        i: r.u32(),
        o: r.u32(),
        x: unpackPos(r.i16()),
        z: unpackPos(r.i16()),
        a: unpackAngle(r.u16()),
        b: r.u8(),
      });
    }
    msg.shells = shells;
  }
  if (flags & F_BOOMS) {
    const n = r.u16();
    const booms: Boom[] = [];
    for (let i = 0; i < n; i++) {
      booms.push({
        x: unpackPos(r.i16()),
        z: unpackPos(r.i16()),
        k: r.u8() as Boom['k'],
        o: r.u32(),
      });
    }
    msg.booms = booms;
  }
  if (flags & F_HITS) {
    const n = r.u16();
    const hits: HitFx[] = [];
    for (let i = 0; i < n; i++) {
      hits.push({ x: unpackPos(r.i16()), z: unpackPos(r.i16()), amount: unpackHp(r.u16()) });
    }
    msg.hits = hits;
  }
  if (flags & F_BONUSES) {
    const n = r.u16();
    const bonuses: SnapshotBonus[] = [];
    for (let i = 0; i < n; i++) {
      bonuses.push({ i: r.u32(), k: r.u8(), x: unpackPos(r.i16()), z: unpackPos(r.i16()) });
    }
    msg.bonuses = bonuses;
  }
  if (flags & F_ZONE) {
    const x = unpackPos(r.i16());
    const z = unpackPos(r.i16());
    const nextX = unpackPos(r.i16());
    const nextZ = unpackPos(r.i16());
    const zr = r.u16() / POS_SCALE;
    const nextR = r.u16() / POS_SCALE;
    const until = unpackSec(r.u16());
    const phase = ZONE_PHASE_CODES[r.u8()] ?? 'safe';
    const damage = r.u8();
    msg.zone = { x, z, nextX, nextZ, r: zr, nextR, until, phase, damage };
  }
  if (flags & F_CONTACTS) {
    const n = r.u16();
    const contacts: SnapshotContact[] = [];
    for (let i = 0; i < n; i++) {
      contacts.push({ i: r.u32(), x: unpackPos(r.i16()), z: unpackPos(r.i16()), u: unpackSec(r.u16()) });
    }
    msg.contacts = contacts;
  }
  if (flags & F_LOADOUT) {
    const count = r.u8();
    const inventory: number[] = [];
    for (let i = 0; i < count; i++) inventory.push(r.u8());
    const equipped: number[] = [];
    for (let slot = 0; slot < LOADOUT_SLOTS; slot++) equipped.push(r.u8());
    msg.loadout = { inventory, equipped };
  }
  return msg;
}
