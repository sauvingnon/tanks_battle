/**
 * Проверка вида сверху: куда на экране уезжает мир, попадает ли ствол туда, куда
 * ткнули пальцем, и одинаково ли видно вокруг себя в портрете и в ландшафте.
 *
 * Стенд нужен потому, что все ошибки тут молчаливые. Перепутанный знак в up или
 * в atan2 даёт зеркальную карту: она выглядит совершенно нормально, но танк едет
 * не туда, куда его ведут, а понять это можно только в бою.
 * Запуск: npm run check:view
 */
import * as THREE from 'three';

import { TOP_HEIGHT, TOP_ZOOM_SCALE, aimAngle, topFrustum, topParticleFov } from '../src/client/topview.js';

/** Зум по умолчанию — тот же, что стоит в Controls. */
const ZOOM_DEFAULT = 15;

let bad = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) bad++;
  console.log(`  ${ok ? '·' : '!'} ${label}${detail ? ` — ${detail}` : ''}${ok ? '' : ' — ПЛОХО'}`);
}

/** Камера ровно та же, что собирает Scene3D: важен каждый знак. */
function makeCamera(radius: number, width: number, height: number, at: { x: number; z: number }) {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, TOP_HEIGHT * 2);
  camera.up.set(0, 0, -1);
  const { halfWidth, halfHeight } = topFrustum(radius, width / height);
  camera.left = -halfWidth;
  camera.right = halfWidth;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.updateProjectionMatrix();
  camera.position.set(at.x, TOP_HEIGHT, at.z);
  camera.lookAt(at.x, 0, at.z);
  camera.updateMatrixWorld();

  const toScreen = (x: number, y: number, z: number) => {
    const p = new THREE.Vector3(x, y, z).project(camera);
    return { x: (p.x * 0.5 + 0.5) * width, y: (-p.y * 0.5 + 0.5) * height, depth: p.z };
  };
  return { camera, toScreen, halfWidth, halfHeight };
}

const radius = ZOOM_DEFAULT * TOP_ZOOM_SCALE;

// Танк намеренно не в начале координат: ошибка «камера смотрит в центр карты, а
// не на танк» иначе не видна вовсе.
const tank = { x: 12, z: -30 };

for (const [width, height, name] of [
  [1600, 900, 'ландшафт 16:9'],
  [800, 1600, 'портрет 1:2'],
  [1000, 1000, 'квадрат'],
] as Array<[number, number, string]>) {
  console.log(`\n=== ${name} (${width}x${height}), обзор ${radius} м ===`);
  const { toScreen, halfWidth, halfHeight } = makeCamera(radius, width, height, tank);

  const centre = toScreen(tank.x, 0, tank.z);
  check(
    'танк ровно в центре кадра',
    Math.abs(centre.x - width / 2) < 1e-6 && Math.abs(centre.y - height / 2) < 1e-6,
    `(${centre.x.toFixed(1)}, ${centre.y.toFixed(1)})`,
  );
  check('земля попадает в глубину отсечения', centre.depth > -1 && centre.depth < 1);

  // Оси экрана. Мир под ортокамерой не должен ни зеркалиться, ни заваливаться:
  // движение строго по одной оси мира обязано быть движением строго по одной оси экрана.
  const east = toScreen(tank.x + 10, 0, tank.z);
  const north = toScreen(tank.x, 0, tank.z - 10);
  check(
    '+X мира уходит вправо и только вправо',
    east.x > centre.x && Math.abs(east.y - centre.y) < 1e-6,
  );
  check(
    '-Z мира уходит вверх и только вверх',
    north.y < centre.y && Math.abs(north.x - centre.x) < 1e-6,
  );

  // Радиус по короткой стороне: телефон в портрете не должен видеть меньше.
  const short = Math.min(halfWidth, halfHeight);
  check(
    'по короткой стороне видно ровно радиус',
    Math.abs(short - radius) < 1e-9,
    `${short.toFixed(2)} м`,
  );

  // Масштаб не зависит от направления: метр по X и метр по Z — одинаковое число
  // пикселей. Иначе карта растянута, и на глаз расстояния врут.
  const pxPerMetreX = (east.x - centre.x) / 10;
  const pxPerMetreZ = (centre.y - north.y) / 10;
  check(
    'масштаб одинаков по обеим осям',
    Math.abs(pxPerMetreX - pxPerMetreZ) < 1e-9,
    `${pxPerMetreX.toFixed(2)} px/м`,
  );

  // Обратный ход: тычок в экран -> угол наводки -> точка в мире под этим углом.
  // Она обязана спроецироваться на тот же луч из центра, что и сам тычок.
  let worst = 0;
  for (const [sx, sy] of [
    [width - 40, 60],
    [40, height - 40],
    [width / 2, 30],
    [width - 30, height / 2],
    [width / 2 + 1, height / 2 + 90],
  ]) {
    const yaw = aimAngle(sx - width / 2, sy - height / 2);
    const shot = toScreen(tank.x + Math.sin(yaw) * 15, 0, tank.z + Math.cos(yaw) * 15);
    const want = Math.atan2(sy - centre.y, sx - centre.x);
    const got = Math.atan2(shot.y - centre.y, shot.x - centre.x);
    worst = Math.max(worst, Math.abs(Math.atan2(Math.sin(want - got), Math.cos(want - got))));
  }
  check(
    'ствол смотрит туда же, куда ткнули',
    worst < 1e-9,
    `худшее расхождение ${(((worst * 180) / Math.PI).toExponential(1))}°`,
  );

  // Частицы: подобранный fov обязан дать у земли тот же масштаб, что и орто.
  const fov = topParticleFov(halfHeight);
  const scale = height / (2 * Math.tan((fov * Math.PI) / 360));
  check(
    'размер пылинок совпадает с масштабом карты',
    Math.abs(scale / TOP_HEIGHT - height / (2 * halfHeight)) < 1e-9,
    `${(scale / TOP_HEIGHT).toFixed(3)} px/м`,
  );
}

console.log(bad === 0 ? '\nВид сверху сходится' : `\nПроблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
