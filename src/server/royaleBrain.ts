import { BOT_HP, ROYALE_SIGHT_RANGE, SHELL_DAMAGE, SHELL_DAMAGE_SPREAD, TICK_HZ } from '../shared/constants.js';
import { angleDiff } from '../shared/sim.js';
import { think, type BotBrain, type BotPolicy, type BotSelf, type BotTarget, type BotTier, type BotWorld } from './bot.js';
import type { Input } from '../shared/types.js';

/**
 * BR-слой поверх общего think() (см. bot.ts, BotPolicy): боты играют не «на
 * фраги», а на выживание — ориентируются на зону всегда, а не только перед
 * сжатием, прячутся в кустах на низком HP вместо того чтобы тупо пятиться,
 * предпочитают слабые и одинокие цели, а сквад стягивается на цель, которую
 * видит хоть один боец, даже если остальные её ещё не заметили сами.
 *
 * Вся BR-специфика — здесь. bot.ts не знает об этом файле вообще; интеграция
 * — только через BotPolicy, никакой другой режим этот файл не подключает.
 */

/** Один уверенный удар с поправкой на худший разброс — ниже этого бот в шаге от смерти. */
const CRITICAL_HP = Math.ceil(SHELL_DAMAGE * (1 + SHELL_DAMAGE_SPREAD));
/** Вдвое больше: «ранен, но не критично» — отходит, только если размен ещё и невыгоден числом. */
const WOUNDED_HP = CRITICAL_HP * 2;
/** Насколько нужен перевес врагов над союзниками рядом, чтобы «раненый» счёл бой невыгодным. */
const OUTNUMBER_MARGIN = 1;
/** Радиус, в котором танк считается «рядом» — для отступления и оценки изоляции цели, м. */
const NEARBY_RADIUS = 40;
/** Не прячемся ближе этого к последнему известному врагу — иначе «укрытие» у него на глазах. */
const HIDE_AWAY_FROM_THREAT = NEARBY_RADIUS * 0.3;
/** С этой дистанции уже можно открыть огонь, но пока невыгодно лезть под башню цели. */
const STALK_MIN_RANGE = 42;
/** Дальше бот ещё не ведёт бой, а выбирает фланг и постепенно сокращает дистанцию. */
const STALK_MAX_RANGE = 110;
/** Предпочтительная дистанция позади цели: вне ближнего размена, но в пределах одного рывка. */
const STALK_BEHIND_RANGE = 54;
/** Увод точки захода вбок, чтобы не ехать буквально след в след. */
const STALK_FLANK = 18;
/** Полуугол опасного сектора башни противника. */
const STALK_THREAT_ARC = (75 * Math.PI) / 180;
/** Доля BR-ботов с ролью засадника задаётся в createBrain() (каждый пятый). */
const AMBUSH_HOLD_S = 32;
/** С такой дистанции засада уже превращается в осмысленную первую атаку. */
const AMBUSH_TRIGGER_RANGE = 46;
/** Угол позиции от последнего известного противника, где прятаться уже глупо. */
const AMBUSH_AWAY_FROM_THREAT = NEARBY_RADIUS * 0.45;

/** Насколько низкое HP цели перевешивает выбор — в тех же «метрах», что и dist (см. targetScore). */
const WEAK_WEIGHT = 40;
/** Насколько цель без прикрытия союзниками перевешивает выбор. */
const ISOLATION_WEIGHT = 25;
/** Насколько цель, уже названная сквадом, перевешивает выбор — меньше WEAK_WEIGHT: свежий личный засвет ценнее чужого возможно устаревшего вызова. */
const CALLOUT_WEIGHT = 30;
/** Сколько секунд «вызов» сквада живёт без подтверждения — время добежать до него. */
const CALLOUT_TTL_S = 6;

interface CallOut {
  targetId: number;
  x: number;
  z: number;
  hp: number;
  until: number;
}

/**
 * Общее знание отряда, которого нет у одиночного think(): кого сквад считает
 * целью (самый слабый враг, которого прямо сейчас видит хоть один боец) и
 * насколько у каждого танка на карте есть прикрытие союзниками или перевес
 * врагов. Пересчитывается централизованно раз в тик — не на каждого бота, —
 * иначе честный O(n) на бота превращается в O(n^2) на пустом месте.
 *
 * Один экземпляр на Room, живёт весь матч; чистить в тех же точках, где уже
 * чистятся royaleContacts/royaleVision (см. room.ts).
 */
export class RoyaleIntel {
  private readonly callouts = new Map<number, CallOut>();
  private readonly alliesNearMap = new Map<number, number>();
  private readonly enemiesNearMap = new Map<number, number>();
  private lastRefreshTick = -Infinity;

  /** Идемпотентно в пределах тика: платит только первый вызвавший think() на этом тике бот. */
  refreshIfNeeded(world: BotWorld): void {
    if (world.tick <= this.lastRefreshTick) return;
    this.lastRefreshTick = world.tick;
    this.refreshProximity(world);
    this.refreshCallouts(world);
  }

