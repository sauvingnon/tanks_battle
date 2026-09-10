/**
 * Числа, задающие вид картинки: свет, экспозиция, свечение.
 *
 * Собраны в одном месте не для порядка, а потому что они связаны арифметикой.
 * Порог свечения сравнивается с линейной яркостью кадра, а яркость кадра задаёт
 * сила света. Разнеси их — и правка освещения тихо утащит за порог половину
 * карты, а заметно это станет только на чужом мониторе.
 */

/**
 * Яркость сцены. Крутить эти четыре числа, если картинка кажется тёмной или
 * пересвеченной; оттенки света задаются отдельно и их менять не нужно.
 */
export const EXPOSURE = 1.3; // общая экспозиция поверх тонмаппинга
export const SUN_INTENSITY = 2.85; // прямой свет: даёт блики и тени
export const AMBIENT_INTENSITY = 2.2; // заполняющий свет: насколько черны тени
export const FILL_INTENSITY = 0.72; // подсветка с теневой стороны

// --- Свечение ---

export const BLOOM_STRENGTH = 0.62;
export const BLOOM_RADIUS = 0.5;

/**
 * Порог свечения.
 *
 * Считается по линейной яркости кадра **до** тонмаппинга, а не по тому,
 * насколько ярким цвет выглядит на глаз. Разница решающая: жёлтый снаряд
 * 0xffd27a даёт всего 0.69, а освещённая солнцем броня — около 0.31. То есть
 * «яркий» цвет сам по себе порог не берёт, и подбирать порог между ними значило
 * бы балансировать в полосе шириной 0.4, где любая правка света всё ломает.
 *
 * Поэтому порог стоит на каноничной единице — «ярче белого», — а то, что должно
 * светиться, поднимается над ней намеренно, множителем glow. Светится ровно то,
 * что светится само: трассер, дульная вспышка, взрыв, ящик бонуса.
 */
export const BLOOM_THRESHOLD = 1;

/** Во сколько раз поднят цвет каждого источника, чтобы перешагнуть порог. */
export const GLOW_SHELL = 2.6;
export const GLOW_TRACER = 3;
export const GLOW_MUZZLE = 2.4;
export const GLOW_BOOM = 2.6;
export const GLOW_KILL = 3;
export const GLOW_RICOCHET = 2.4;
/** Ящик бонуса светится собственным цветом — это множитель его emissive. */
export const GLOW_BONUS = 1.6;

// --- Палитра ---

/** Цвета корпусов; сервер присылает индекс в этой палитре. */
export const PALETTE = [
  0x4f7d5a, 0x7a5f9c, 0xa8632f, 0x3f6f96, 0x8a8f3a, 0x9c4a52, 0x3f8f88, 0x8a6a44,
];

/** Цвета ящиков: ремонт, урон, заряжание, ход, маскировка. Светятся намеренно. */
export const BONUS_COLORS = [
  0x6ad46a,
  0xff7a4d,
  0xffd24d,
  0x4db8ff,
  0xb388ff,
  0xd8e2ef,
  0xf05a5a,
  0xffc857,
  0x5ce1e6,
];

export const COLOR_GROUND = 0x39412f;
export const COLOR_WALL = 0x4a5160;
export const COLOR_BOX = 0x6d6357;
/**
 * Низкое укрытие — кластер приглушённых фасеточных листьев (см. Scene3D.buildBush):
 * палитра тонов на экземпляр, а не один цвет на блок — так куст поддерживает
 * низкополигональный стиль карты и не выглядит ярким воксельным пятном.
 * «Сквозь это простреливается» по-прежнему решает высота блока
 * (h < SHELL_HEIGHT), цвет тут не игровой сигнал, а вид объекта.
 */
export const LEAF_COLORS = [0x3f6538, 0x4f7740, 0x304f31, 0x5b8146];
export const COLOR_TRACK = 0x23262b;
export const COLOR_METAL = 0x3a3f47;

/**
 * Декоративная разбивка «полных» укрытий (h ≥ SHELL_HEIGHT) по силуэту: стены
 * остаются COLOR_BOX, из квадратных блоков покрупнее лепится домик, из мелких —
 * ящик. Ни один из трёх не меняет игровую механику — она вся уже решена высотой
 * блока, эта палитра только про то, как он выглядит.
 */
export const COLOR_HOUSE_WALL = 0x9c8f6e;
export const COLOR_ROOF = 0x5c3a30;
export const COLOR_CRATE = 0x7d5a36;
export const COLOR_ROAD = 0x2d3336;
export const COLOR_SIDEWALK = 0x77766d;
export const COLOR_CAR = 0x8c4e3e;
export const COLOR_TREE_TRUNK = 0x5b4632;
export const TREE_LEAF_COLORS = [0x355d38, 0x416f3d, 0x2d5233];

/**
 * Всё, что красится обычной краской и светиться не должно. Список нужен не для
 * рисования, а для проверки: добавь сюда что-нибудь заметно светлее прежнего —
 * и стенд сразу скажет, что оно полезло за порог свечения.
 */
export const PAINTED_COLORS = [
  ...PALETTE,
  ...LEAF_COLORS,
  COLOR_GROUND,
  COLOR_WALL,
  COLOR_BOX,
  COLOR_TRACK,
  COLOR_METAL,
  COLOR_HOUSE_WALL,
  COLOR_ROOF,
  COLOR_CRATE,
  COLOR_ROAD,
  COLOR_SIDEWALK,
  COLOR_CAR,
  COLOR_TREE_TRUNK,
  ...TREE_LEAF_COLORS,
];

/** sRGB -> линейное пространство, в котором и живёт вся арифметика света. */
function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/** Линейная яркость цвета, поднятого в gain раз: ровно то, что видит порог. */
export function linearLuminance(hex: number, gain = 1): number {
  const r = toLinear(((hex >> 16) & 255) / 255) * gain;
  const g = toLinear(((hex >> 8) & 255) / 255) * gain;
  const b = toLinear((hex & 255) / 255) * gain;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Оценка яркости обычной, ничем не светящейся поверхности с такой краской под
 * этим светом: диффузное отражение по Ламберту, солнце бьёт в лоб.
 *
 * Заливка в сумму не входит намеренно: она стоит с противоположной стороны
 * сцены, и одна и та же грань не может ловить обе разом. Небо входит всегда —
 * оно светит отовсюду. Это и есть худший случай для настоящей грани.
 */
export function litLuminance(albedoHex: number): number {
  const light = SUN_INTENSITY + AMBIENT_INTENSITY;
  return (linearLuminance(albedoHex) * light) / Math.PI;
}
