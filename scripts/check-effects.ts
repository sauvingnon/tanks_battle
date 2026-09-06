/**
 * Проверка эффектов ходовой части и гибели без браузера.
 * Запуск: npm run check:effects
 *
 * Смотреть на них приходится глазами, но всё, что здесь можно наврать молча, —
 * это знаки и геометрия: крен не в ту сторону, отпечаток поперёк хода,
 * кольцевой буфер, который затирает не то, всплывающий остов. Три.js для этого
 * хватает и в Node: буферы и материалы — обычные объекты, контекст WebGL нужен
 * только рисованию.
 *
 * Чего здесь нет и быть не может: компиляции шейдеров. Их тела проверяются
 * глазами в игре, а автоматически — только то, что каждый атрибут геометрии
 * объявлен. Незаявленный атрибут молча не доедет до видеокарты, и эффект
 * просто не появится, без единой ошибки в консоли.
 */
import * as THREE from 'three';

import {
  bodyLean,
  DEBRIS_FIELD,
  DUST_FIELD,
  LEAN_MAX,
  ParticleField,
  TRACK_LENGTH,
  TRACK_SIDE,
  TRACK_WIDTH,
  TRACK_Y,
  trackAnchor,
  TrackMarks,
  WRECK_S,
  wreckSink,
} from '../src/client/ground.js';
import {
  BLOOM_THRESHOLD,
  GLOW_BOOM,
  GLOW_KILL,
  GLOW_MUZZLE,
  GLOW_RICOCHET,
  GLOW_SHELL,
  GLOW_TRACER,
  linearLuminance,
  litLuminance,
  PAINTED_COLORS,
} from '../src/client/look.js';
import { scaleBoxUv } from '../src/client/textures.js';

const checks: Array<[string, boolean]> = [];
const check = (label: string, ok: boolean) => checks.push([label, ok]);
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// --- 1. Крен корпуса ---

{
  // Курс 0 смотрит в +Z, правый борт — forward × up, то есть -X. Значит растущий
  // курс поворачивает влево, корпус кренится наружу — вверх идёт левый борт (+X),
  // а это положительный поворот вокруг Z.
  const left = bodyLean(0.8, 10, 0);
  const right = bodyLean(-0.8, 10, 0);
  check('поворот влево на ходу кренит корпус вправо', left.roll > 0);
  check('поворот вправо кренит зеркально', near(right.roll, -left.roll));
  check('на месте поворот не кренит', near(bodyLean(0.8, 0, 0).roll, 0));
  check('без поворота крена нет', near(bodyLean(0, 12, 0).roll, 0));

  // Задний ход с тем же поворотом руля кренит в другую сторону: наружу поворота
  // корпус уходит по ходу движения, а не по курсу.
  check('на заднем ходу крен зеркальный', near(bodyLean(0.8, -10, 0).roll, -left.roll));

  // Поворот вокруг X кладёт нос вниз, поэтому разгон должен давать минус.
  check('разгон задирает нос', bodyLean(0, 10, 11).pitch < 0);
  check('торможение роняет нос', bodyLean(0, 10, -20).pitch > 0);
  check('ровный ход не клюёт', near(bodyLean(0, 10, 0).pitch, 0));

  check('крен ограничен сверху', near(bodyLean(50, 50, 0).roll, LEAN_MAX));
  check('крен ограничен снизу', near(bodyLean(-50, 50, 0).roll, -LEAN_MAX));
  check('клевок ограничен', near(bodyLean(0, 0, -9999).pitch, LEAN_MAX));
}

// --- 2. Точки под траками ---

{
  // Курс 0: борта разъезжаются по X, оба трака смещены к корме, то есть в -Z.
  const right = trackAnchor(0, 0, 0, 1);
  const left = trackAnchor(0, 0, 0, -1);
  check('правый трак при курсе 0 уходит в -X', near(right.x, -TRACK_SIDE));
  check('левый трак при курсе 0 уходит в +X', near(left.x, TRACK_SIDE));
  check('оба трака отнесены к корме', right.z < 0 && near(right.z, left.z));
  check('колея равна ширине корпуса', near(Math.abs(left.x - right.x), TRACK_SIDE * 2));

  // Развернём танк на 90°: колея обязана развернуться вместе с ним.
  const turned = trackAnchor(0, 0, Math.PI / 2, 1);
  check('колея едет за курсом', near(turned.z, TRACK_SIDE, 1e-9));

  // И сдвинем: смещение точки равно смещению танка.
  const moved = trackAnchor(10, -4, 0, 1);
  check(
    'точка едет вместе с танком',
    near(moved.x - right.x, 10) && near(moved.z - right.z, -4),
  );
}

// --- 3. Отпечаток ложится по ходу танка ---

