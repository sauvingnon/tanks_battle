/**
 * Геометрия танка: корпус с наклонными листами, ходовая с катками и ленивцами,
 * башня с маской и дульным тормозом.
 *
 * Собирается из примитивов и **сливается в восемь геометрий по материалам**, а не
 * ставится двумя десятками мешей. Разница считается в вызовах отрисовки: два
 * десятка мешей на танк при дюжине танков — это шестьсот вызовов за кадр, да
 * ещё столько же в проход теней. После слияния их восемь на танк, а деталей на
 * порядок больше при всё ещё небольшом числе вызовов отрисовки.
 *
 * Слить всё в одну геометрию нельзя, и границы здесь не эстетические:
 * ходовая красится в свой тёмный цвет, металл — в свой, а ствол обязан ездить
 * отдельно от башни, иначе не сыграть откат.
 *
 * Все размеры подобраны под уже существующие: корпус той же длины и ширины,
 * траки на тех же местах. Танк должен читаться как тот же самый — меняется
 * детализация, а не силуэт, по которому игрок оценивает расстояние.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { MUZZLE_OFFSET, SHELL_HEIGHT } from '../shared/constants.js';
import { scaleBoxUv } from './textures.js';

/** Метров на клетку текстуры брони: мельче земли, крупнее не нужно. */
const ARMOR_TILE = 2;

/** Насколько трак отнесён от оси корпуса. Тот же, что и у следов на земле. */
export const TRACK_SIDE = 1.5;
/** Полка корпуса уже ходовой: не должна закрывать сверху подвижную ленту. */
const HULL_SHELF_SIDE = 1.45;
/** Брызговик поднят над увеличенной лентой, чтобы не пересекаться с ней при крене. */
const HULL_SHELF_Y = 1.3;

/** Высота погона башни над новой низкой палубой корпуса. */
export const TURRET_Y = 1.4;
/** Центр канала ствола: обязан совпадать с фиксированной высотой снаряда. */
export const MUZZLE_Y = SHELL_HEIGHT - TURRET_Y;

/** Штатное положение ствола внутри башни по оси Z. */
export const BARREL_Z = 2.3;
/** Дульный тормоз: центр и длина. */
const BRAKE_LENGTH = 0.48;
const BRAKE_Z = MUZZLE_OFFSET - BRAKE_LENGTH / 2;

/**
 * Дульный срез в координатах башни. Выведен из тех же чисел, что и сама
 * геометрия, а не записан отдельно: от него ставится вспышка выстрела, и стоит
 * подвинуть тормоз, как посчитанная руками константа молча утащит вспышку
 * внутрь ствола или подвесит в воздухе. Стенд сверяет её с границей геометрии.
 */
export const MUZZLE_TIP_Z = MUZZLE_OFFSET;

/** Сколько настоящих звеньев видно на одной гусенице. Два InstancedMesh на танк. */
export const TRACK_LINK_COUNT = 22;

const TRACK_FRONT_Z = 1.68;
const TRACK_REAR_Z = -1.68;
const TRACK_FRONT_CENTER_Y = 0.64;
const TRACK_REAR_CENTER_Y = 0.56;
const TRACK_FRONT_RADIUS = 0.46;
const TRACK_REAR_RADIUS = 0.34;
const TRACK_ROAD_WHEEL_Y = 0.48;
const TRACK_FRONT_TOP_Y = TRACK_FRONT_CENTER_Y + TRACK_FRONT_RADIUS;
const TRACK_FRONT_BOTTOM_Y = TRACK_FRONT_CENTER_Y - TRACK_FRONT_RADIUS;
const TRACK_REAR_TOP_Y = TRACK_REAR_CENTER_Y + TRACK_REAR_RADIUS;
const TRACK_REAR_BOTTOM_Y = TRACK_REAR_CENTER_Y - TRACK_REAR_RADIUS;
const TRACK_TOP_LENGTH = Math.hypot(TRACK_FRONT_Z - TRACK_REAR_Z, TRACK_FRONT_TOP_Y - TRACK_REAR_TOP_Y);
const TRACK_BOTTOM_LENGTH = Math.hypot(TRACK_FRONT_Z - TRACK_REAR_Z, TRACK_FRONT_BOTTOM_Y - TRACK_REAR_BOTTOM_Y);
const TRACK_FRONT_ARC = Math.PI * TRACK_FRONT_RADIUS;
const TRACK_REAR_ARC = Math.PI * TRACK_REAR_RADIUS;
const TRACK_LOOP = TRACK_TOP_LENGTH + TRACK_FRONT_ARC + TRACK_BOTTOM_LENGTH + TRACK_REAR_ARC;

