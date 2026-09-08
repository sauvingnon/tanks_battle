/**
 * Стенд метки прицела: насколько ровно она едет по экрану.
 *
 * Метка стоит на линии выстрела, а место на этой линии выбирает её дальность.
 * Раньше дальность брали у свипа — у точки, в которую упрётся выстрел, — и это
 * оказалось её бедой: дальность до преграды рвётся. Ствол прошёл мимо угла
 * укрытия — точка удара перескочила с трёх метров на двести, и метка улетела
 * через полэкрана. На рельефе то же делает земля: луч ложится на неё почти по
 * касательной, и дальность скачет от любого шевеления наводкой. Это и есть та
 * дрожь, ради которой прицел переделан.
 *
 * Считаем не метры, а угол. Камера висит не на дульном срезе, а метрах в двух
 * поперёк линии выстрела, и точки этой линии с разной дальности расходятся по
 * экрану ровно на плечо, делённое на дальность. Отсюда единственная честная
 * мера дрожи: на сколько градусов метка съезжает за кадр. В метрах вышло бы
 * враньё — сто метров на дальнем конце луча стоят долю пикселя, а три метра у
 * самого носа переносят метку через весь экран.
 *
 * Запуск: npm run check:aim
 */
import {
  MUZZLE_OFFSET,
  SHELL_HEIGHT,
  SHELL_LIFETIME,
  SHELL_SPEED,
  TURRET_RATE,
} from '../src/shared/constants.js';
import { buildScene, coverBoxes, MAP_NAMES, spawnPoint } from '../src/shared/map.js';
import { sweepShell } from '../src/shared/sim.js';
import { heightAt } from '../src/shared/terrain.js';
import type { Box, ShellState, Terrain } from '../src/shared/types.js';

let bad = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) bad++;
  console.log(`  ${ok ? '·' : '!'} ${label}${detail ? ` — ${detail}` : ''}${ok ? '' : ' — ПЛОХО'}`);
}

/** Те же числа, что и в клиенте: см. main.ts, drawAim. */
const SHELL_REACH = SHELL_SPEED * SHELL_LIFETIME;
const AIM_IDLE_RANGE = 80;
const AIM_RANGE_RATE = 9;

/** Кадр в 60 Гц: метку клиент считает каждый кадр, а не каждый шаг симуляции. */
const FRAME = 1 / 60;

/**
 * Плечо камеры от линии выстрела, м: насколько глаз отнесён от неё поперёк
 * взгляда. Посчитано по расстановке камеры (CAMERA_BASE_HEIGHT, обычный зум и
 * наклон) и высоте дульного среза. Оно только задаёт масштаб — какое правило
 * ровнее, от него не зависит.
 */
const CAMERA_ARM = 1.73;

/** Поле зрения по вертикали — 62°, экран 720 строк. Чтобы читать градусы глазами. */
const PIXELS_PER_DEGREE = 360 / (Math.tan((62 / 2) * (Math.PI / 180)) * (180 / Math.PI));

/** На сколько градусов уедет метка по экрану, если её дальность сменится. */
function shift(from: number, to: number): number {
  return (CAMERA_ARM * Math.abs(1 / from - 1 / to) * 180) / Math.PI;
}

/**
 * Шаг сглаживания дальности — тот же, что в клиенте: сглаживается обратная
 * дальность, потому что по экрану метка ходит именно как единица на дальность.
 */
function ease(range: number, want: number): number {
  const inverse = 1 / range;
  return 1 / (inverse + (1 / want - inverse) * (1 - Math.exp(-FRAME * AIM_RANGE_RATE)));
}

/** Докуда дойдёт выстрел: ровно тот свип, которым летит снаряд. */
function reach(
  x: number,
  z: number,
  ground: number,
  turret: number,
  pitch: number,
  cover: Box[],
  terrain: Terrain | undefined,
  half: number,
): number {
  const flat = Math.cos(pitch);
  const dx = Math.sin(turret) * flat;
  const dz = Math.cos(turret) * flat;
  const dy = Math.sin(pitch);
  const probe: ShellState = {
    id: 0,
    owner: -1,
    x: x + dx * MUZZLE_OFFSET,
    z: z + dz * MUZZLE_OFFSET,
    y: ground + SHELL_HEIGHT + dy * MUZZLE_OFFSET,
    vx: dx * SHELL_REACH,
    vz: dz * SHELL_REACH,
    vy: dy * SHELL_REACH,
    life: 1,
    bounces: 0,
  };
  const hit = sweepShell(probe, 1, cover, terrain, half);
  // Ноль дальности сюда прийти не может: свип начинается от дульного среза,
  // а он вынесен вперёд корпуса. Но делить на неё мы всё равно собираемся.
  return Math.max(1, (hit ? hit.t : 1) * SHELL_REACH);
}

