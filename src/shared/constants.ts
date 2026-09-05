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

// --- Сеть ---
export const MAX_NAME_LEN = 16;
/** Максимум инпутов в очереди игрока (защита от «ускорения» пачкой пакетов). */
export const MAX_INPUT_QUEUE = 10;
