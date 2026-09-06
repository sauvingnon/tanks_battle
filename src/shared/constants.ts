// Единые константы симуляции. Их использует и сервер, и клиент (предсказание),
// поэтому менять значения можно только здесь.

/** Частота тика симуляции на сервере и шага предсказания на клиенте. */
export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;

/** Как часто сервер рассылает снапшоты (каждый N-й тик). */
export const SNAPSHOT_EVERY = 1;

/** Задержка интерполяции чужих танков, мс. Должна быть >= двух интервалов снапшота. */
export const INTERP_DELAY_MS = 100;

/** Карта — квадрат [-MAP_HALF, MAP_HALF] по X и Z. */
export const MAP_HALF = 70;

/** Радиус столкновений танка (танк считаем кругом сверху). */
export const TANK_RADIUS = 2.4;

// --- Ходовая часть ---
export const MAX_SPEED = 13; // м/с вперёд
export const MAX_REVERSE = 6; // м/с назад
export const ACCEL = 11; // разгон, м/с^2
export const BRAKE = 20; // торможение при газе против движения, м/с^2
export const FRICTION = 7; // накат при отпущенном газе, м/с^2

/** Скорость поворота корпуса на месте и на полном ходу, рад/с. */
export const TURN_RATE_STILL = 1.6;
export const TURN_RATE_FULL = 0.85;

/** Скорость доворота башни к прицелу, рад/с. */
export const TURRET_RATE = 1.7;

/** Сколько скорости теряется при ударе о препятствие. */
export const BUMP_DAMPING = 0.25;

// --- Бой ---
export const MAX_HP = 100;
export const SHELL_DAMAGE = 25; // четыре попадания = смерть

/**
 * Снаряд летит по прямой без гравитации: так попадание считается в 2D, а игроку
 * понятно, куда целиться. 62 м/с — карту в поперечнике проходит за 2.3 с,
 * то есть по едущему танку надо брать упреждение.
 */
export const SHELL_SPEED = 62;
export const SHELL_RADIUS = 0.3;
export const SHELL_LIFETIME = 3.5; // с
/** Высота полёта. Все препятствия на карте выше — значит укрытия работают. */
export const SHELL_HEIGHT = 2.15;
/** Вылет снаряда от центра танка, чуть дальше дульного среза. */
export const MUZZLE_OFFSET = 4.2;

// --- Рикошет ---

/**
 * Порог рикошета: |cos| между траекторией и нормалью задетой грани. 1 — точно в лоб,
 * 0 — вдоль стены. Отскок разрешён, если значение меньше порога, то есть 0.6 — это
 * «положе 53° к нормали». В лоб снаряд взрывается, чтобы пальба в стену наугад
 * не заменяла прицеливание.
 *
 * Вся геометрия карты выровнена по осям, поэтому |cos| по каждой оси у снаряда
 * постоянен: если он рикошетит от стен вдоль X, то от стен вдоль Z уже никогда.
 * Побочное следствие порога ниже 0.71: развернуться назад в углу снаряд не может.
 */
export const RICOCHET_MAX_COS = 0.6;

/** Сколько раз снаряд может отскочить; следующее касание — взрыв. */
export const MAX_BOUNCES = 2;

/** Доля скорости, остающаяся после отскока. */
export const RICOCHET_SPEED_KEEP = 0.85;

export const RELOAD_S = 1.6;
export const RESPAWN_S = 4;

/** Потолок числа снарядов в мире — страховка, а не игровое ограничение. */
export const MAX_SHELLS = 120;

// --- Режимы ---

/** Все против всех: бесконечная перестрелка, respawn через RESPAWN_S. */
export const MODE_DM = 'dm';
/** Все против ботов: волны, одна жизнь на волну. */
export const MODE_PVE = 'pve';
export type GameMode = typeof MODE_DM | typeof MODE_PVE;

export function isMode(v: unknown): v is GameMode {
  return v === MODE_DM || v === MODE_PVE;
}

/** Четыре уровня сложности; индекс — он же стартовый тир ботов. */
export const DIFFICULTY_NAMES = ['Новичок', 'Средний', 'Ветеран', 'Ас'];
export const MAX_TIER = DIFFICULTY_NAMES.length - 1;

// --- Волны ---

/**
 * Потолок ботов на карте. Считаны они дёшево, но 12 танков на 140-метровом
 * квадрате — уже толчея, дальше волна растёт не числом, а тиром.
 */
