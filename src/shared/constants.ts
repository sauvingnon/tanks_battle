// Единые константы симуляции. Их использует и сервер, и клиент (предсказание),
// поэтому менять значения можно только здесь.

/** Частота тика симуляции на сервере и шага предсказания на клиенте. */
export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;

/** Как часто сервер рассылает снапшоты (каждый N-й тик). */
export const SNAPSHOT_EVERY = 1;

/** Задержка интерполяции чужих танков, мс. Должна быть >= двух интервалов снапшота. */
export const INTERP_DELAY_MS = 100;

/**
 * Половина стороны карты по умолчанию: квадрат [-70, 70] — те самые 140×140,
 * на которых нарисованы все аркадные карты.
 *
 * Общей константой размер быть перестал: у карты он свой (`MapDef.half`), и
 * физика принимает его параметром. Здесь остался только этот исторический
 * размер — как значение по умолчанию для карт, которые ничего не просят.
 */
export const MAP_HALF = 70;

/** Радиус столкновений танка (танк считаем кругом сверху). */
export const TANK_RADIUS = 2.4;

/** Общий зажим. Здесь, а не в sim.ts, чтобы им мог пользоваться кто угодно без цикла импортов. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

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

/** Торможение о препятствие, м/с^2, при ударе точно в лоб: ход гаснет за 0.15 с. */
export const BUMP_DECEL = 90;

/**
 * Порог «лобовости» удара, ниже которого препятствие хода не отнимает вовсе.
 * Считается как проекция курса на нормаль грани: 0 — едем вдоль неё, 1 — в упор.
 * 0.6 — это примерно 37 градусов к грани.
 *
 * Раньше здесь стоял множитель скорости, и любое касание — хоть краем борта на
 * полном ходу вдоль стены — оставляло от хода четверть. Ехать вдоль грани было
 * нельзя: танк вставал от того, что задел её.
 *
 * Само скольжение обеспечивает выталкивание: оно двигает танк строго по нормали
 * и продольную составляющую хода не трогает. То есть останавливало танк у грани
 * ровно торможение — поэтому оно и считается теперь по углу, а не по факту
 * касания, и до порога не срабатывает совсем.
 */
export const BUMP_GRAZE = 0.6;

// --- Бой ---
export const MAX_HP = 1000;
export const SHELL_DAMAGE = 250; // четыре попадания = смерть

/**
 * Разброс урона снаряда: множитель берётся равномерно из [1 - SPREAD, 1 + SPREAD].
 * Урон больше не фиксирован — читается по выбитой цифре, а не по константе, и
 * одинаковое попадание каждый раз ощущается чуть иначе.
 */
export const SHELL_DAMAGE_SPREAD = 0.2;

/**
 * Зона попадания добавляет свой множитель поверх разброса: борт снаряд видит
 * под углом чаще, чем лоб или корму, поэтому его коэффициент — нейтральный.
 * Порог сектора тот же угол, что и у рикошета (45°), только считается не от
 * нормали грани, а от курса танка — cos между направлением снаряда и тем,
 * куда едет цель. Летит туда же, куда едет цель (cos → 1) — значит вошёл со
 * спины, летит навстречу (cos → -1) — в лоб.
 */
export const HIT_ZONE_COS = Math.SQRT1_2; // 45°
export const HIT_ZONE_FRONT_MUL = 0.85;
export const HIT_ZONE_SIDE_MUL = 1;
export const HIT_ZONE_REAR_MUL = 1.25;

/**
 * Здоровье бота. Их всегда больше, чем игроков, и на равном здоровье размен
 * получается заведомо не в пользу человека: чтобы снять одного бота, нужно
 * 4 попадания и 6.4 с перезарядки, а стреляют в это время по тебе втроём.
 * Три попадания вместо четырёх — четверть времени волны обратно игроку.
 */
export const BOT_HP = 750;

/**
 * Снаряд летит по прямой без гравитации: так попадание считается в 2D, а игроку
 * понятно, куда целиться. 62 м/с — карту в поперечнике проходит за 2.3 с,
 * то есть по едущему танку надо брать упреждение.
 */
export const SHELL_SPEED = 62;
export const SHELL_RADIUS = 0.3;
export const SHELL_LIFETIME = 3.5; // с
/** Высота полёта. Все препятствия на карте выше — значит укрытия работают. */
export const SHELL_HEIGHT = 1.82;
/** Вылет снаряда от центра танка, чуть дальше дульного среза. */
export const MUZZLE_OFFSET = 4.2;