/**
 * Ведёт башню по кругу с каждого спавна карты и возвращает, на сколько градусов
 * за кадр съезжает метка — по старому правилу и по новому.
 *
 * Само вращение из счёта выпадает: вслед за стволом метка едет в обоих случаях
 * одинаково, и это движение глаз читает как наводку, а не как дрожь. Остаётся
 * только то, что даёт смена дальности, — скачок метки вдоль луча.
 */
function sweepMap(id: number, pitch: number): { old: number[]; now: number[] } {
  const scene = buildScene(id);
  const terrain = scene.terrain.flat ? undefined : scene.terrain;
  const cover = coverBoxes(scene.obstacles, scene.terrain);

  const old: number[] = [];
  const now: number[] = [];

  for (let spawn = 0; spawn < 8; spawn++) {
    const at = spawnPoint(spawn, id);
    const ground = heightAt(scene.terrain, at.x, at.z);
    let range = AIM_IDLE_RANGE;
    let prevOld: number | null = null;
    let prevNow: number | null = null;

    // Полный круг с той скоростью, с какой башня ходит на самом деле.
    const steps = Math.ceil((2 * Math.PI) / (TURRET_RATE * FRAME));
    for (let i = 0; i < steps; i++) {
      const turret = at.angle + i * TURRET_RATE * FRAME;
      // Старое правило: дальность метки — это дальность до преграды.
      const stop = reach(at.x, at.z, ground, turret, pitch, cover, terrain, scene.half);
      // Новое: цели на линии нет, значит метка идёт к запасной дальности.
      range = ease(range, AIM_IDLE_RANGE);

      if (prevOld !== null) old.push(shift(prevOld, stop));
      if (prevNow !== null) now.push(shift(prevNow, range));
      prevOld = stop;
      prevNow = range;
    }
  }
  return { old, now };
}

function worst(list: number[]): number {
  return list.reduce((a, b) => Math.max(a, b), 0);
}

/** Дрожь — это хвост распределения, а не среднее: смотрим на 99-й процентиль. */
function tail(list: number[]): number {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.99)] ?? 0;
}

const deg = (value: number) => `${value.toFixed(2)}° (${Math.round(value * PIXELS_PER_DEGREE)} px)`;

console.log('\n=== Съезд метки за кадр ===');
console.log('  карта            правило           худший           99-й процентиль');

for (const name of ['Город', 'Холмы', 'Долина']) {
  const id = MAP_NAMES.indexOf(name);
  if (id < 0) continue;
  // Стволом чуть вниз: на рельефе именно так луч ложится на землю по касательной,
  // и старое правило разваливалось сильнее всего. На плоской карте наводки нет.
  const { old, now } = sweepMap(id, name === 'Город' ? 0 : -0.12);

  const row = (label: string, list: number[]) =>
    console.log(
      `  ${name.padEnd(16)} ${label.padEnd(14)} ${deg(worst(list)).padStart(16)} ${deg(tail(list)).padStart(20)}`,
    );
  row('по свипу', old);
  row('по дальности', now);

  check(`«${name}»: метка не дрожит`, worst(now) < 0.5, `худший съезд ${deg(worst(now))}`);
  check(
    `«${name}»: старое правило и правда рвалось`,
    worst(old) > 5,
    `${deg(worst(old))} за один кадр`,
  );
}

/**
 * Переезд метки на цель и обратно. Дальность цели — единственная, на которой
 * «метка накрыла танк» значит «попал», поэтому она и ведёт метку; но сама смена
 * дальности не должна выглядеть рывком. Проверяем оба конца: у ближней цели
 * градус стоит дорого, у дальней — дёшево.
 */
console.log('\n=== Переезд на цель ===');
for (const target of [25, 60, 150]) {
  let range = AIM_IDLE_RANGE;
  let biggest = 0;
  // Секунду держим цель на линии, потом столько же без неё.
  for (let i = 0; i < 120; i++) {
    const next = ease(range, i < 60 ? target : AIM_IDLE_RANGE);
    biggest = Math.max(biggest, shift(range, next));
    range = next;
  }
  console.log(`  цель на ${String(target).padStart(3)} м: худший съезд ${deg(biggest)}`);
  check(`переезд на ${target} м идёт плавно`, biggest < 0.5, deg(biggest));
}

/**
 * Отдельно — все карты подряд, включая аркадные. Аркада живёт по тем же строкам
 * кода, и если метка начнёт дрожать там, потеряем то, что и так работало.
 */
console.log('\n=== Ровность на всех картах ===');
{
  let worstAll = 0;
  let where = '';
  for (let id = 0; id < MAP_NAMES.length; id++) {
    const { now } = sweepMap(id, 0);
    if (worst(now) > worstAll) {
      worstAll = worst(now);
      where = MAP_NAMES[id];
    }
  }
  check(
    'ни на одной карте метка не прыгает',
    worstAll < 0.5,
    where ? `худшее — «${where}», ${deg(worstAll)}` : 'метка стоит намертво',
  );
}

console.log(bad === 0 ? '\nПрицел ровный' : `\nПроблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
