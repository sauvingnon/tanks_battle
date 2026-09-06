/**
 * Наземные эффекты гусениц: следы на земле и пыль из-под траков.
 *
 * Обе штуки устроены одинаково и намеренно: буфер фиксированного размера по
 * кругу, в который пишут только в момент рождения частицы. Всё остальное —
 * затухание, рост, полёт — считает вершинный шейдер по возрасту, а возраст он
 * берёт из времени рождения и одного общего uniform'а. Поэтому цена кадра не
 * зависит от того, сколько следов лежит на карте: процессор каждый кадр пишет
 * ровно одно число.
 *
 * Наивный вариант — обновлять прозрачность каждой частицы на процессоре — на
 * дюжине танков означал бы десятки тысяч записей в буфер и его перезаливку
 * в видеопамять каждый кадр.
 */
import * as THREE from 'three';

import { clamp } from '../shared/sim.js';

// --- Ходовая: крен корпуса и точки под траками ---

/**
 * Крен и клевок считаются из того, как танк на самом деле переместился за кадр,
 * а не из ввода: у чужих танков ввода нет вовсе, а свой рисуется предсказанием.
 * Одна формула на всех — и боты кренятся ровно так же, как игрок.
 */
const ROLL_K = 0.009; // рад на (рад/с · м/с) поворота на ходу
const PITCH_K = 0.0055; // рад на м/с² разгона
/** ~6°: больше выглядит как лодка на волне, а не как танк. */
export const LEAN_MAX = 0.1;

/** Смещение траков от оси корпуса и точка, где они месят землю. */
export const TRACK_SIDE = 1.45;
const TRACK_BACK = 1.9;

/**
 * Целевой наклон корпуса в его собственных осях.
 *
 * Знаки здесь неочевидны, поэтому по порядку. Курс 0 смотрит в +Z, правый борт
 * танка — это forward × up, то есть при курсе 0 он направлен в -X. Значит
 * растущий курс разворачивает танк влево. В повороте корпус кренится наружу:
 * влево — значит вверх идёт левый борт, то есть +X, а это положительный поворот
 * вокруг Z. Отсюда крен без минуса.
 *
 * С клевком наоборот: поворот вокруг X кладёт нос (+Z) вниз, а разгон должен
 * нос задирать — поэтому знак обратный. На заднем ходу скорость отрицательная,
 * и танк послушно клюёт в другую сторону.
 */
export function bodyLean(
  yawRate: number,
  speed: number,
  accel: number,
): { roll: number; pitch: number } {
  return {
    roll: clamp(yawRate * speed * ROLL_K, -LEAN_MAX, LEAN_MAX),
    pitch: clamp(-accel * PITCH_K, -LEAN_MAX, LEAN_MAX),
  };
}

/**
 * Точка, где трак борта side (+1 правый, −1 левый) месит землю: смещение вбок
 * от оси корпуса и назад к корме.
 */
export function trackAnchor(
  x: number,
  z: number,
  yaw: number,
  side: number,
): { x: number; z: number } {
  const forwardX = Math.sin(yaw);
  const forwardZ = Math.cos(yaw);
  const rightX = -forwardZ;
  const rightZ = forwardX;
  return {
    x: x + rightX * side * TRACK_SIDE - forwardX * TRACK_BACK,
    z: z + rightZ * side * TRACK_SIDE - forwardZ * TRACK_BACK,
  };
}

// --- Следы гусениц ---

/**
 * Сколько отпечатков живёт одновременно; дальше кольцо затирает самые старые.
 * Считается от худшего случая: тринадцать танков на полном ходу кладут около
 * 390 отпечатков в секунду, значит на шесть секунд жизни нужно около 2400.
 * Возьми меньше — и след обрывался бы на полпути, не досчитав своё время.
 * Вершин при этом 9600, то есть индекс всё ещё влезает в 16 бит.
 */
const TRACK_QUADS = 2400;
/** Сколько секунд виден след. */
const TRACK_LIFE = 6;
/** Насколько отпечаток приподнят над землёй, чтобы не спорить с ней за глубину. */
export const TRACK_Y = 0.05;
export const TRACK_WIDTH = 0.95;
/** Длина отпечатка. Больше шага эмиссии — иначе след выйдет пунктиром. */
export const TRACK_LENGTH = 1.8;

export class TrackMarks {
  readonly mesh: THREE.Mesh;

