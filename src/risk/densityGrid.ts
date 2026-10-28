import type { LngLat } from '../types';
import { METERS_PER_DEG_LAT, metersPerDegLon } from '../utils/geo';

interface Entry {
  x: number;
  y: number;
  w: number;
}

/**
 * Índice espacial em grade para estimar densidade de ocorrências em torno de um ponto
 * (kernel biquadrático: peso máximo no centro, zero a partir de `radiusM`).
 */
export class DensityGrid {
  private readonly buckets = new Map<string, Entry[]>();
  private readonly cellM: number;
  private readonly refLat: number;
  private readonly mLon: number;
  private totalWeight = 0;

  constructor(
    readonly radiusM: number,
    refLat = -23.55,
  ) {
    this.cellM = radiusM;
    this.refLat = refLat;
    this.mLon = metersPerDegLon(refLat);
  }

  get size(): number {
    return this.totalWeight;
  }

  private project(p: LngLat): [number, number] {
    return [p[0] * this.mLon, (p[1] - this.refLat) * METERS_PER_DEG_LAT];
  }

  add(position: LngLat, weight: number): void {
    if (!(weight > 0)) return;
    const [x, y] = this.project(position);
    const key = `${Math.floor(x / this.cellM)}:${Math.floor(y / this.cellM)}`;
    let bucket = this.buckets.get(key);
    if (!bucket) this.buckets.set(key, (bucket = []));
    bucket.push({ x, y, w: weight });
    this.totalWeight += weight;
  }

  /** Densidade ponderada em torno do ponto (unidades de "ocorrências equivalentes"). */
  densityAt(position: LngLat): number {
    const [x, y] = this.project(position);
    const cx = Math.floor(x / this.cellM);
    const cy = Math.floor(y / this.cellM);
    const r2 = this.radiusM * this.radiusM;
    let sum = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this.buckets.get(`${cx + dx}:${cy + dy}`);
        if (!bucket) continue;
        for (const e of bucket) {
          const d2 = (e.x - x) ** 2 + (e.y - y) ** 2;
          if (d2 >= r2) continue;
          const u = 1 - d2 / r2;
          sum += e.w * u * u;
        }
      }
    }
    return sum;
  }

  /**
   * Percentis da densidade medida nos próprios pontos com ocorrência. Servem de régua
   * para "trecho crítico" e para normalizar o índice de risco.
   */
  densityPercentiles(ps: number[], maxProbe = 6000): number[] {
    const probes: LngLat[] = [];
    const all: Entry[] = [];
    for (const bucket of this.buckets.values()) all.push(...bucket);
    if (all.length === 0) return ps.map(() => 0);
    const step = Math.max(1, Math.floor(all.length / maxProbe));
    for (let i = 0; i < all.length; i += step) {
      const e = all[i];
      probes.push([e.x / this.mLon, e.y / METERS_PER_DEG_LAT + this.refLat]);
    }
    const values = probes.map((p) => this.densityAt(p)).sort((a, b) => a - b);
    return ps.map((p) => values[Math.min(values.length - 1, Math.floor(p * values.length))]);
  }
}