/**
 * Ставит звено на замкнутый контур гусеницы. Верх и низ идут вдоль Z, а у
 * ведущего колеса и ленивца звенья идут плавной дугой. Это настоящая кинематика
 * ленты, но матрицы обновляются только при движении танка.
 */
export function placeTrackLink(
  target: THREE.Object3D,
  index: number,
  phase: number,
  side: number,
): void {
  let distance = (phase + (index / TRACK_LINK_COUNT) * TRACK_LOOP) % TRACK_LOOP;
  if (distance < 0) distance += TRACK_LOOP;
  let y = TRACK_REAR_TOP_Y;
  let z = TRACK_REAR_Z;
  let pitch = 0;
  if (distance < TRACK_TOP_LENGTH) {
    const t = distance / TRACK_TOP_LENGTH;
    z = TRACK_REAR_Z + (TRACK_FRONT_Z - TRACK_REAR_Z) * t;
    y = TRACK_REAR_TOP_Y + (TRACK_FRONT_TOP_Y - TRACK_REAR_TOP_Y) * t;
    pitch = -Math.atan2(TRACK_FRONT_TOP_Y - TRACK_REAR_TOP_Y, TRACK_FRONT_Z - TRACK_REAR_Z);
  } else if ((distance -= TRACK_TOP_LENGTH) < TRACK_FRONT_ARC) {
    const theta = Math.PI / 2 - distance / TRACK_FRONT_RADIUS;
    z = TRACK_FRONT_Z + Math.cos(theta) * TRACK_FRONT_RADIUS;
    y = TRACK_FRONT_CENTER_Y + Math.sin(theta) * TRACK_FRONT_RADIUS;
    pitch = Math.PI / 2 - theta;
  } else if ((distance -= TRACK_FRONT_ARC) < TRACK_BOTTOM_LENGTH) {
    const t = distance / TRACK_BOTTOM_LENGTH;
    z = TRACK_FRONT_Z + (TRACK_REAR_Z - TRACK_FRONT_Z) * t;
    y = TRACK_FRONT_BOTTOM_Y + (TRACK_REAR_BOTTOM_Y - TRACK_FRONT_BOTTOM_Y) * t;
    pitch = Math.PI + Math.atan2(TRACK_REAR_BOTTOM_Y - TRACK_FRONT_BOTTOM_Y, TRACK_FRONT_Z - TRACK_REAR_Z);
  } else {
    distance -= TRACK_BOTTOM_LENGTH;
    const theta = -Math.PI / 2 + distance / TRACK_REAR_RADIUS;
    z = TRACK_REAR_Z - Math.cos(theta) * TRACK_REAR_RADIUS;
    y = TRACK_REAR_CENTER_Y + Math.sin(theta) * TRACK_REAR_RADIUS;
    pitch = theta - Math.PI / 2;
  }
  // Подвижная лента сидит поверх катков, ближе к корпусу, а не висит отдельной
  // полосой снаружи. Так звенья читаются как часть ходовой при движении.
  target.position.set(side * TRACK_SIDE, y, z);
  target.rotation.set(pitch, 0, 0);
}

/**
 * Бронелист с мягкой фаской. Один сегмент оставляет грани заметными, но убирает
 * ощущение собранного из идеальных кубиков танка. Размеры и границы сохраняются.
 */
function box(w: number, h: number, d: number): THREE.BoxGeometry {
  const bevel = Math.min(Math.min(w, h, d) * 0.28, 0.16);
  const geometry = new RoundedBoxGeometry(w, h, d, 1, Math.max(0.025, bevel));
  scaleBoxUv(geometry, w, h, d, ARMOR_TILE);
  return geometry;
}

/** Цилиндр, положенный на бок вдоль оси X: каток, ленивец, маска. */
function wheel(radius: number, width: number, segments = 14): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius, width, segments);
  geometry.rotateZ(Math.PI / 2);
  // Rounded броня выше уже non-indexed; приводим катки к тому же виду,
  // чтобы mergeGeometries мог слить ходовую в один draw call.
  return geometry.toNonIndexed();
}

function at(geometry: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  geometry.translate(x, y, z);
  return geometry;
}