  private readonly position: THREE.BufferAttribute;
  private readonly birth: THREE.BufferAttribute;
  private readonly material: THREE.ShaderMaterial;
  private head = 0;
  private dirty = false;

  constructor() {
    const geometry = new THREE.BufferGeometry();

    this.position = new THREE.BufferAttribute(new Float32Array(TRACK_QUADS * 4 * 3), 3);
    this.birth = new THREE.BufferAttribute(new Float32Array(TRACK_QUADS * 4), 1);
    this.position.setUsage(THREE.DynamicDrawUsage);
    this.birth.setUsage(THREE.DynamicDrawUsage);
    (this.birth.array as Float32Array).fill(-1e6); // «родились бесконечно давно» — не видны

    const index = new Uint16Array(TRACK_QUADS * 6);
    for (let quad = 0; quad < TRACK_QUADS; quad++) {
      const v = quad * 4;
      index.set([v, v + 1, v + 2, v, v + 2, v + 3], quad * 6);
    }

    geometry.setAttribute('position', this.position);
    geometry.setAttribute('birth', this.birth);
    geometry.setIndex(new THREE.BufferAttribute(index, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLife: { value: TRACK_LIFE },
        uColor: { value: new THREE.Color(0x24261d) },
      },
      vertexShader: `
        attribute float birth;
        uniform float uTime;
        uniform float uLife;
        varying float vAlpha;
        void main() {
          vAlpha = clamp(1.0 - (uTime - birth) / uLife, 0.0, 1.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.002) discard;
          gl_FragColor = vec4(uColor, vAlpha * 0.45);
        }
      `,
      transparent: true,
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    // Границы буфера меняются на каждом отпечатке, а сам он и так лежит на карте:
    // считать их заново ради отсечения по пирамиде — дороже, чем нарисовать.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1; // под всеми прозрачными эффектами
  }

  /** Кладёт один отпечаток центром в (x, z), развёрнутый по ходу танка. */
  emit(x: number, z: number, angle: number, time: number): void {
    const fx = Math.sin(angle);
    const fz = Math.cos(angle);
    // Правый борт: forward x up. При angle = 0 это -X.
    const rx = -Math.cos(angle);
    const rz = Math.sin(angle);
    const hw = TRACK_WIDTH / 2;
    const hl = TRACK_LENGTH / 2;

    const base = this.head * 4;
    this.head = (this.head + 1) % TRACK_QUADS;

    const points = this.position.array as Float32Array;
    const corners = [
      [-hw, -hl],
      [hw, -hl],
      [hw, hl],
      [-hw, hl],
    ];
    for (let i = 0; i < 4; i++) {
      const [side, along] = corners[i];
      const at = (base + i) * 3;
      points[at] = x + rx * side + fx * along;
      points[at + 1] = TRACK_Y;
      points[at + 2] = z + rz * side + fz * along;
    }

    const born = this.birth.array as Float32Array;
    born[base] = born[base + 1] = born[base + 2] = born[base + 3] = time;

    // Заливаем в видеопамять только тронутые четыре вершины. Без этого каждый
    // отпечаток тащил бы за собой весь буфер — 115 КБ на кадр вместо сотни байт.
    this.position.addUpdateRange(base * 3, 12);
    this.birth.addUpdateRange(base, 4);
    this.dirty = true;
  }

  update(time: number): void {
    this.material.uniforms.uTime.value = time;
    if (!this.dirty) return;
    // Диапазоны сбрасывает сам рендерер, сразу после заливки.
    this.position.needsUpdate = true;
    this.birth.needsUpdate = true;
    this.dirty = false;
  }

  /** Смена карты: старые следы к новой геометрии отношения не имеют. */
  clear(): void {
    (this.birth.array as Float32Array).fill(-1e6);
    this.head = 0;
    // Пустой список диапазонов — сигнал рендереру залить буфер целиком:
    // накопленные точечные диапазоны затёрли бы только часть старых следов.
    this.position.clearUpdateRanges();
    this.birth.clearUpdateRanges();
    this.dirty = true;
  }
}

// --- Пыль из-под гусениц ---

const DUST_MAX = 512;
/** Сколько секунд живёт пылинка. */
const DUST_LIFE = 0.95;

export class DustField {
  readonly points: THREE.Points;

  private readonly position: THREE.BufferAttribute;
  private readonly velocity: THREE.BufferAttribute;
  private readonly birth: THREE.BufferAttribute;
  private readonly size: THREE.BufferAttribute;
  private readonly material: THREE.ShaderMaterial;
  private head = 0;
  private dirty = false;