/**
 * Высота остова подбитого танка, когда он временно становится препятствием
 * карты (см. Room.refreshWrecks). Выше SHELL_HEIGHT — труп держит выстрел,
 * как броневой блок, а не как низкое укрытие навылет.
 */
export const WRECK_HEIGHT = 2.5;
/** Физический след остова совпадает с ходовой модели, а не с радиусом живого танка. */
export const WRECK_COLLISION_W = 3.6;
export const WRECK_COLLISION_D = 4.4;
export const WRECK_TANK_COLLISION_RADIUS = 2.05;

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

// --- Таран ---

/**
 * Скорость сближения, ниже которой столкновение — просто толчок. Танки постоянно
 * трутся боками в свалке, и без порога любое касание считалось бы тараном.
 */
export const RAM_MIN_SPEED = 6;
/** Скорость сближения, на которой урон выходит на максимум. Это полный ход. */
export const RAM_FULL_SPEED = MAX_SPEED;
/**
 * Урон полного тарана. Чуть больше выстрела: разогнаться, попасть по едущей цели
 * корпусом и при этом самому не подставиться — заметно труднее, чем прицелиться.
 */
export const RAM_DAMAGE = 300;
/**
 * Доля урона, которую наезжающий ест в любом случае. Таран не должен быть
 * бесплатным приёмом: разменять 75 своих HP на 300 чужих выгодно, но не даром,
 * а лобовое сближение бьёт обоих почти поровну.
 */
export const RAM_SELF_SHARE = 0.25;
/**
 * Пауза между таранами для одного танка, с. Без неё касание длиной в полсекунды
 * било бы пятнадцать раз: расталкивание идёт каждый тик.
 */
export const RAM_COOLDOWN_S = 1;

/** Потолок числа снарядов в мире — страховка, а не игровое ограничение. */
export const MAX_SHELLS = 120;

// --- Режимы ---

/** Все против всех: бесконечная перестрелка, respawn через RESPAWN_S. */
export const MODE_DM = 'dm';
/** Все против ботов: волны, одна жизнь на волну. */
export const MODE_PVE = 'pve';
/** Забег на 15 волн с развитием танка между волнами. */
export const MODE_EXPEDITION = 'expedition';
/** Королевская битва: команды, одна жизнь и сжимающаяся зона. */
export const MODE_ROYALE = 'royale';
/** Командный бой: 5×5 или 10×10, одна жизнь на раунд, до уничтожения или до таймера. */
export const MODE_TEAM = 'team';
export type GameMode =
  | typeof MODE_DM
  | typeof MODE_PVE
  | typeof MODE_EXPEDITION
  | typeof MODE_ROYALE
  | typeof MODE_TEAM;

export function isMode(v: unknown): v is GameMode {
  return (
    v === MODE_DM || v === MODE_PVE || v === MODE_EXPEDITION || v === MODE_ROYALE || v === MODE_TEAM
  );
}

export const EXPEDITION_WAVES = 15;
export const EXPEDITION_UPGRADE_COUNT = 3;

/** Сила базового танка в экспедиции: сначала слабее, к финалу сильнее. */
export function expeditionPower(wave: number): number {
  if (wave <= 1) return 0.84;
  if (wave === 2) return 0.9;
  if (wave === 3) return 0.96;
  if (wave <= 5) return 1;
  return Math.min(1.5, 1 + (wave - 5) * 0.08);
}

export interface ExpeditionUpgrade {
  id: number;
  name: string;
  description: string;
  speed: number;
  damage: number;
  reload: number;
  health: number;
}

/** Фиксированный пул командных улучшений: один выбор действует до конца забега. */
export const EXPEDITION_UPGRADES: ExpeditionUpgrade[] = [
  // Каждая карточка должна ощущаться уже с первого выбора, но сочетания всё
  // ещё складываются постепенно, а не превращают первую половину забега в чит.
  { id: 0, name: 'Усиленная ходовая', description: '+20% скорость и ускорение', speed: 1.2, damage: 1, reload: 1, health: 1 },
  { id: 1, name: 'Стабилизатор', description: '+28% урон снаряда', speed: 1, damage: 1.28, reload: 1, health: 1 },
  { id: 2, name: 'Быстрый досылатель', description: '-25% перезарядка', speed: 1, damage: 1, reload: 0.75, health: 1 },
  { id: 3, name: 'Форсаж', description: '+18% скорость и ускорение', speed: 1.18, damage: 1, reload: 1, health: 1 },
  { id: 4, name: 'Тяжёлый боеприпас', description: '+24% урон снаряда', speed: 1, damage: 1.24, reload: 1, health: 1 },
  { id: 5, name: 'Бронекапсула', description: '+25% максимальное здоровье', speed: 1, damage: 1, reload: 1, health: 1.25 },
];