{
  const marks = new TrackMarks();
  const position = marks.mesh.geometry.getAttribute('position');
  const birth = marks.mesh.geometry.getAttribute('birth');

  check('до первого отпечатка буфер пуст', birth.getX(0) < -1e5);

  marks.emit(5, -3, 0, 12);

  const corner = (i: number) => ({ x: position.getX(i), y: position.getY(i), z: position.getZ(i) });
  const quad = [corner(0), corner(1), corner(2), corner(3)];

  const cx = quad.reduce((a, p) => a + p.x, 0) / 4;
  const cz = quad.reduce((a, p) => a + p.z, 0) / 4;
  check('отпечаток центрирован в заданной точке', near(cx, 5) && near(cz, -3));
  check('отпечаток лежит на земле', quad.every((p) => near(p.y, TRACK_Y)));

  // При курсе 0 ширина идёт по X, длина по Z: перепутанные оси дали бы
  // отпечаток поперёк хода, и след выглядел бы лесенкой.
  const spanX = Math.max(...quad.map((p) => p.x)) - Math.min(...quad.map((p) => p.x));
  const spanZ = Math.max(...quad.map((p) => p.z)) - Math.min(...quad.map((p) => p.z));
  check('ширина отпечатка поперёк хода', near(spanX, TRACK_WIDTH));
  check('длина отпечатка вдоль хода', near(spanZ, TRACK_LENGTH));
  check('время рождения записано во все вершины', [0, 1, 2, 3].every((i) => birth.getX(i) === 12));

  // Тот же отпечаток, но танк развёрнут на 90°: оси обязаны поменяться местами.
  marks.emit(0, 0, Math.PI / 2, 13);
  const turned = [4, 5, 6, 7].map(corner);
  const turnedX = Math.max(...turned.map((p) => p.x)) - Math.min(...turned.map((p) => p.x));
  const turnedZ = Math.max(...turned.map((p) => p.z)) - Math.min(...turned.map((p) => p.z));
  check('на развороте длина уходит по X', near(turnedX, TRACK_LENGTH, 1e-6));
  check('на развороте ширина уходит по Z', near(turnedZ, TRACK_WIDTH, 1e-6));
}

// --- 4. Кольцевой буфер следов ---

{
  const marks = new TrackMarks();
  const birth = marks.mesh.geometry.getAttribute('birth');
  const quads = birth.count / 4;

  for (let i = 0; i < quads; i++) marks.emit(i, 0, 0, i);
  check('буфер заполнен целиком', birth.getX(0) === 0 && birth.getX((quads - 1) * 4) === quads - 1);

  // Ещё один отпечаток обязан затереть самый старый, а не самый свежий.
  marks.emit(999, 0, 0, 1000);
  check('кольцо затирает самый старый отпечаток', birth.getX(0) === 1000);
  check('свежие отпечатки не тронуты', birth.getX((quads - 1) * 4) === quads - 1);

  marks.clear();
  let alive = 0;
  for (let i = 0; i < birth.count; i++) if (birth.getX(i) > -1e5) alive++;
  check('смена карты стирает все следы', alive === 0);

  // Индекс 16-битный: подняв ёмкость буфера выше 16384 отпечатков, её молча
  // порвёт — половина следов начнёт ссылаться на чужие вершины.
  check('вершины влезают в 16-битный индекс', birth.count <= 65536);
}

// --- 4б. Частичная заливка буфера ---

{
  // В видеопамять должен уезжать только тронутый кусок. Ошибка здесь не видна
  // глазом: картинка останется правильной, просто каждый кадр будет тащить
  // сотню килобайт вместо сотни байт.
  const marks = new TrackMarks();
  const position = marks.mesh.geometry.getAttribute('position') as {
    updateRanges: Array<{ start: number; count: number }>;
  };

  check('до эмиссии заливать нечего', position.updateRanges.length === 0);

  marks.emit(0, 0, 0, 1);
  check(
    'отпечаток заявляет ровно свои четыре вершины',
    position.updateRanges.length === 1 &&
      position.updateRanges[0].start === 0 &&
      position.updateRanges[0].count === 12,
  );

  marks.emit(0, 0, 0, 2);
  check(
    'второй отпечаток заявляет следующий кусок',
    position.updateRanges.length === 2 && position.updateRanges[1].start === 12,
  );

  // А вот очистка обязана сбросить диапазоны: с ними рендерер зальёт только
  // пару свежих отпечатков, и следы прошлой карты остались бы на новой.
  marks.clear();
  check('очистка требует полной заливки', position.updateRanges.length === 0);

  const dust = new ParticleField(DUST_FIELD);
  const dustBirth = dust.points.geometry.getAttribute('birth') as {
    updateRanges: Array<{ start: number; count: number }>;
  };
  dust.emit(0, 0, 0, 0, 0, 0, 1, 1);
  check('пылинка заявляет одну ячейку', dustBirth.updateRanges.length === 1);
  dust.clear();
  check('гашение пыли требует полной заливки', dustBirth.updateRanges.length === 0);
}

