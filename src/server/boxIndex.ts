import { boxCollisionSize, worldCollisionPolygon, type Box } from '../shared/types.js';

export interface BoxQuery {
  querySegment(x: number, z: number, dx: number, dz: number, padding: number): Box[];
}

interface Bounds {
  box: Box;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Broad-phase для статической геометрии. Узкие проверки остаются в sweepShell;
 * индекс только отбрасывает Box, чьи AABB не пересекают swept-отрезок.
 */
export class BoxGrid implements BoxQuery {
  private readonly cells = new Map<string, Bounds[]>();
  private readonly bounds = new Map<Box, Bounds>();

  constructor(boxes: Box[], private readonly cellSize = 32) {
    for (const box of boxes) {
      const bounds = getBounds(box);
      this.bounds.set(box, bounds);
      const minCellX = this.cell(bounds.minX);
      const maxCellX = this.cell(bounds.maxX);
      const minCellZ = this.cell(bounds.minZ);
      const maxCellZ = this.cell(bounds.maxZ);
      for (let cx = minCellX; cx <= maxCellX; cx++) {
        for (let cz = minCellZ; cz <= maxCellZ; cz++) {
          const key = `${cx}:${cz}`;
          const cell = this.cells.get(key);
          if (cell) cell.push(bounds);
          else this.cells.set(key, [bounds]);
        }
      }
    }
  }

  querySegment(x: number, z: number, dx: number, dz: number, padding: number): Box[] {
    const endX = x + dx;
    const endZ = z + dz;
    const minX = Math.min(x, endX) - padding;
    const maxX = Math.max(x, endX) + padding;
    const minZ = Math.min(z, endZ) - padding;
    const maxZ = Math.max(z, endZ) + padding;
    const candidates: Box[] = [];
    const seen = new Set<Box>();

    for (let cx = this.cell(minX); cx <= this.cell(maxX); cx++) {
      for (let cz = this.cell(minZ); cz <= this.cell(maxZ); cz++) {
        for (const bounds of this.cells.get(`${cx}:${cz}`) ?? []) {
          if (seen.has(bounds.box)) continue;
          if (
            bounds.maxX < minX ||
            bounds.minX > maxX ||
            bounds.maxZ < minZ ||
            bounds.minZ > maxZ
          )
            continue;
          seen.add(bounds.box);
          candidates.push(bounds.box);
        }
      }
    }
    return candidates;
  }

  private cell(value: number): number {
    return Math.floor(value / this.cellSize);
  }
}

function getBounds(box: Box): Bounds {
  if (box.collisionPolygon && box.collisionPolygon.length >= 3) {
    const polygon = worldCollisionPolygon(box);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [x, z] of polygon) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    return { box, minX, maxX, minZ, maxZ };
  }

  if (box.collisionRadius !== undefined) {
    return {
      box,
      minX: box.x - box.collisionRadius,
      maxX: box.x + box.collisionRadius,
      minZ: box.z - box.collisionRadius,
      maxZ: box.z + box.collisionRadius,
    };
  }

  const size = boxCollisionSize(box);
  return {
    box,
    minX: box.x - size.w / 2,
    maxX: box.x + size.w / 2,
    minZ: box.z - size.d / 2,
    maxZ: box.z + size.d / 2,
  };
}
