/**
 * Эффекты ходовой части и гибели: крен корпуса, следы на земле, пыль из-под
 * траков, обломки подбитого танка и уход остова.
 *
 * Рои устроены одинаково и намеренно: буфер фиксированного размера по
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
// Колея — свойство самого танка, а не земли: держим её в одном месте с его
// геометрией, иначе следы однажды разъедутся с траками, которые их оставляют.
import { TRACK_SIDE } from './tank.js';

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

/** Насколько точка контакта отнесена к корме от центра танка. */
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
 * Толчок корпуса от удара: выстрела своей пушки или прилетевшего снаряда.
 *
 * Сила приложена **выше центра тяжести** — к башне при выстреле, к борту при
 * попадании, — и потому знаки здесь другие, чем у ходового крена. Крен на
 * повороте и клевок на торможении растут от того, что упор земли ниже центра
 * тяжести; здесь наоборот. Правило выходит одно и простое: **вверх идёт та
 * сторона, с которой пришла сила.** Стреляешь вперёд — задирается нос;
 * стреляешь на левый борт — поднимается левый; прилетело в лоб — нос вверх.
 *
 * Обе составляющие силы берутся в осях корпуса: вдоль курса (+Z вперёд) и
 * вбок (+X — левый борт, см. знаки в bodyLean).
 */
export function bodyKick(
  alongZ: number,
  alongX: number,
  strength: number,
): { pitch: number; roll: number } {
  // Момент вокруг X пропорционален продольной составляющей, вокруг Z —
  // поперечной с обратным знаком: это обычное r × F при r, смотрящем вверх.
  return { pitch: strength * alongZ, roll: -strength * alongX };
}

/** Насколько быстро гаснет толчок. Медленнее ходового крена: удар должен читаться. */
export const KICK_DECAY = 7;

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

// --- Гибель танка ---

/**
 * Сколько живёт остов. Оставлять его до возрождения нельзя: на сервере подбитый
 * танк выброшен и из столкновений, и из поиска цели снарядом — сквозь него ездят
 * и стреляют. В режиме волн возрождения ждут до конца волны, то есть остов
 * простоял бы там минуту ложной мишенью, съедая по 1.6 с перезарядки за выстрел.
 * Поэтому гибель показываем и убираем.
 */
export const WRECK_S = 1.7;
/** Пауза перед уходом: столько остов просто горит на месте. */
const WRECK_HOLD_S = 0.4;
/** На сколько метров остов уходит под землю. Корпус с башней — около 2.5 м. */
const WRECK_DEPTH = 2.8;

/**
 * Насколько остов просел к моменту elapsed. Уход под землю, а не растворение:
 * материалы корпуса общие на все танки, и гасить их прозрачностью значило бы
 * гасить заодно живых. Земля непрозрачна и прячет остов сама, бесплатно.
 */