// --- 5. Пыль ---

{
  const dust = new ParticleField(DUST_FIELD);
  const geometry = dust.points.geometry;
  const birth = geometry.getAttribute('birth');
  const position = geometry.getAttribute('position');
  const velocity = geometry.getAttribute('velocity');
  const size = geometry.getAttribute('size');

  dust.emit(1, 2, 3, 4, 5, 6, 7, 8);
  check(
    'пылинка записана целиком',
    position.getX(0) === 1 &&
      position.getY(0) === 2 &&
      position.getZ(0) === 3 &&
      velocity.getX(0) === 4 &&
      velocity.getY(0) === 5 &&
      velocity.getZ(0) === 6 &&
      size.getX(0) === 7 &&
      birth.getX(0) === 8,
  );

  // Буфер по кругу: после переполнения запись возвращается в начало.
  for (let i = 1; i < birth.count; i++) dust.emit(0, 0, 0, 0, 0, 0, 1, i);
  dust.emit(42, 0, 0, 0, 0, 0, 1, 777);
  check('пыль пишется по кругу', birth.getX(0) === 777 && position.getX(0) === 42);

  dust.clear();
  let alive = 0;
  for (let i = 0; i < birth.count; i++) if (birth.getX(i) > -1e5) alive++;
  check('смена карты гасит пыль', alive === 0);
}

// --- 5б. Обломки — тот же рой с другими числами ---

{
  const debris = new ParticleField(DEBRIS_FIELD);
  const birth = debris.points.geometry.getAttribute('birth');
  check('у обломков свой запас частиц', birth.count === DEBRIS_FIELD.max);
  check('обломки падают, а пыль висит', DEBRIS_FIELD.gravity < 0 && DUST_FIELD.gravity === 0);
  check('обломок не разрастается', DEBRIS_FIELD.growth === 0);
  check('обломки не проваливаются под землю', DEBRIS_FIELD.floor > 0);

  // Гравитация и потолок падения должны доехать до шейдера: без uniform'а
  // обломки полетели бы по прямой в небо и там растаяли.
  const shader = (debris.points.material as { vertexShader: string }).vertexShader;
  check('шейдер применяет гравитацию', /uGravity/.test(shader));
  check('шейдер держит частицу над землёй', /uFloor/.test(shader));
}

// --- 5в. Уход остова ---

{
  // Оставлять остов до возрождения нельзя: на сервере подбитый танк выброшен
  // и из столкновений, и из поиска цели снарядом. Он обязан исчезнуть сам.
  check('остов живёт заметно меньше возрождения', WRECK_S > 1 && WRECK_S < 2.5);

  check('в первый миг остов стоит на месте', near(wreckSink(0), 0));
  check('сразу после гибели он ещё не проседает', near(wreckSink(0.2), 0));

  const middle = wreckSink(WRECK_S / 2);
  const end = wreckSink(WRECK_S);
  check('к середине остов уже осел', middle < 0);
  check('оседание только вниз и только ускоряется', end < middle);
  check('к концу корпус целиком под землёй', end <= -2.5);

  // Кривая монотонна: подпрыгнувший на середине остов выглядел бы живым.
  let previous = 0;
  let monotonic = true;
  for (let t = 0; t <= WRECK_S; t += WRECK_S / 40) {
    const y = wreckSink(t);
    if (y > previous + 1e-9) monotonic = false;
    previous = y;
  }
  check('остов не всплывает по дороге', monotonic);

  // За концом кривая не должна уводить остов в бесконечность: кадр может
  // прийти и позже срока, а мы по этой же функции ставим корпус.
  check('после срока оседание не растёт', near(wreckSink(WRECK_S * 3), end));
}

// --- 5г. Арифметика свечения ---