export function isCoopMode(mode: GameMode): boolean {
  return mode === MODE_PVE || mode === MODE_EXPEDITION;
}

/**
 * В королевской битве и в командном бою один номер команды означает союзников
 * (в скваде или в стороне 5×5/10×10) — в отличие от DM, где номер команды не
 * значит ничего, кроме «за кого играешь».
 */
export function isSquadMode(mode: GameMode): boolean {
  return mode === MODE_ROYALE || mode === MODE_TEAM;
}

// --- Командный бой ---

/** Размеры команды на выбор хоста: 5×5 или 10×10. */
export const TEAM_BATTLE_SIZES = [5, 10] as const;
export type TeamBattleSize = (typeof TEAM_BATTLE_SIZES)[number];

export function isTeamBattleSize(v: unknown): v is TeamBattleSize {
  return v === 5 || v === 10;
}

/** Раунд длится не дольше этого — дальше ничья, даже если бой не решён. */
export const TEAM_BATTLE_ROUND_S = 300;
/** Экран итогов раунда висит столько, прежде чем начнётся следующий раунд. */
export const TEAM_BATTLE_OVER_S = 12;

// --- Правила боя ---

/**
 * Правила — ось, независимая от режима. Режим отвечает за то, с кем дерёшься,
 * правила — за то, что игрок знает о мире, поэтому «все против всех» и «против
 * ботов» бывают и аркадными, и реалистичными.
 *
 * Аркада: над каждым танком ник и полоска HP. Кого рисует кадр — того и видно,
 * и видно про него всё.
 *
 * Реализм: подписей нет вовсе, кроме товарищей по команде. Дальше сюда же
 * лягут засвет и рельеф, но правило отбора уже сейчас одно и то же — знание о
 * противнике даётся не даром.
 */
export const RULES_ARCADE = 'arcade';
export const RULES_REAL = 'real';
export type Ruleset = typeof RULES_ARCADE | typeof RULES_REAL;

export function isRuleset(v: unknown): v is Ruleset {
  return v === RULES_ARCADE || v === RULES_REAL;
}

/**
 * Товарищи ли две команды. В «Все против всех» товарищей нет по определению:
 * номер команды там значит только «за кого играешь», огонь по своим включён, и
 * одинаковый номер союзником никого не делает. Поэтому «маркер товарища» в
 * реалистичных правилах загорается только в режиме против ботов.
 */
export function alliedTeams(mode: GameMode, a: number, b: number): boolean {
  return (isCoopMode(mode) || isSquadMode(mode)) && a === b;
}

// --- Королевская битва ---

/** Максимальный размер команды в первой версии режима. */
export const ROYALE_SQUAD_SIZE = 4;
/** Форматы отряда в BR: соло, дуо и полный сквад. */
export const ROYALE_SQUAD_SIZES = [1, 2, 4] as const;
export type RoyaleSquadSize = (typeof ROYALE_SQUAD_SIZES)[number];

export function isRoyaleSquadSize(v: unknown): v is RoyaleSquadSize {
  return v === 1 || v === 2 || v === 4;
}
/** Сколько команд всего заполняем ботами, если людей в комнате мало. */
export const ROYALE_SQUAD_COUNT = 4;
/** Короткий предстартовый отсчёт после заполнения состава BR. */
export const ROYALE_START_COUNTDOWN_S = 5;
export const ROYALE_ZONE_START_WAIT_S = 45;
export const ROYALE_ZONE_SHRINK_S = 35;
export const ROYALE_ZONE_REST_S = 28;
export const ROYALE_ZONE_FINAL_RADIUS = 22;
export const ROYALE_ZONE_DAMAGE_S = [28, 42, 62, 90, 130] as const;
/** Дальность обычного визуального засвета цели в BR, м. */
export const ROYALE_SIGHT_RANGE = 145;
/** Дальность краткого раскрытия после выстрела в BR, м. */
export const ROYALE_SHOT_REVEAL_RANGE = 190;