export function wreckSink(elapsed: number): number {
  if (elapsed <= WRECK_HOLD_S) return 0;
  const t = Math.min(1, (elapsed - WRECK_HOLD_S) / (WRECK_S - WRECK_HOLD_S));
  // Квадрат: сначала оседает медленно, будто подламывается, потом проваливается.
  return -WRECK_DEPTH * t * t;
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

  /**
   * Кладёт один отпечаток центром в (x, z), развёрнутый по ходу танка.
   *
   * groundAt — высота земли в точке; без неё след ложится на нулевую отметку,
   * как было до рельефа. Каждый угол опрашивается отдельно: отпечаток полтора
   * метра длиной, и на склоне разница между его концами уже заметна.
   */
  emit(
    x: number,
    z: number,
    angle: number,
    time: number,
    groundAt?: (x: number, z: number) => number,
  ): void {
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
      const px = x + rx * side + fx * along;
      const pz = z + rz * side + fz * along;
      points[at] = px;
      points[at + 1] = (groundAt ? groundAt(px, pz) : 0) + TRACK_Y;
      points[at + 2] = pz;
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

// --- Летящие частицы: пыль из-под гусениц и обломки подбитого танка ---

/**
 * Настройки одного роя. Пыль из-под гусениц и обломки подбитого танка — это
 * одна и та же система с разными числами: летящая частица, которая стареет,
 * растёт и гаснет. Разводить их в два класса значило бы дважды написать
 * кольцевой буфер и дважды — один и тот же шейдер.
 */
export interface FieldOptions {
  /** Сколько частиц живёт одновременно; дальше кольцо затирает старые. */
  max: number;
  /** Сколько секунд живёт частица. */
  life: number;
  color: number;
  /** Ускорение вниз, м/с². 0 — частица летит по прямой. */
  gravity: number;
  /** Во сколько раз частица разрастается к концу жизни. */
  growth: number;
  /** Плотность в центре частицы. */
  alpha: number;
  /** Ниже этой высоты частица ложится и дальше не падает, м. */
  floor: number;
}

/** Пыль из-под траков: висит, разрастается, не падает. */
export const DUST_FIELD: FieldOptions = {
  max: 512,
  life: 0.95,
  color: 0x9b9078,
  gravity: 0,
  growth: 1.3,
  // Пылинок за танком висит с десяток, и они накладываются друг на друга:
  // на трети плотности стая читается как облако, на половине — как стена.
  alpha: 0.32,
  floor: 0.1,
};

/** Обломки подбитого танка: тяжёлые, тёмные, летят по дуге и остаются лежать. */
export const DEBRIS_FIELD: FieldOptions = {
  max: 256,
  life: 1.6,
  color: 0x2a2521,
  gravity: -16,
  growth: 0, // осколок не разрастается, в отличие от клуба пыли
  alpha: 0.95,
  floor: 0.15,
};

export class ParticleField {
  readonly points: THREE.Points;

  private readonly max: number;
  private readonly position: THREE.BufferAttribute;
  private readonly velocity: THREE.BufferAttribute;
  private readonly birth: THREE.BufferAttribute;
  private readonly size: THREE.BufferAttribute;
  private readonly material: THREE.ShaderMaterial;
  private head = 0;
  private dirty = false;

  constructor(options: FieldOptions) {
    const geometry = new THREE.BufferGeometry();
    this.max = options.max;

    this.position = new THREE.BufferAttribute(new Float32Array(options.max * 3), 3);
    this.velocity = new THREE.BufferAttribute(new Float32Array(options.max * 3), 3);
    this.birth = new THREE.BufferAttribute(new Float32Array(options.max), 1);
    this.size = new THREE.BufferAttribute(new Float32Array(options.max), 1);
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
        uLife: { value: options.life },
        // Пересчитывается при изменении размера окна: gl_PointSize задаётся
        // в пикселях устройства, а размер частицы задан в метрах.
        uScale: { value: 300 },
        uColor: { value: new THREE.Color(options.color) },
        uGravity: { value: options.gravity },
        uGrowth: { value: options.growth },
        uAlpha: { value: options.alpha },
        uFloor: { value: options.floor },
      },
      vertexShader: `
        attribute vec3 velocity;
        attribute float birth;
        attribute float size;
        uniform float uTime;
        uniform float uLife;
        uniform float uScale;
        uniform float uGravity;
        uniform float uGrowth;
        uniform float uFloor;
        varying float vAlpha;
        void main() {
          float age = clamp((uTime - birth) / uLife, 0.0, 1.0);
          // Квадрат: частица держится плотной, пока летит, и тает в конце.
          vAlpha = (1.0 - age) * (1.0 - age);

          float t = age * uLife;
          vec3 drift = position + velocity * t;
          // Обломки падают по дуге и остаются лежать на земле, пыль просто висит.
          drift.y = max(drift.y + 0.5 * uGravity * t * t, uFloor);

          vec4 view = modelViewMatrix * vec4(drift, 1.0);
          gl_PointSize = size * (0.55 + age * uGrowth) * uScale / max(-view.z, 1.0);
          gl_Position = projectionMatrix * view;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uAlpha;
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.004) discard;
          // Мягкий круг считаем прямо здесь: текстура ради градиента не нужна.
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;
          gl_FragColor = vec4(uColor, vAlpha * (1.0 - d * 2.0) * uAlpha);
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
    this.head = (this.head + 1) % this.max;

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
