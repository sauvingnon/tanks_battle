/**
 * Высадка сквадов в королевской битве — отдельно от Room, потому что это не
 * бой, а один вопрос: куда честно уронить сквад. Ответ один и тот же для
 * человека и бота — случайная свободная точка внутри круга безопасной зоны,
 * без привязки к заранее расставленным точкам спавна карты. Карта огромная,
 * а зона в первой фазе матча — вся карта целиком (см. startRoyale в room.ts),
 * так что «случайно» здесь и значит «где угодно».
 */
import { TANK_RADIUS } from '../shared/constants.js';
import {
  boxCollisionSize,
  circleIntersectsPolygon,
  type Box,
  worldCollisionPolygon,
} from '../shared/types.js';

export interface RoyaleZoneCircle {
  x: number;
  z: number;
  r: number;
}

export interface RoyaleDrop {
  x: number;
  z: number;
  angle: number;
}

/** Смещения членов сквада от общей точки высадки — плотная кучка, не толпа. */
function formationSlots(squadSize: number): Array<[number, number]> {
  if (squadSize <= 1) return [[0, 0]];
  if (squadSize === 2) return [[-3.2, 0], [3.2, 0]];
  return [[-3.2, -2.8], [3.2, -2.8], [-3.2, 2.8], [3.2, 2.8]];
}

const SQUAD_CLEARANCE = 6;
const DROP_ATTEMPTS = 80;

/**
 * Живёт ровно один матч: копит уже занятые точки по ходу расстановки, чтобы
 * следующий сквад не приземлился на предыдущий. Создавать заново на каждый
 * матч — состояние не должно переживать рестарт.
 */
export class RoyaleSpawner {
  private readonly placed: Array<{ x: number; z: number }> = [];

  constructor(
    private readonly half: number,
    private readonly obstacles: Box[],
  ) {}

  private pointIsFree(x: number, z: number): boolean {
    if (Math.abs(x) > this.half - TANK_RADIUS || Math.abs(z) > this.half - TANK_RADIUS) return false;
    for (const box of this.obstacles) {
      const tankRadius = box.collisionTankRadius ?? TANK_RADIUS;
      if (box.collisionPolygon && box.collisionPolygon.length >= 3) {
        if (circleIntersectsPolygon(x, z, tankRadius, worldCollisionPolygon(box))) return false;
        continue;
      }
      if (box.collisionRadius !== undefined) {
        if (Math.hypot(x - box.x, z - box.z) <= box.collisionRadius + tankRadius) return false;
        continue;
      }
      const size = boxCollisionSize(box);
      if (
        Math.abs(x - box.x) <= size.w / 2 + tankRadius &&
        Math.abs(z - box.z) <= size.d / 2 + tankRadius
      ) {
        return false;
      }
    }
    for (const p of this.placed) {
      if (Math.hypot(x - p.x, z - p.z) < SQUAD_CLEARANCE) return false;
    }
    return true;
  }

  /**
   * Высаживает один сквад: случайная точка внутри круга зоны, случайный
   * разворот формации, отбраковка занятых и заставленных мест. Возвращает
   * позицию на каждого члена сквада, включая ещё не созданных ботов —
   * вызывающий код сам решает, кому какой слот отдать.
   */
   squadDrop(zone: RoyaleZoneCircle, squadSize: number): RoyaleDrop[] {
    const slots = formationSlots(squadSize);
    for (let attempt = 0; attempt < DROP_ATTEMPTS; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      // sqrt даёт равномерную плотность по площади круга, а не сгущение к центру.
      const radius = Math.sqrt(Math.random()) * Math.max(0, zone.r - 15);
      const cx = zone.x + Math.sin(angle) * radius;
      const cz = zone.z + Math.cos(angle) * radius;
      const facing = Math.random() * Math.PI * 2;
      const tangentX = Math.cos(facing);
      const tangentZ = -Math.sin(facing);
      const alongX = Math.sin(facing);
      const alongZ = Math.cos(facing);
      const formation = slots.map(([lateral, depth]) => ({
        x: cx + tangentX * lateral + alongX * depth,
        z: cz + tangentZ * lateral + alongZ * depth,
      }));
      if (formation.every((point) => this.pointIsFree(point.x, point.z))) {
        this.placed.push(...formation);
        return formation.map((point) => ({ x: point.x, z: point.z, angle: facing }));
      }
    }

    // Крайний случай — переполненная или тесная карта, где отбраковка не
    // находит места за разумное число попыток. Группировка важнее полной
    // проверки на занятость: сквад всё равно высаживается вместе.
    const facing = Math.random() * Math.PI * 2;
    const tangentX = Math.cos(facing);
    const tangentZ = -Math.sin(facing);
    return slots.map(([lateral]) => ({
      x: zone.x + tangentX * lateral,
      z: zone.z + tangentZ * lateral,
      angle: facing,
    }));
  }
}