  calloutFor(team: number, tick: number): CallOut | null {
    const c = this.callouts.get(team);
    return c && tick <= c.until ? c : null;
  }

  alliesNear(id: number): number {
    return this.alliesNearMap.get(id) ?? 0;
  }

  enemiesNear(id: number): number {
    return this.enemiesNearMap.get(id) ?? 0;
  }

  /** Сброс между матчами/при реконфиге сквада — вызывать рядом с royaleContacts.clear(). */
  clear(): void {
    this.callouts.clear();
    this.alliesNearMap.clear();
    this.enemiesNearMap.clear();
    this.lastRefreshTick = -Infinity;
  }

  private refreshProximity(world: BotWorld): void {
    this.alliesNearMap.clear();
    this.enemiesNearMap.clear();
    const alive: BotTarget[] = [];
    for (const tank of world.tanks) if (!tank.dead) alive.push(tank);

    for (const a of alive) {
      let allies = 0;
      let enemies = 0;
      for (const b of alive) {
        if (b.id === a.id) continue;
        if (Math.hypot(a.state.x - b.state.x, a.state.z - b.state.z) > NEARBY_RADIUS) continue;
        if (b.team === a.team) allies++;
        else enemies++;
      }
      this.alliesNearMap.set(a.id, allies);
      this.enemiesNearMap.set(a.id, enemies);
    }
  }

  private refreshCallouts(world: BotWorld): void {
    const byId = new Map<number, BotTarget & { hp?: number }>();
    for (const tank of world.tanks) byId.set(tank.id, tank as BotTarget & { hp?: number });

    for (const tank of world.tanks) {
      if (tank.dead) continue;
      const bot = tank as BotTarget & { brain?: BotBrain | null };
      if (!bot.brain || !bot.brain.engaged || bot.brain.targetId === 0) continue;
      const target = byId.get(bot.brain.targetId);
      if (!target || target.dead || target.hp === undefined) continue;

      const until = world.tick + Math.round(CALLOUT_TTL_S * TICK_HZ);
      const current = this.callouts.get(tank.team);
      if (current && current.targetId === target.id) {
        // Тот же вызов — освежаем позицию и срок, не даём флику между
        // похожими по HP целями на соседних тиках.
        current.x = target.state.x;
        current.z = target.state.z;
        current.hp = target.hp;
        current.until = until;
      } else if (!current || target.hp < current.hp) {
        this.callouts.set(tank.team, { targetId: target.id, x: target.state.x, z: target.state.z, hp: target.hp, until });
      }
    }
  }
}

/** BR-тактика: см. заголовок файла. Держит только ссылку на intel — сам без состояния. */
export class RoyalePolicy implements BotPolicy {
  constructor(private readonly intel: RoyaleIntel) {}

  /** На этой дальности BR-бот проверяет линию видимости, но не стреляет автоматически. */
  readonly sightRayRange = ROYALE_SIGHT_RANGE;

  /**
   * Камера игрока от третьего лица крутится независимо от корпуса, и сервер
   * даёт ему засвет по кругу в ROYALE_SIGHT_RANGE. Бот получает ту же
   * геометрию; стены и кусты всё равно отсекаются общим hasShot().
   */
  canSee(_self: BotSelf, _candidate: BotTarget, _tier: BotTier, dist: number, _world: BotWorld): boolean {
    return dist <= ROYALE_SIGHT_RANGE;
  }

  /**
   * Пока ствол цели смотрит в нашу сторону на средней дистанции, не начинаем
   * лобовой размен: заходим к корме по выбранной ботом стороне. Как только
   * вышли из опасного сектора или сблизились, возвращаем управление обычному
   * бою — он уже сам проверит линию огня, прицел и право фокусного огня.
  */
  stalkPoint(self: BotSelf, candidate: BotTarget, dist: number, _world: BotWorld): { x: number; z: number } | null {
    // Взрыв рядом или попадание означает, что нас уже раскрыли. Продолжать
    // обход молча бессмысленно: dodge() в общем think() уведёт с траектории,
    // а затем обычный бой сможет ответить огнём.
    if (self.suppressed) return null;
    if (dist < STALK_MIN_RANGE || dist > STALK_MAX_RANGE) return null;
    const bearing = Math.atan2(self.state.x - candidate.state.x, self.state.z - candidate.state.z);
    if (Math.abs(angleDiff(candidate.state.turret, bearing)) > STALK_THREAT_ARC) return null;

    const facingX = Math.sin(candidate.state.turret);
    const facingZ = Math.cos(candidate.state.turret);
    const side = self.brain.orbit;
    return {
      x: candidate.state.x - facingX * STALK_BEHIND_RANGE + facingZ * STALK_FLANK * side,
      z: candidate.state.z - facingZ * STALK_BEHIND_RANGE - facingX * STALK_FLANK * side,
    };
  }