  constructor() {
    const geometry = new THREE.BufferGeometry();

    this.position = new THREE.BufferAttribute(new Float32Array(DUST_MAX * 3), 3);
    this.velocity = new THREE.BufferAttribute(new Float32Array(DUST_MAX * 3), 3);
    this.birth = new THREE.BufferAttribute(new Float32Array(DUST_MAX), 1);
    this.size = new THREE.BufferAttribute(new Float32Array(DUST_MAX), 1);
    for (const attribute of [this.position, this.velocity, this.birth, this.size]) {
      attribute.setUsage(THREE.DynamicDrawUsage);
    }
    (this.birth.array as Float32Array).fill(-1e6);

    geometry.setAttribute('position', this.position);
    geometry.setAttribute('velocity', this.velocity);
    geometry.setAttribute('birth', this.birth);
    geometry.setAttribute('size', this.size);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLife: { value: DUST_LIFE },
        // Пересчитывается при изменении размера окна: gl_PointSize задаётся
        // в пикселях устройства, а размер частицы задан в метрах.
        uScale: { value: 300 },
        uColor: { value: new THREE.Color(0x9b9078) },
      },
      vertexShader: `
        attribute vec3 velocity;
        attribute float birth;
        attribute float size;
        uniform float uTime;
        uniform float uLife;
        uniform float uScale;
        varying float vAlpha;
        void main() {
          float age = clamp((uTime - birth) / uLife, 0.0, 1.0);
          // Квадрат: пыль держится плотной, пока клуб поднимается, и тает в конце.
          vAlpha = (1.0 - age) * (1.0 - age);
          vec3 drift = position + velocity * (age * uLife);
          vec4 view = modelViewMatrix * vec4(drift, 1.0);
          gl_PointSize = size * (0.55 + age * 1.3) * uScale / max(-view.z, 1.0);
          gl_Position = projectionMatrix * view;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.004) discard;
          // Мягкий круг считаем прямо здесь: текстура ради градиента не нужна.
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;
          // Пылинок за танком висит с десяток, и они накладываются друг на друга:
          // на трети плотности стая читается как облако, на половине — как стена.
          gl_FragColor = vec4(uColor, vAlpha * (1.0 - d * 2.0) * 0.32);
        }
      `,
      transparent: true,
      depthWrite: false,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
  }

  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    size: number,
    time: number,
  ): void {
    const i = this.head;
    this.head = (this.head + 1) % DUST_MAX;

    const points = this.position.array as Float32Array;
    points[i * 3] = x;
    points[i * 3 + 1] = y;
    points[i * 3 + 2] = z;

    const speeds = this.velocity.array as Float32Array;
    speeds[i * 3] = vx;
    speeds[i * 3 + 1] = vy;
    speeds[i * 3 + 2] = vz;

    (this.birth.array as Float32Array)[i] = time;
    (this.size.array as Float32Array)[i] = size;

    // Как и у следов: в видеопамять уезжает одна пылинка, а не весь буфер.
    this.position.addUpdateRange(i * 3, 3);
    this.velocity.addUpdateRange(i * 3, 3);
    this.birth.addUpdateRange(i, 1);
    this.size.addUpdateRange(i, 1);
    this.dirty = true;
  }

  update(time: number): void {
    this.material.uniforms.uTime.value = time;
    if (!this.dirty) return;
    this.position.needsUpdate = true;
    this.velocity.needsUpdate = true;
    this.birth.needsUpdate = true;
    this.size.needsUpdate = true;
    this.dirty = false;
  }

  /**
   * Пересчёт масштаба точек. Размер задан в метрах, а gl_PointSize — в пикселях
   * устройства, поэтому пересчитывать приходится при каждом изменении окна.
   */
  setViewport(heightPx: number, fovDegrees: number): void {
    const halfFov = (fovDegrees * Math.PI) / 360;
    this.material.uniforms.uScale.value = heightPx / (2 * Math.tan(halfFov));
  }

  clear(): void {
    (this.birth.array as Float32Array).fill(-1e6);
    this.head = 0;
    // Пустой список диапазонов — заливка буфера целиком; точечные диапазоны
    // погасили бы только те пылинки, что успели родиться после прошлого кадра.
    this.birth.clearUpdateRanges();
    this.dirty = true;
  }
}
