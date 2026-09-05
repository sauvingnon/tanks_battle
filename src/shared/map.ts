import { MAP_HALF } from './constants.js';
import type { Box } from './types.js';

/**
 * Статичная карта: симметричная расстановка блоков вокруг центра.
 * Сервер отдаёт её клиенту в welcome, так что менять можно только тут.
 */
export function buildMap(): Box[] {
  const boxes: Box[] = [];

  const add = (x: number, z: number, w: number, d: number, h: number) => {
    boxes.push({ x, z, w, d, h });
  };

  // Центральный «кремль».
  add(0, 0, 14, 14, 5);
  add(0, 22, 20, 4, 3);
  add(0, -22, 20, 4, 3);
  add(22, 0, 4, 20, 3);
  add(-22, 0, 4, 20, 3);

  // Четыре угловых укрытия — поворотная симметрия на 90 градусов.
  for (const [sx, sz] of [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ]) {
    add(sx * 42, sz * 42, 16, 6, 4);
    add(sx * 42, sz * 30, 6, 10, 2.5);
    add(sx * 55, sz * 18, 8, 8, 3.5);
  }

  // Редкие одиночные блоки, чтобы поле не было пустым.
  add(0, 48, 10, 6, 3);
  add(0, -48, 10, 6, 3);
  add(48, 0, 6, 10, 3);
  add(-48, 0, 6, 10, 3);

  return boxes;
}

/** Точки респавна по кругу, лицом к центру карты. */
export function spawnPoint(index: number): { x: number; z: number; angle: number } {
  const count = 12;
  const slot = index % count;
  const angleAround = (slot / count) * Math.PI * 2;
  const radius = MAP_HALF - 10;
  const x = Math.sin(angleAround) * radius;
  const z = Math.cos(angleAround) * radius;
  // Разворачиваем к центру: направление (0,0) - (x,z).
  const angle = Math.atan2(-x, -z);
  return { x, z, angle };
}