export const BOT_LIMIT = 12;

/** Сколько ботов всего выйдет за волну N (нумерация с 1). */
export function waveQuota(wave: number): number {
  return 4 + 2 * (wave - 1);
}

/**
 * Сколько ботов приходится на одного живого человека. На карте в 140 метров
 * четверо, доехавших до тебя разом, побеждают не игрой, а числом: увернуться
 * уже негде. Поэтому карту наполняем по числу игроков, а волна растёт квотой
 * и выучкой противника, а не толпой.
 */
export const BOTS_PER_HUMAN = 3;

/** Сколько ботов волны N живут на карте одновременно: квота выпускается порциями. */
export function waveConcurrent(wave: number, humans: number): number {
  return Math.max(1, Math.min(BOT_LIMIT, 4 + wave, humans * BOTS_PER_HUMAN));
}

/**
 * Тир ботов волны N при выбранной сложности. Ботов больше 12 не станет,
 * поэтому после середины забега волна усиливается только качеством противника.
 */
export function waveTier(wave: number, difficulty: number): number {
  return Math.min(MAX_TIER, difficulty + Math.floor((wave - 1) / WAVE_TIER_STEP));
}

/** Через сколько волн тир поднимается на ступень. */
export const WAVE_TIER_STEP = 2;

/**
 * Доля «элиты» в волне — ботов на тир выше остальных. Растёт с номером волны,
 * чтобы усиление шло плавно, а не ступенькой раз в две волны.
 */
export function waveElite(wave: number): number {
  return Math.min(0.5, (wave - 1) * 0.06);
}

/** Пауза между появлением соседних ботов волны, с. */
export const WAVE_SPAWN_DELAY_S = 2.2;
/** Первые двое выходят почти сразу, иначе волна начинается с пустой карты. */
export const WAVE_OPENING_BOTS = 2;
/** Передышка между волнами: в ней возрождаются все павшие союзники, с. */
export const WAVE_BREAK_S = 5;
/** Сколько висит экран проигрыша до автоматического рестарта с первой волны, с. */
export const WAVE_OVER_S = 8;

// --- Бонусы ---

/**
 * Ящики на карте: подъехал — усилился. Включаются хостом и работают в обоих режимах.
 * Виды идут индексами: они же — биты в маске активных эффектов в снапшоте.
 */
export const BONUS_HEAL = 0;
export const BONUS_DAMAGE = 1;
export const BONUS_RELOAD = 2;
export const BONUS_SPEED = 3;
export const BONUS_STEALTH = 4;
export const BONUS_KINDS = 5;

export const BONUS_NAMES = ['Ремонт', 'Урон', 'Заряжание', 'Ход', 'Маскировка'];

/** Сколько HP возвращает «Ремонт». Действует мгновенно, поэтому длительности нет. */
export const BONUS_HEAL_HP = 50;
/** Урон снаряда 25 -> 40. */
export const BONUS_DAMAGE_MUL = 1.6;
/** Перезарядка 1.6 -> 0.8 с. */
export const BONUS_RELOAD_MUL = 0.5;
/** Максимальная скорость и разгон +40%. */
export const BONUS_SPEED_MUL = 1.4;
/**
 * Дальше этого замаскированный танк не подписан ником и не берётся ботами в цель.
 * Не невидимость: вплотную его видно, иначе бонус превращался бы в неуязвимость.
 */
export const BONUS_STEALTH_RANGE = 22;

/** Сколько держится эффект каждого вида, с. У «Ремонта» длительности нет. */
export const BONUS_DURATION_S = [0, 20, 20, 20, 15];

/** Как часто на карте появляется новый ящик, с. */
export const BONUS_SPAWN_S = 12;
/** Сколько ящиков лежит одновременно. */
export const BONUS_MAX = 5;
/** Радиус подбора, м. */
export const BONUS_RADIUS = 3.2;
/** Сколько ящик лежит, если его не подобрали, с. */
export const BONUS_LIFETIME_S = 45;

/** Активен ли эффект в маске снапшота. */
export function hasEffect(mask: number, kind: number): boolean {
  return (mask & (1 << kind)) !== 0;
}

// --- Сеть ---
export const MAX_NAME_LEN = 16;
/** Максимум инпутов в очереди игрока (защита от «ускорения» пачкой пакетов). */
export const MAX_INPUT_QUEUE = 10;
