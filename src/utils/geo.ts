import type { LngLat } from '../types';

const EARTH_RADIUS_M = 6_371_008.8;
export const METERS_PER_DEG_LAT = 111_320;

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function metersPerDegLon(lat: number): number {
  return METERS_PER_DEG_LAT * Math.cos(toRad(lat));
}

export function haversine(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rumo inicial de a para b, em graus (0 = norte, sentido horário). */
export function bearing(a: LngLat, b: LngLat): number {
  const φ1 = toRad(a[1]);
  const φ2 = toRad(b[1]);
  const Δλ = toRad(b[0] - a[0]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Ponto a `distanceM` metros de `origin`, no rumo `bearingDeg`. */
export function destination(origin: LngLat, bearingDeg: number, distanceM: number): LngLat {
  const δ = distanceM / EARTH_RADIUS_M;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(origin[1]);
  const λ1 = toRad(origin[0]);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [toDeg(λ2), toDeg(φ2)];
}

export function lineLength(coords: LngLat[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversine(coords[i - 1], coords[i]);
  return total;
}

export interface Sample {
  position: LngLat;
  /** Comprimento de trajeto representado por esta amostra (m). */
  lengthM: number;
  /** Distância acumulada desde o início (m). */
  alongM: number;
}

/**
 * Reamostra a linha em pontos equidistantes (`stepM`), incluindo início e fim.
 * Cada amostra carrega o trecho de trajeto que representa, para integrar exposição.
 */
export function sampleLine(coords: LngLat[], stepM: number): Sample[] {
  if (coords.length === 0) return [];
  const total = lineLength(coords);
  if (coords.length === 1 || total === 0) return [{ position: coords[0], lengthM: 0, alongM: 0 }];

  const positions: { p: LngLat; along: number }[] = [{ p: coords[0], along: 0 }];
  let along = 0;
  let nextAt = stepM;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const seg = haversine(a, b);
    while (seg > 0 && nextAt <= along + seg) {
      const t = (nextAt - along) / seg;
      positions.push({ p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], along: nextAt });
      nextAt += stepM;
    }
    along += seg;
  }
  const last = positions[positions.length - 1];
  if (total - last.along > stepM * 0.25) positions.push({ p: coords[coords.length - 1], along: total });

  return positions.map((s, i) => {
    const prev = i > 0 ? positions[i - 1].along : s.along;
    const next = i < positions.length - 1 ? positions[i + 1].along : s.along;
    return { position: s.p, alongM: s.along, lengthM: (next - prev) / 2 };
  });
}

/** Fração de amostras de `a` que ficam a até `toleranceM` de alguma amostra de `b`. */
export function overlapRatio(a: LngLat[], b: LngLat[], toleranceM = 40): number {
  const sa = sampleLine(a, 60).map((s) => s.position);
  const sb = sampleLine(b, 60).map((s) => s.position);
  if (sa.length === 0 || sb.length === 0) return 0;
  const cell = toleranceM / METERS_PER_DEG_LAT;
  const index = new Set<string>();
  for (const p of sb) index.add(`${Math.round(p[0] / cell)}:${Math.round(p[1] / cell)}`);
  let hit = 0;
  for (const p of sa) {
    const x = Math.round(p[0] / cell);
    const y = Math.round(p[1] / cell);
    let found = false;
    for (let dx = -1; dx <= 1 && !found; dx++)
      for (let dy = -1; dy <= 1 && !found; dy++) found = index.has(`${x + dx}:${y + dy}`);
    if (found) hit++;
  }
  return hit / sa.length;
}

export function boundsOf(coords: LngLat[]): [LngLat, LngLat] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [[minX, minY], [maxX, maxY]];
}

export function inBbox(p: LngLat, bbox: readonly [number, number, number, number]): boolean {
  return p[0] >= bbox[0] && p[0] <= bbox[2] && p[1] >= bbox[1] && p[1] <= bbox[3];
}
