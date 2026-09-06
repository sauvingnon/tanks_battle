/**
 * Геометрия танка: корпус с наклонными листами, ходовая с катками и ленивцами,
 * башня с маской и дульным тормозом.
 *
 * Собирается из примитивов и **сливается в пять геометрий по материалам**, а не
 * ставится двумя десятками мешей. Разница считается в вызовах отрисовки: два
 * десятка мешей на танк при дюжине танков — это шестьсот вызовов за кадр, да
 * ещё столько же в проход теней. После слияния их пять на танк, ровно как было
 * у прежних коробок, а деталей на порядок больше.
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
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { scaleBoxUv } from './textures.js';

/** Метров на клетку текстуры брони: мельче земли, крупнее не нужно. */
const ARMOR_TILE = 2;

/** Насколько трак отнесён от оси корпуса. Тот же, что и у следов на земле. */
export const TRACK_SIDE = 1.45;

/** Высота, на которой сидит башня. */
export const TURRET_Y = 1.78;

/** Штатное положение ствола внутри башни по оси Z. */
export const BARREL_Z = 2.3;
/** Дульный тормоз: центр и длина. */
const BRAKE_Z = BARREL_Z + 1.35;
const BRAKE_LENGTH = 0.48;

/**
 * Дульный срез в координатах башни. Выведен из тех же чисел, что и сама
 * геометрия, а не записан отдельно: от него ставится вспышка выстрела, и стоит
 * подвинуть тормоз, как посчитанная руками константа молча утащит вспышку
 * внутрь ствола или подвесит в воздухе. Стенд сверяет её с границей геометрии.
 */
export const MUZZLE_TIP_Z = BRAKE_Z + BRAKE_LENGTH / 2;

/** Коробка с поправленной под размер развёрткой. */
function box(w: number, h: number, d: number): THREE.BoxGeometry {
  const geometry = new THREE.BoxGeometry(w, h, d);
  scaleBoxUv(geometry, w, h, d, ARMOR_TILE);
  return geometry;
}

/** Цилиндр, положенный на бок вдоль оси X: каток, ленивец, маска. */
function wheel(radius: number, width: number, segments = 14): THREE.CylinderGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius, width, segments);
  geometry.rotateZ(Math.PI / 2);
  return geometry;
}

function at(geometry: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  geometry.translate(x, y, z);
  return geometry;
}

export interface TankGeometry {
  /** Корпус: красится в цвет команды. */
  hull: THREE.BufferGeometry;
  /** Ходовая: траки, катки, ленивцы. Тёмная, своего материала. */
  running: THREE.BufferGeometry;
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
    // Нижний корпус — основной объём, по нему танк и читается.
    at(box(2.9, 0.7, 4.4), 0, 0.95, 0),
    // Верхний уже и короче: ступенька в силуэте сразу отличает танк от ящика.
    at(box(2.5, 0.45, 3.2), 0, 1.5, 0),
    // Лобовой лист с наклоном. Наклон здесь чисто внешний: снаряд считается
    // по кругу радиуса TANK_RADIUS, рикошетов от брони в игре нет.
    at(tilted(box(2.5, 1.2, 0.24), -0.5), 0, 1.28, 2.05),
    at(tilted(box(2.5, 0.9, 0.24), 0.34), 0, 1.32, -2.05),
    // Крылья над траками.
    at(box(1.02, 0.12, 4.6), TRACK_SIDE, 1.02, 0),
    at(box(1.02, 0.12, 4.6), -TRACK_SIDE, 1.02, 0),
    // Моторная палуба сзади и ящик ЗИП на левом крыле.
    at(box(2.1, 0.14, 1.1), 0, 1.79, -1.15),
    at(box(0.72, 0.34, 1.2), -TRACK_SIDE, 1.25, -1.4),
  ]);

  const running: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const x = side * TRACK_SIDE;
    // Лента трака между ленивцем и ведущим колесом.
    running.push(at(box(0.78, 0.62, 4.0), x, 0.55, 0));
    // Ленивец спереди и ведущее колесо сзади — они и делают из ящика ходовую.
    running.push(at(wheel(0.45, 0.8), x, 0.55, 2.0));
    running.push(at(wheel(0.45, 0.8), x, 0.55, -2.0));
    // Опорные катки чуть шире ленты, поэтому видны с обоих боков.
    for (const z of [-1.15, -0.38, 0.38, 1.15]) {
      running.push(at(wheel(0.34, 0.88, 12), x, 0.36, z));
    }
  }

  // Дальше всё в координатах башни: её узел сидит на высоте TURRET_Y.
  const turret = mergeGeometries([
    at(box(2, 0.75, 2.3), 0, 0.32, 0),
    // Скула башни и кормовая ниша.
    at(tilted(box(1.9, 0.72, 0.26), -0.38), 0, 0.34, 1.2),
    at(box(1.55, 0.5, 0.6), 0, 0.3, -1.42),
  ]);

  const turretMetal = mergeGeometries([
    // Маска пушки: цилиндр в основании ствола, вдоль Z.
    at(alongZ(new THREE.CylinderGeometry(0.42, 0.42, 0.7, 16)), 0, 0.36, 1.15),
    at(new THREE.CylinderGeometry(0.34, 0.34, 0.3, 12), 0.55, 0.82, -0.3),
  ]);

  const barrel = mergeGeometries([
    at(alongZ(new THREE.CylinderGeometry(0.14, 0.16, 3, 12)), 0, 0.36, BARREL_Z),
    // Дульный тормоз: короткий утолщённый набалдашник на срезе.
    at(alongZ(new THREE.CylinderGeometry(0.22, 0.22, BRAKE_LENGTH, 12)), 0, 0.36, BRAKE_Z),
  ]);

  return { hull, running: mergeGeometries(running), turret, turretMetal, barrel };
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
