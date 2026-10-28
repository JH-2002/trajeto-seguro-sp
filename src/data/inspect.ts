import { litnessAt, type RiskModel } from '../risk/scoring';
import { CRIME_CATEGORIES, HOUR_SLOTS, type AccidentPoint, type CrimeCategory, type LngLat } from '../types';
import { METERS_PER_DEG_LAT, metersPerDegLon } from '../utils/geo';
import type { CrimeStore } from './dataStore';

const NCAT = CRIME_CATEGORIES.length;

export interface AreaStats {
  center: LngLat;
  radiusM: number;
  total: number;
  byCategory: { cat: CrimeCategory; n: number; trend: number | null }[];
  /** Ocorrências por hora (0–23), já filtradas pelas categorias. */
  byHour: number[];
  /** Ocorrências sem horário registrado. */
  unknownHour: number;
  peakHour: number | null;
  /** Variação dos últimos 12 meses vs. 12 anteriores (0,12 = +12%), se houver base. */
  trend: number | null;
  /** Densidade da área ÷ densidade típica da cidade. */
  vsCity: number | null;
  accidents: { total: number; fatal: number } | null;
  /** 0–1, ou null sem dados de iluminação. */
  litness: number | null;
}

/** Estatísticas num raio em torno do ponto clicado. */
export function inspectArea(
  store: CrimeStore,
  center: LngLat,
  radiusM: number,
  categories: Set<CrimeCategory>,
  model: RiskModel | null,
  accidents: AccidentPoint[] | null,
): AreaStats {
  const mLon = metersPerDegLon(center[1]);
  const r2 = radiusM * radiusM;
  const inRange = (lon: number, lat: number) => ((lon - center[0]) * mLon) ** 2 + ((lat - center[1]) * METERS_PER_DEG_LAT) ** 2 <= r2;
  const cats = CRIME_CATEGORIES.map((c, i) => ({ c, i })).filter(({ c }) => categories.has(c));

  const byHour = new Array<number>(24).fill(0);
  let unknownHour = 0;
  const catTotals = new Array<number>(NCAT).fill(0);
  const cur = new Array<number>(NCAT).fill(0);
  const prev = new Array<number>(NCAT).fill(0);

  for (let i = 0; i < store.n; i++) {
    if (!inRange(store.lon[i], store.lat[i])) continue;
    for (const { i: c } of cats) {
      const base = i * NCAT * HOUR_SLOTS + c * HOUR_SLOTS;
      for (let h = 0; h < 24; h++) byHour[h] += store.slots[base + h];
      unknownHour += store.slots[base + 24];
      catTotals[c] += store.totals[i * NCAT + c];
      cur[c] += store.cur[i * NCAT + c];
      prev[c] += store.prev[i * NCAT + c];
    }
  }

  const trendAvailable = store.ds.meta.trend?.complete ?? false;
  const pct = (a: number, b: number) => (trendAvailable && b >= 5 ? a / b - 1 : null);
  const total = cats.reduce((s, { i }) => s + catTotals[i], 0);
  const curAll = cats.reduce((s, { i }) => s + cur[i], 0);
  const prevAll = cats.reduce((s, { i }) => s + prev[i], 0);

  const maxH = Math.max(...byHour);
  const peakHour = maxH > 0 ? byHour.indexOf(maxH) : null;

  let vsCity: number | null = null;
  if (model && model.reference > 0) vsCity = model.crime.densityAt(center) / model.reference;

  let acc: AreaStats['accidents'] = null;
  if (accidents) {
    acc = { total: 0, fatal: 0 };
    for (const a of accidents)
      if (inRange(a.position[0], a.position[1])) {
        acc.total += a.total;
        acc.fatal += a.fatal;
      }
  }

  return {
    center,
    radiusM,
    total: Math.round(total),
    byCategory: cats
      .map(({ c, i }) => ({ cat: c, n: Math.round(catTotals[i]), trend: pct(cur[i], prev[i]) }))
      .sort((a, b) => b.n - a.n),
    byHour,
    unknownHour: Math.round(unknownHour),
    peakHour,
    trend: pct(curAll, prevAll),
    vsCity,
    accidents: acc,
    litness: model ? areaLitness(model, center, radiusM) : null,
  };
}

/** Média da luminosidade no centro e em 8 pontos a meio raio (uma rua só não define a área). */
function areaLitness(model: RiskModel, center: LngLat, radiusM: number): number | null {
  const mLon = metersPerDegLon(center[1]);
  const pts: LngLat[] = [center];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    pts.push([center[0] + (Math.cos(a) * radiusM * 0.5) / mLon, center[1] + (Math.sin(a) * radiusM * 0.5) / METERS_PER_DEG_LAT]);
  }
  const vals = pts.map((p) => litnessAt(model, p)).filter((v): v is number => v !== null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
