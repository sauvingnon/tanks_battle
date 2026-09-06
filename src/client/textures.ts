/**
 * Текстуры генерируются кодом, а не лежат файлами.
 *
 * Причина простая: файл текстуры — это ещё один артефакт, который надо где-то
 * взять с внятной лицензией, положить в репозиторий, раздать через nginx и не
 * забыть про кэш при выкладке. Процедурный шум ничего из этого не требует,
 * весит ноль байт в сборке и рисуется за пару миллисекунд при запуске.
 *
 * Все текстуры серые и светлые: они идут в `map` и умножаются на цвет материала.
 * Так палитра остаётся ровно той же, а поверхность перестаёт быть заливкой.
 * Заодно умножение только затемняет — то есть запас до порога свечения от этого
 * не сокращается, а растёт.
 */
import * as THREE from 'three';

/** Сторона текстуры в пикселях. 256 хватает: рисунок мелкий и повторяется. */
const SIZE = 256;

/**
 * Детерминированный генератор: одна и та же карта должна выглядеть одинаково
 * при каждом заходе, иначе разговор «глянь на эту стену» теряет смысл.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32 — короткий, быстрый и без внешних зависимостей.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

/**
 * Значения шума в узлах решётки period×period с зацикливанием по обеим осям.
 * Зацикливание обязательно: текстура повторяется по карте сотню раз, и шов
 * между копиями был бы виден сеткой на всю землю.
 */
function latticeNoise(period: number, random: () => number): number[] {
  const grid = new Array<number>(period * period);
  for (let i = 0; i < grid.length; i++) grid[i] = random();
  return grid;
}

/** Сглаженная выборка из решётки; координаты в клетках, дробные. */
function sampleNoise(grid: number[], period: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  // Плавность по кубике: линейная интерполяция дала бы видимые грани решётки.
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  const at = (ix: number, iy: number) =>
    grid[(((iy % period) + period) % period) * period + (((ix % period) + period) % period)];

  const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
  const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
  return top + (bottom - top) * sy;
}

/**
 * Многооктавный шум в оттенках серого. `octaves` — сколько слоёв разной
 * частоты складывается: один слой даёт мыло, четыре — узнаваемую крупу.
 */
function noiseCanvas(
  seed: number,
  octaves: number,
  base: number,
  contrast: number,
  paint?: (ctx: CanvasRenderingContext2D, random: () => number) => void,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const random = makeRandom(seed);
  const grids: Array<{ grid: number[]; period: number; weight: number }> = [];
  let weight = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const period = 4 << o;
    grids.push({ grid: latticeNoise(period, random), period, weight });
    total += weight;
    weight /= 2;
  }

  const image = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let value = 0;
      for (const layer of grids) {
        const scale = layer.period / SIZE;
        value += sampleNoise(layer.grid, layer.period, x * scale, y * scale) * layer.weight;
      }
      value /= total;

      const shade = Math.max(0, Math.min(255, Math.round((base + (value - 0.5) * contrast) * 255)));
      const at = (y * SIZE + x) * 4;
      image.data[at] = shade;
      image.data[at + 1] = shade;
      image.data[at + 2] = shade;
      image.data[at + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  // Поверх шума — детали, которые шумом не получаются: швы плит, царапины.
  if (paint) paint(ctx, random);
  return canvas;
}

function toTexture(canvas: HTMLCanvasElement, renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // Текстура идёт множителем к цвету, то есть это данные, а не цвет: перевод
  // из sRGB её бы исказил. Земля вдали видна почти в профиль, поэтому
  // анизотропия здесь решает больше, чем разрешение.
  texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

/** Земля: мелкая крупа с редкими пятнами посветлее. */
export function groundTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  return toTexture(noiseCanvas(0x51ee7, 4, 0.86, 0.42), renderer);
}

/** Бетон блоков и стен: крупнее и контрастнее земли, со швами плит. */
export function concreteTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const canvas = noiseCanvas(0xc0ffee, 4, 0.9, 0.3, (ctx) => {
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.16)';
    ctx.lineWidth = 2;
    for (const at of [0, SIZE / 2]) {
      ctx.beginPath();
      ctx.moveTo(at, 0);
      ctx.lineTo(at, SIZE);
      ctx.moveTo(0, at);
      ctx.lineTo(SIZE, at);
      ctx.stroke();
    }
  });
  return toTexture(canvas, renderer);
}

/** Броня: почти ровная, с редкими царапинами и потёртостями. */
export function armorTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const canvas = noiseCanvas(0xbadf00d, 3, 0.93, 0.16, (ctx, random) => {
    ctx.lineWidth = 1;
    for (let i = 0; i < 40; i++) {
      const x = random() * SIZE;
      const y = random() * SIZE;
      const length = 4 + random() * 22;
      const course = random() * Math.PI * 2;
      ctx.strokeStyle = `rgba(${random() > 0.5 ? '255,255,255' : '0,0,0'}, ${0.06 + random() * 0.12})`;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(course) * length, y + Math.sin(course) * length);
      ctx.stroke();
    }
  });
  return toTexture(canvas, renderer);
}

/**
 * Растягивает UV коробки так, чтобы клетка текстуры была `tile` метров на любой
 * грани. Без этого одна и та же текстура на блоке 4×4 и на стене 140×2 выглядит
 * то крупой, то размазанным пятном: у BoxGeometry все шесть граней размечены
 * от нуля до единицы независимо от того, сколько в них метров.
 *
 * Порядок граней в BoxGeometry: +X, -X, +Y, -Y, +Z, -Z, по четыре вершины.
 * У боковых граней в развёртке лежат (глубина, высота), у крышек — (ширина,
 * глубина), у передней и задней — (ширина, высота).
 */
export function scaleBoxUv(
  geometry: THREE.BufferGeometry,
  width: number,
  height: number,
  depth: number,
  tile: number,
): void {
  const uv = geometry.getAttribute('uv');
  if (!uv) return;

  const spans: Array<[number, number]> = [
    [depth, height], // +X
    [depth, height], // -X
    [width, depth], // +Y
    [width, depth], // -Y
    [width, height], // +Z
    [width, height], // -Z
  ];

  for (let face = 0; face < 6; face++) {
    const [su, sv] = spans[face];
    for (let i = 0; i < 4; i++) {
      const at = face * 4 + i;
      uv.setXY(at, uv.getX(at) * (su / tile), uv.getY(at) * (sv / tile));
    }
  }
  uv.needsUpdate = true;
}