{
  // Порог сравнивается с линейной яркостью кадра до тонмаппинга. Это не то же
  // самое, что «цвет выглядит ярким», и вся настройка держится на разнице.
  const glows = (hex: number, gain = 1) => linearLuminance(hex, gain) > BLOOM_THRESHOLD;

  check('порог стоит на «ярче белого»', BLOOM_THRESHOLD === 1);

  // Главное: сам по себе яркий цвет порог не берёт. Если эта проверка упадёт,
  // значит порог опустили — и светиться начнёт заодно всё подряд.
  check('жёлтый снаряд без подъёма не светится', !glows(0xffd27a));
  check('белая вспышка без подъёма не светится', !glows(0xfff3d0));

  // А с подъёмом — светится каждый источник, который должен.
  check('снаряд светится', glows(0xffd27a, GLOW_SHELL));
  check('трассер светится', glows(0xff9d3a, GLOW_TRACER));
  check('дульная вспышка светится', glows(0xfff3d0, GLOW_MUZZLE));
  check('взрыв по земле светится', glows(0xffb257, GLOW_BOOM));
  check('попадание светится', glows(0xffd27a, GLOW_BOOM));
  check('гибель светится', glows(0xff8a3c, GLOW_KILL));
  check('рикошетная искра светится', glows(0xfff4c8, GLOW_RICOCHET));

  // Дым не светится ни при каких обстоятельствах: светящийся дым — это уже туман.
  check('дым выстрела не светится', !glows(0x7d7568));
  check('дым остова не светится', !glows(0x36322c));
  check('пыль не светится', !glows(DUST_FIELD.color));
  check('обломки не светятся', !glows(DEBRIS_FIELD.color));

  // И запас снизу: ни одна крашеная поверхность в игре под этим светом до порога
  // не дотягивает. Считается по настоящим силам света и настоящим цветам,
  // поэтому проверка поймает и поднятое солнце, и новый слишком светлый материал.
  const brightest = Math.max(...PAINTED_COLORS.map(litLuminance));
  check('ни одна крашеная поверхность не светится', brightest < BLOOM_THRESHOLD);
  // Половина порога — не придирка: блик добавляет к диффузной части сверху,
  // и без запаса светиться начали бы края освещённых граней.
  check('и запас при этом двукратный', brightest < BLOOM_THRESHOLD * 0.5);
}

// --- 5д. Развёртка коробок под текстуру ---

{
  /**
   * Проверяем не «правильно ли переставлены грани», а само свойство, ради
   * которого всё затевалось: на каждой грани клетка текстуры должна занимать
   * ровно tile метров по обеим осям. Так проверка не зависит от того, в каком
   * порядке BoxGeometry раскладывает грани, и переживёт смену версии three.
   */
  const facesTiled = (w: number, h: number, d: number, tile: number): boolean => {
    const geometry = new THREE.BoxGeometry(w, h, d);
    scaleBoxUv(geometry, w, h, d, tile);
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');

    for (let face = 0; face < 6; face++) {
      const span = (get: (i: number) => number) => {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < 4; i++) {
          const v = get(face * 4 + i);
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
        return hi - lo;
      };

      // Две ненулевые стороны грани в метрах и две стороны её развёртки в клетках.
      const metres = [span((i) => position.getX(i)), span((i) => position.getY(i)), span((i) => position.getZ(i))]
        .filter((v) => v > 1e-6)
        .sort((a, b) => a - b);
      const cells = [span((i) => uv.getX(i)), span((i) => uv.getY(i))]
        .map((v) => v * tile)
        .sort((a, b) => a - b);

      if (metres.length !== 2) return false;
      if (Math.abs(metres[0] - cells[0]) > 1e-6) return false;
      if (Math.abs(metres[1] - cells[1]) > 1e-6) return false;
    }
    return true;
  };

  check('на кубе клетка везде одного размера', facesTiled(4, 4, 4, 4));
  check('на вытянутом блоке грани не растягиваются', facesTiled(20, 3, 6, 4));
  check('на стене во всю карту тоже', facesTiled(144, 4, 2, 4));
  check('размер клетки соблюдается и при другом tile', facesTiled(20, 3, 6, 9));
}

// --- 6. Шейдеры собраны без опечаток в объявлениях ---

{
  // Скомпилировать их без контекста нельзя, но сверить, что каждый атрибут
  // геометрии объявлен в шейдере, — можно. Незаявленный атрибут молча не
  // доедет до видеокарты, и эффект просто не появится, без единой ошибки.
  const declared = (source: string, name: string) =>
    new RegExp(`attribute\\s+\\w+\\s+${name}\\s*;`).test(source);

  const marks = new TrackMarks();
  const trackShader = (marks.mesh.material as { vertexShader: string }).vertexShader;
  check('след объявляет birth', declared(trackShader, 'birth'));

  const dust = new ParticleField(DUST_FIELD);
  const dustShader = (dust.points.material as { vertexShader: string }).vertexShader;
  for (const name of ['velocity', 'birth', 'size']) {
    check(`пыль объявляет ${name}`, declared(dustShader, name));
  }
  // position приходит от самого three.js, объявлять его повторно нельзя.
  check('position не объявлен повторно', !declared(dustShader, 'position'));
}

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
}
console.log(failed === 0 ? `EFFECTS OK: ${checks.length} проверок` : `EFFECTS FAILED: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