  targetScore(self: BotSelf, candidate: BotTarget, dist: number, world: BotWorld): number {
    const hp = (candidate as BotTarget & { hp?: number }).hp;
    const weak = hp === undefined ? 0 : Math.max(0, 1 - hp / BOT_HP) * WEAK_WEIGHT;
    const isolation = ISOLATION_WEIGHT / (1 + this.intel.alliesNear(candidate.id));
    const callout = this.intel.calloutFor(self.team, world.tick);
    const called = callout && callout.targetId === candidate.id ? CALLOUT_WEIGHT : 0;
    return dist - weak - isolation - called;
  }

  shouldRetreat(self: BotSelf, _world: BotWorld): boolean {
    if (self.hp <= CRITICAL_HP) return true;
    if (self.hp <= WOUNDED_HP) {
      const enemies = this.intel.enemiesNear(self.id);
      const allies = this.intel.alliesNear(self.id);
      if (enemies > allies + OUTNUMBER_MARGIN) return true;
    }
    return false;
  }

  retreatTo(self: BotSelf, world: BotWorld): { x: number; z: number } | null {
    const bushes = world.bushes;
    if (!bushes || bushes.length === 0) return null;
    const me = self.state;
    const zone = world.zone;
    const brain = self.brain;

    let best: { x: number; z: number } | null = null;
    let bestDist = Infinity;
    for (const b of bushes) {
      if (zone && zone.phase !== 'over' && Math.hypot(b.x - zone.x, b.z - zone.z) > zone.r) continue;
      if (Math.hypot(b.x - brain.lastX, b.z - brain.lastZ) < HIDE_AWAY_FROM_THREAT) continue;
      const d = Math.hypot(b.x - me.x, b.z - me.z);
      if (d < bestDist) {
        bestDist = d;
        best = { x: b.x, z: b.z };
      }
    }
    return best;
  }

  /**
   * Отдельная роль, а не побочный эффект малого HP: засадник выбирает куст и
   * удерживает его, пока круг не вынудит сменить точку. Это даёт матчу тех
   * самых тихих «крыс», а остальные боты всё ещё случайно бродят по карте.
   */
  ambushPoint(self: BotSelf, world: BotWorld): { x: number; z: number } | null {
    const brain = self.brain;
    const bushes = world.bushes;
    if (!brain.ambusher || self.suppressed || !bushes || bushes.length === 0) return null;
    const zone = world.zone;
    const pointIsSafe =
      !zone ||
      zone.phase === 'over' ||
      Math.hypot(brain.ambushX - zone.x, brain.ambushZ - zone.z) <= zone.r - 4;
    if (world.tick < brain.ambushUntil && pointIsSafe) return { x: brain.ambushX, z: brain.ambushZ };

    let best: { x: number; z: number } | null = null;
    let bestScore = Infinity;
    for (const bush of bushes) {
      if (zone && zone.phase !== 'over' && Math.hypot(bush.x - zone.x, bush.z - zone.z) > zone.r - 4) continue;
      // Не занимаем куст под носом у последней замеченной цели.
      if (Math.hypot(bush.x - brain.lastX, bush.z - brain.lastZ) < AMBUSH_AWAY_FROM_THREAT) continue;
      const distance = Math.hypot(bush.x - self.state.x, bush.z - self.state.z);
      // Немного случайности не даёт всем засадникам набиться в один ближайший куст.
      const score = distance + Math.random() * 28;
      if (score < bestScore) {
        bestScore = score;
        best = { x: bush.x, z: bush.z };
      }
    }
    if (!best) return null;
    brain.ambushX = best.x;
    brain.ambushZ = best.z;
    brain.ambushUntil = world.tick + Math.round(AMBUSH_HOLD_S * TICK_HZ);
    return best;
  }

  holdAmbush(self: BotSelf, _candidate: BotTarget, dist: number, world: BotWorld): boolean {
    const brain = self.brain;
    if (!brain.ambusher || self.suppressed || world.tick >= brain.ambushUntil) return false;
    if (Math.hypot(self.state.x - brain.ambushX, self.state.z - brain.ambushZ) >= 6) return false;
    return dist > AMBUSH_TRIGGER_RANGE;
  }

  regroupPoint(self: BotSelf, world: BotWorld): { x: number; z: number } | null {
    const callout = this.intel.calloutFor(self.team, world.tick);
    if (callout && callout.targetId !== self.brain.targetId) return { x: callout.x, z: callout.z };
    return null;
  }
}

/**
 * Точка входа для BR: сначала дешёвое общее обновление знания отряда (не
 * чаще раза в тик на всю комнату), затем обычный think() с BR-политикой
 * вместо правил по умолчанию.
 */
export function royaleThink(self: BotSelf, world: BotWorld, intel: RoyaleIntel, policy: RoyalePolicy): Input {
  intel.refreshIfNeeded(world);
  return think(self, world, policy);
}