/** Четыре уровня сложности; индекс — он же стартовый тир ботов. */
export const DIFFICULTY_NAMES = ['Новичок', 'Средний', 'Ветеран', 'Ас'];
export const MAX_TIER = DIFFICULTY_NAMES.length - 1;

/**
 * Манера боя — ручка, независимая от сложности. Сложность отвечает за выучку
 * (реакция, точность, упреждение), манера — за дистанцию и за право лезть в упор.
 * Разводить их приходится потому, что ощущаются они по-разному: «Ас» издали
 * страшен точностью, «Новичок» в упор — тем, что от него некуда деться.
 */
export const STANCE_NAMES = ['Дистанция', 'Нейтрал', 'Напор'];
export const STANCE_NEUTRAL = 1;
export const STANCE_COUNT = STANCE_NAMES.length;

export function isStance(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < STANCE_COUNT;
}

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
 * Сколько ботов приходится на одного живого человека — по уровню сложности.
 * Численный перевес человек отыграть не может в принципе: перезарядка у всех
 * одна, и двое-трое стреляют в тебя ровно во столько же раз чаще, чем ты в них.
 * Поэтому толпа — это и есть сложность, а не декорация к ней.
 *
 * Пробное снижение (было [2, 2, 3, 3]): жалоба была на то, что уже на «Среднем»
 * вязнешь, а на «Ветеране»/«Асе» толпа гасит почти всегда — причём и в одиночку
 * тоже, не только вдвоём-втроём. Первая правка ([1.5, 1.5, 2, 2.5]) одиночку
 * почти не облегчила: потолок в `waveConcurrent` — это `alive < room`, а он на
 * практике равен `ceil(room)`, то есть 1.5 и 2 дают один и тот же максимум
 * одновременных ботов (2). Реальный шаг вниз для соло — только через целое
 * значение или через переход на следующий целый порог. Числа ниже подобраны по
 * `ceil(humans · perHuman)`, не по самому множителю.
 *
 * Тут же лежит отдельный баг — множитель берётся от числа подключённых людей, а
 * не живых, поэтому смерть одного из друзей посреди волны потолок ботов не
 * снижает: оставшиеся отвечают за того же вчетверо-впятеро, что и был весь
 * отряд. Это ещё не тронуто, только сами числа.
 */
export const BOTS_PER_HUMAN = [1, 1, 1.5, 2];

/** Сколько ботов волны N живут на карте одновременно: квота выпускается порциями. */
export function waveConcurrent(wave: number, humans: number, difficulty = 0): number {
  const perHuman = BOTS_PER_HUMAN[clampTier(difficulty)];
  return Math.max(1, Math.min(BOT_LIMIT, 4 + wave, humans * perHuman));
}

function clampTier(tier: number): number {
  return Math.max(0, Math.min(MAX_TIER, Math.round(tier)));
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
export const BONUS_HEAL_HP = 500;
/** Урон снаряда 250 -> 400. */
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

// --- Лут королевской битвы ---

/** В BR контейнеры не дают таймерные эффекты: модуль действует до конца матча. */
export const ROYALE_LOOT_ARMOR = BONUS_KINDS;
export const ROYALE_LOOT_DAMAGE = BONUS_KINDS + 1;
export const ROYALE_LOOT_RELOAD = BONUS_KINDS + 2;
export const ROYALE_LOOT_SPEED = BONUS_KINDS + 3;
export const ROYALE_LOOT_NAMES: Record<number, string> = {
  [BONUS_HEAL]: 'Ремкомплект',
  [ROYALE_LOOT_ARMOR]: 'Бронепластины',
  [ROYALE_LOOT_DAMAGE]: 'Модуль орудия',
  [ROYALE_LOOT_RELOAD]: 'Механизм заряжания',
  [ROYALE_LOOT_SPEED]: 'Модуль двигателя',
};

/** Один подобранный модуль заметно меняет танк, но не превращает его в другой класс. */
export const ROYALE_LOOT_ARMOR_HP = 300;
export const ROYALE_LOOT_DAMAGE_MUL = 1.25;
export const ROYALE_LOOT_RELOAD_MUL = 0.78;
export const ROYALE_LOOT_SPEED_MUL = 1.18;

/** Активен ли эффект в маске снапшота. */
export function hasEffect(mask: number, kind: number): boolean {
  return (mask & (1 << kind)) !== 0;
}

// --- Сеть ---
export const MAX_NAME_LEN = 16;
/** Максимум инпутов в очереди игрока (защита от «ускорения» пачкой пакетов). */
export const MAX_INPUT_QUEUE = 10;