export interface TankGeometry {
  /** Корпус: красится в цвет команды. */
  hull: THREE.BufferGeometry;
  /** Ходовая: подложка ленты, катки, ленивцы. Тёмная, своего материала. */
  running: THREE.BufferGeometry;
  /** Катки и ленивцы: чуть светлее ленты, чтобы механика читалась отдельно. */
  wheels: THREE.BufferGeometry;
  /** Одно звено внешней ленты: рисуется инстансами и реально едет по контуру. */
  trackLink: THREE.BufferGeometry;
  /** Небольшие металлические детали на корпусе: фары, решётки, буксиры. */
  hullMetal: THREE.BufferGeometry;
  /** Башня без металлических частей, тоже в цвет команды. */
  turret: THREE.BufferGeometry;
  /** Маска, командирская башенка: металл. */
  turretMetal: THREE.BufferGeometry;
  /** Ствол с дульным тормозом. Отдельно от всего: по нему играется откат. */
  barrel: THREE.BufferGeometry;
}

/**
 * Собирает геометрию один раз на всю игру: она общая для всех танков, разница
 * между ними только в цвете материала.
 */
export function buildTankGeometry(): TankGeometry {
  const hull = mergeGeometries([
    // Клиновидный корпус: низкий нос, приподнятая палуба и явная кормовая
    // ниша. Носовая кромка теперь читается даже когда ствол смотрит в сторону.
    at(box(2.5, 0.46, 3.72), 0, 0.93, 0),
    at(tilted(box(2.4, 0.72, 0.16), -0.34), 0, 1.12, 1.83),
    at(box(2.18, 0.22, 0.28), 0, 0.69, 1.82),
    at(box(2.12, 0.28, 1.84), 0, 1.3, 0.15),
    at(box(2.22, 0.24, 1.2), 0, 1.36, -1.22),
    // Отдельная плоская кормовая броня противопоставляет зад лобовой наклонной
    // плите и не даёт корпусу выглядеть одинаковым с обеих сторон.
    at(box(2.16, 0.28, 0.18), 0, 0.84, -1.82),
    // Узкие полки над лентой, не перекрывающие сами траки со стороны камеры.
    at(box(0.54, 0.12, 3.82), HULL_SHELF_SIDE, HULL_SHELF_Y, 0),
    at(box(0.54, 0.12, 3.82), -HULL_SHELF_SIDE, HULL_SHELF_Y, 0),
    // Две боковые ячейки и небольшой ящик ЗИП оживляют корму.
    at(box(0.44, 0.22, 0.78), -1.17, 1.3, -1.2),
    at(box(0.44, 0.22, 0.78), 1.17, 1.3, -1.2),
  ]);

  const running: THREE.BufferGeometry[] = [];
  const wheels: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const x = side * TRACK_SIDE;
    // Матовая подложка уходит за подвижные звенья и держит тёмный контур ленты.
    running.push(at(box(0.32, 0.6, 3.62), x, 0.55, 0));
    // Спереди крупная ведущая звёздочка, сзади заметно меньший ленивец —
    // ходовая сама подсказывает направление движения даже без ствола в кадре.
    wheels.push(at(wheel(TRACK_FRONT_RADIUS, 0.54), x, TRACK_FRONT_CENTER_Y, TRACK_FRONT_Z));
    wheels.push(at(wheel(TRACK_REAR_RADIUS, 0.5), x, TRACK_REAR_CENTER_Y, TRACK_REAR_Z));
    // Опорные катки лежат внутри нижней ветви ленты, а не ниже неё: после
    // увеличения передней звёздочки старое y = 0.38 визуально проваливало их.
    for (const z of [-1.08, -0.36, 0.36, 1.08]) {
      wheels.push(at(wheel(0.28, 0.48, 12), x, TRACK_ROAD_WHEEL_Y, z));
    }
  }

  // Металлические акценты корпуса. Они маленькие, но дают танку «сборку»:
  // фары и бампер впереди, буксирные проушины и моторная решётка сзади.
  const hullMetal = mergeGeometries([
    at(box(0.22, 0.13, 0.24), -0.86, 1.26, 1.92),
    at(box(0.22, 0.13, 0.24), 0.86, 1.26, 1.92),
    at(box(0.14, 0.12, 0.42), -0.92, 1.14, 1.8),
    at(box(0.14, 0.12, 0.42), 0.92, 1.14, 1.8),
    at(box(1.7, 0.12, 0.12), 0, 0.72, 1.96),
    ...[-0.62, -0.2, 0.2, 0.62].map((x) => at(box(0.13, 0.07, 0.62), x, 1.51, -1.2)),
    at(box(1.55, 0.12, 0.14), 0, 0.86, -1.92),
    at(new THREE.CylinderGeometry(0.13, 0.13, 0.36, 10).toNonIndexed(), -0.78, 1.43, -1.68),
    at(new THREE.CylinderGeometry(0.13, 0.13, 0.36, 10).toNonIndexed(), 0.78, 1.43, -1.68),
  ]);

  // Дальше всё в координатах башни: её узел сидит на высоте TURRET_Y.
  const turret = mergeGeometries([
    // Основной объём башни поднимается до линии орудия: ствол проходит через
    // броню, а не висит над низкой коробкой.
    at(box(1.8, 0.68, 1.4), 0, 0.34, -0.05),
    at(tilted(box(1.62, 0.42, 0.2), -0.32), 0, 0.43, 0.76),
    // Кормовой модуль намеренно поднят и чуть отодвинут назад: он парит над
    // основной башней отдельной навесной бронёй, а не сливается с ней коробкой.
    at(box(1.46, 0.24, 0.64), 0, 0.6, -1.12),
    // Небольшая крыша связывает командирские детали с бронёй, без зазоров.
    at(box(1.28, 0.12, 0.84), 0, 0.68, -0.2),
    // Одна компактная маска вокруг оси орудия вместо двух высоких щитов.
    at(tilted(box(1.02, 0.34, 0.28), -0.12), 0, MUZZLE_Y - 0.04, 0.86),
  ]);

  const turretMetal = mergeGeometries([
    // Под единой маской видна компактная цапфа, а не вторая самостоятельная
    // маска, поэтому казённик читается частью башни.
    at(alongZ(new THREE.CylinderGeometry(0.24, 0.24, 0.24, 12)), 0, MUZZLE_Y, 1.04),
    at(new THREE.CylinderGeometry(0.3, 0.3, 0.16, 12), 0.48, 0.75, -0.2),
    // Люк и прицел на крыше башни.
    at(new THREE.CylinderGeometry(0.3, 0.3, 0.06, 12), -0.42, 0.75, -0.22),
    // Здесь оставляем обычный индексированный куб: он сливается с цилиндрами
    // маски без промежуточной конвертации и всё равно почти не виден сверху.
    at(new THREE.BoxGeometry(0.12, 0.12, 0.24), -0.42, 0.83, -0.22),
    // Два компактных блока дымовых гранат по бортам башни.
    at(new THREE.CylinderGeometry(0.1, 0.1, 0.25, 8), -0.7, 0.5, -0.58),
    at(new THREE.CylinderGeometry(0.1, 0.1, 0.25, 8), -0.48, 0.5, -0.68),
    at(new THREE.CylinderGeometry(0.1, 0.1, 0.25, 8), 0.7, 0.5, -0.58),
    at(new THREE.CylinderGeometry(0.1, 0.1, 0.25, 8), 0.48, 0.5, -0.68),
  ]);

  const barrel = mergeGeometries([
    // Низкий казённик, цельная труба и два тонких пояска — одно орудие,
    // собранное вокруг линии выстрела, без лишнего второго щита.
    at(alongZ(new THREE.CylinderGeometry(0.19, 0.16, 0.54, 12)), 0, MUZZLE_Y, 1.35),
    at(alongZ(new THREE.CylinderGeometry(0.12, 0.14, 2.56, 12)), 0, MUZZLE_Y, 2.82),
    at(alongZ(new THREE.CylinderGeometry(0.16, 0.16, 0.1, 12)), 0, MUZZLE_Y, 1.65),
    at(alongZ(new THREE.CylinderGeometry(0.16, 0.16, 0.1, 12)), 0, MUZZLE_Y, 3.62),
    // Конический дульный тормоз с широким основанием — продолжение гранёной
    // маски, а не случайный шарик на конце ствола.
    at(alongZ(new THREE.CylinderGeometry(0.19, 0.24, BRAKE_LENGTH, 12)), 0, MUZZLE_Y, BRAKE_Z),
  ]);

  return {
    hull,
    running: mergeGeometries(running),
    wheels: mergeGeometries(wheels),
    // Широкое звено накрывает всю ленту по борту: из верхнего ракурса гусеница
    // читается полосой, а не тонкой зубчатой ниткой под корпусом.
    trackLink: new THREE.BoxGeometry(0.56, 0.12, 0.34),
    hullMetal,
    turret,
    turretMetal,
    barrel,
  };
}

/** Кладёт цилиндр вдоль оси Z: так стоят ствол и маска. */
function alongZ(geometry: THREE.CylinderGeometry): THREE.CylinderGeometry {
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

/** Наклоняет лист вокруг поперечной оси: положительный угол кладёт верх назад. */
function tilted(geometry: THREE.BufferGeometry, angle: number): THREE.BufferGeometry {
  geometry.rotateX(angle);
  return geometry;
}
