/**
 * Проверяет, что ни одна точка спавна не попадает внутрь препятствия или стены.
 * Запуск: npm run check:map
 */
import { MAP_HALF, TANK_RADIUS } from '../src/shared/constants.js';
import { buildMap, spawnPoint } from '../src/shared/map.js';

const boxes = buildMap();
const SPAWN_COUNT = 12;
let bad = 0;

for (let i = 0; i < SPAWN_COUNT; i++) {
  const spawn = spawnPoint(i);

  let nearestBox = Infinity;
  for (const box of boxes) {
    const hw = box.w / 2;
    const hd = box.d / 2;
    const nx = Math.min(Math.max(spawn.x, box.x - hw), box.x + hw);
    const nz = Math.min(Math.max(spawn.z, box.z - hd), box.z + hd);
    nearestBox = Math.min(nearestBox, Math.hypot(spawn.x - nx, spawn.z - nz));
  }

  const toWall = MAP_HALF - Math.max(Math.abs(spawn.x), Math.abs(spawn.z));
  const ok = nearestBox >= TANK_RADIUS && toWall >= TANK_RADIUS;
  if (!ok) bad++;

  console.log(
    `#${i} (${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)}) ` +
      `до блока ${nearestBox.toFixed(2)} м, до стены ${toWall.toFixed(2)} м — ${ok ? 'ок' : 'ЗАДЕВАЕТ'}`,
  );
}

console.log(bad === 0 ? `Все ${SPAWN_COUNT} спавнов чистые` : `Проблемных спавнов: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
