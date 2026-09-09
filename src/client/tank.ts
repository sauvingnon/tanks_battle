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
export const TRACK_SIDE = 1.7;
/** Полка корпуса уже ходовой: не должна закрывать сверху подвижную ленту. */
const HULL_SHELF_SIDE = 1.45;

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

const TRACK_TOP_Y = 1.04;
const TRACK_BOTTOM_Y = 0.18;
const TRACK_CENTER_Y = (TRACK_TOP_Y + TRACK_BOTTOM_Y) / 2;
const TRACK_RADIUS = (TRACK_TOP_Y - TRACK_BOTTOM_Y) / 2;
const TRACK_TANGENT_Z = 1.65;
const TRACK_STRAIGHT = TRACK_TANGENT_Z * 2;
const TRACK_ARC = Math.PI * TRACK_RADIUS;
const TRACK_LOOP = TRACK_STRAIGHT * 2 + TRACK_ARC * 2;

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
  let y = TRACK_TOP_Y;
  let z = -TRACK_TANGENT_Z;
  let pitch = 0;
  if (distance < TRACK_STRAIGHT) {
    z += distance;
  } else if ((distance -= TRACK_STRAIGHT) < TRACK_ARC) {
    const theta = Math.PI / 2 - distance / TRACK_RADIUS;
    z = TRACK_TANGENT_Z + Math.cos(theta) * TRACK_RADIUS;
    y = TRACK_CENTER_Y + Math.sin(theta) * TRACK_RADIUS;
    pitch = Math.PI / 2 - theta;
  } else if ((distance -= TRACK_ARC) < TRACK_STRAIGHT) {
    z = TRACK_TANGENT_Z - distance;
    y = TRACK_BOTTOM_Y;
  } else {
    distance -= TRACK_STRAIGHT;
    const theta = -Math.PI / 2 + distance / TRACK_RADIUS;
    z = -TRACK_TANGENT_Z - Math.cos(theta) * TRACK_RADIUS;
    y = TRACK_CENTER_Y + Math.sin(theta) * TRACK_RADIUS;
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
    // ниша. Старый набор параллельных коробок заменён на один читаемый силуэт.
    at(box(2.5, 0.46, 3.72), 0, 0.93, 0),
    at(tilted(box(2.4, 0.72, 0.16), -0.34), 0, 1.12, 1.83),
    at(box(2.12, 0.28, 1.84), 0, 1.3, 0.15),
    at(box(2.22, 0.24, 1.2), 0, 1.36, -1.22),
    // Узкие полки над лентой, не перекрывающие сами траки со стороны камеры.
    at(box(0.54, 0.12, 3.82), HULL_SHELF_SIDE, 1.18, 0),
    at(box(0.54, 0.12, 3.82), -HULL_SHELF_SIDE, 1.18, 0),
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
    wheels.push(at(wheel(0.43, 0.52), x, 0.55, 1.68));
    wheels.push(at(wheel(0.43, 0.52), x, 0.55, -1.68));
    for (const z of [-1.08, -0.36, 0.36, 1.08]) wheels.push(at(wheel(0.28, 0.48, 12), x, 0.38, z));
  }

  // Металлические акценты корпуса. Они маленькие, но дают танку «сборку»:
  // фары впереди, буксирные проушины и три полосы моторной решётки сзади.
  const hullMetal = mergeGeometries([
    at(box(0.22, 0.13, 0.24), -0.86, 1.26, 1.92),
    at(box(0.22, 0.13, 0.24), 0.86, 1.26, 1.92),
    at(box(0.14, 0.12, 0.42), -0.92, 1.14, 1.8),
    at(box(0.14, 0.12, 0.42), 0.92, 1.14, 1.8),
    ...[-0.62, -0.2, 0.2, 0.62].map((x) => at(box(0.13, 0.07, 0.62), x, 1.51, -1.2)),
  ]);

  // Дальше всё в координатах башни: её узел сидит на высоте TURRET_Y.
  const turret = mergeGeometries([
    // Компактная башня с вынесенной кормовой нишей и передними скулами.
    at(box(1.72, 0.56, 1.62), 0, 0.32, 0),
    at(tilted(box(1.55, 0.42, 0.15), -0.36), 0, 0.31, 0.88),
    at(box(1.34, 0.36, 0.72), 0, 0.3, -1.02),
    at(box(1.12, 0.12, 0.88), 0, 0.66, -0.16),
    // Маска — часть брони башни, а не отдельный гладкий цилиндр. Широкий
    // наклонный щит продолжает передние скулы и зрительно «сажает» пушку.
    at(tilted(box(1.04, 0.58, 0.3), -0.18), 0, MUZZLE_Y, 0.88),
    at(box(1.18, 0.16, 0.28), 0, MUZZLE_Y - 0.25, 0.84),
  ]);

  const turretMetal = mergeGeometries([
    // Под броневым щитом видна лишь механическая цапфа: компактное кольцо,
    // которое связывает маску с откатной частью орудия.
    at(alongZ(new THREE.CylinderGeometry(0.28, 0.28, 0.32, 12)), 0, MUZZLE_Y, 1.06),
    at(new THREE.CylinderGeometry(0.3, 0.3, 0.26, 12), 0.48, 0.77, -0.2),
    // Люк и прицел на крыше башни.
    at(new THREE.CylinderGeometry(0.3, 0.3, 0.08, 12), -0.42, 0.72, -0.22),
    // Здесь оставляем обычный индексированный куб: он сливается с цилиндрами
    // маски без промежуточной конвертации и всё равно почти не виден сверху.
    at(new THREE.BoxGeometry(0.12, 0.18, 0.24), -0.42, 0.84, -0.22),
    // Два компактных блока дымовых гранат по бортам башни.
    at(new THREE.CylinderGeometry(0.1, 0.1, 0.25, 8), -0.7, 0.5, -0.58),
    at(new THREE.CylinderGeometry(0.1, 0.1, 0.25, 8), -0.48, 0.5, -0.68),
    at(new THREE.CylinderGeometry(0.1, 0.1, 0.25, 8), 0.7, 0.5, -0.58),
    at(new THREE.CylinderGeometry(0.1, 0.1, 0.25, 8), 0.48, 0.5, -0.68),
  ]);

  const barrel = mergeGeometries([
    // Откатная муфта, тонкий ствол и два пояска дают читаемую «механику»
    // вместо одной трубы. Все части симметричны вокруг того же канала ствола.
    at(alongZ(new THREE.CylinderGeometry(0.2, 0.16, 0.66, 12)), 0, MUZZLE_Y, 1.37),
    at(alongZ(new THREE.CylinderGeometry(0.13, 0.15, 2.22, 12)), 0, MUZZLE_Y, 2.81),
    at(alongZ(new THREE.CylinderGeometry(0.18, 0.18, 0.12, 12)), 0, MUZZLE_Y, 1.78),
    at(alongZ(new THREE.CylinderGeometry(0.17, 0.17, 0.12, 12)), 0, MUZZLE_Y, 3.62),
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
