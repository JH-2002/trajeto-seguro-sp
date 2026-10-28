import { CONFIG } from '../config';
import { DensityGrid } from '../risk/densityGrid';
import type { RiskModel } from '../risk/scoring';
import {
  CRIME_CATEGORIES,
  HOUR_SLOTS,
  UNKNOWN_HOUR,
  isNightHour,
  type AccidentDataset,
  type AccidentPoint,
  type CrimeCategory,
  type CrimeDataset,
  type HourFilter,
  type LightPoint,
  type LightingDataset,
  type MapPoint,
} from '../types';

const NCAT = CRIME_CATEGORIES.length;
const SLOTS = NCAT * HOUR_SLOTS;

export interface CrimeFilter {
  categories: Set<CrimeCategory>;
  hour: HourFilter;
  /** Dá mais peso a ocorrências recentes no cálculo de risco. */
  recency: boolean;
}

/** Crimes decodificados em arrays tipados (uma vez), para filtrar rápido a cada mudança. */
export interface CrimeStore {
  ds: CrimeDataset;
  n: number;
  lon: Float64Array;
  lat: Float64Array;
  /** n × (categorias × 25 horas) */
  slots: Float32Array;
  /** n × categorias */
  totals: Float32Array;
  recent: Float32Array;
  cur: Float32Array;
  prev: Float32Array;
}

export type LoadResult = {
  crimes: CrimeStore | null;
  accidents: AccidentDataset | null;
  lighting: LightingDataset | null;
  problem?: string;
};

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}${path}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function loadDatasets(): Promise<LoadResult> {
  const [crimes, accidents, lighting] = await Promise.all([
    fetchJson<CrimeDataset>('data/crimes.json'),
    fetchJson<AccidentDataset>('data/accidents.json'),
    fetchJson<LightingDataset>('data/lighting.json'),
  ]);
  if (crimes && crimes.version !== 2) {
    return { crimes: null, accidents, lighting, problem: 'Os dados de crimes estão no formato antigo. Rode <code>npm run data:demo</code> ou <code>npm run data -- --raw-dir data/raw</code> de novo.' };
  }
  return { crimes: crimes ? decodeCrimes(crimes) : null, accidents, lighting };
}

export function decodeCrimes(ds: CrimeDataset): CrimeStore {
  const n = ds.cells.length;
  const s: CrimeStore = {
    ds,
    n,
    lon: new Float64Array(n),
    lat: new Float64Array(n),
    slots: new Float32Array(n * SLOTS),
    totals: new Float32Array(n * NCAT),
    recent: new Float32Array(n * NCAT),
    cur: new Float32Array(n * NCAT),
    prev: new Float32Array(n * NCAT),
  };
  ds.cells.forEach(([lon, lat, pairs, recent, cur, prev], i) => {
    s.lon[i] = lon;
    s.lat[i] = lat;
    for (let k = 0; k < pairs.length; k += 2) {
      const code = pairs[k];
      s.slots[i * SLOTS + code] = pairs[k + 1];
      s.totals[i * NCAT + Math.floor(code / HOUR_SLOTS)] += pairs[k + 1];
    }
    for (let c = 0; c < NCAT; c++) {
      s.recent[i * NCAT + c] = recent[c] ?? 0;
      s.cur[i * NCAT + c] = cur[c] ?? 0;
      s.prev[i * NCAT + c] = prev[c] ?? 0;
    }
  });
  return s;
}

/**
 * Peso de cada hora para um filtro. Uma hora específica usa uma janela suave
 * (vizinhas valem 0,5), o que deixa a animação contínua; ocorrências sem horário
 * entram com a fração proporcional à janela.
 */
export function hourWeights(hour: HourFilter): Float32Array {
  const w = new Float32Array(HOUR_SLOTS);
  if (hour === 'todos') {
    w.fill(1);
    return w;
  }
  w[hour] = 1;
  w[(hour + 1) % 24] = 0.5;
  w[(hour + 23) % 24] = 0.5;
  w[UNKNOWN_HOUR] = 2 / 24;
  return w;
}

export function buildCrimePoints(store: CrimeStore, filter: CrimeFilter): { points: MapPoint[]; total: number } {
  const hw = hourWeights(filter.hour);
  // Só as horas com peso entram no laço (4 de 25 quando há hora escolhida).
  const activeHours: number[] = [];
  for (let h = 0; h < HOUR_SLOTS; h++) if (hw[h] > 0) activeHours.push(h);
  const cats = CRIME_CATEGORIES.map((c, i) => ({ i, w: CONFIG.risk.crimeWeights[c] })).filter((c) =>
    filter.categories.has(CRIME_CATEGORIES[c.i]),
  );

  // Recência: cada célula é escalada pela razão (ponderado ÷ total) relativa à média da cidade.
  let cityRatio = 1;
  if (filter.recency) {
    let r = 0;
    let t = 0;
    for (let i = 0; i < store.n; i++)
      for (const c of cats) {
        r += store.recent[i * NCAT + c.i];
        t += store.totals[i * NCAT + c.i];
      }
    cityRatio = t > 0 ? r / t : 1;
  }

  const points: MapPoint[] = [];
  let total = 0;
  for (let i = 0; i < store.n; i++) {
    let count = 0;
    let risk = 0;
    let rec = 0;
    let tot = 0;
    for (const c of cats) {
      const base = i * SLOTS + c.i * HOUR_SLOTS;
      let nCat = 0;
      for (const h of activeHours) {
        const v = store.slots[base + h];
        if (v) nCat += v * hw[h];
      }
      count += nCat;
      risk += nCat * c.w;
      if (filter.recency) {
        rec += store.recent[i * NCAT + c.i];
        tot += store.totals[i * NCAT + c.i];
      }
    }
    if (count <= 0) continue;
    if (filter.recency && tot > 0 && cityRatio > 0) risk *= rec / tot / cityRatio;
    points.push({ position: [store.lon[i], store.lat[i]], count, risk });
    total += count;
  }
  return { points, total: Math.round(total) };
}

export function buildAccidentPoints(ds: AccidentDataset): AccidentPoint[] {
  return ds.cells.map((c) => {
    const total = c[2] ?? 0;
    const fatal = c[3] ?? 0;
    return {
      position: [c[0], c[1]],
      total,
      fatal,
      risk: (total - fatal) * CONFIG.risk.accidentWeight + fatal * CONFIG.risk.fatalAccidentWeight,
    };
  });
}

export function buildLightPoints(ds: LightingDataset): LightPoint[] {
  return ds.cells.map((c) => ({ position: [c[0], c[1]], n: c[2] ?? 0 }));
}

export interface RiskInputs {
  crimes: MapPoint[];
  accidents: AccidentPoint[] | null;
  lights: LightPoint[] | null;
  avoidAccidents: boolean;
  hour: HourFilter;
}

export function buildRiskModel({ crimes, accidents, lights, avoidAccidents, hour }: RiskInputs): RiskModel {
  const crime = new DensityGrid(CONFIG.risk.radiusM);
  for (const p of crimes) crime.add(p.position, p.risk);

  let accident: DensityGrid | null = null;
  if (avoidAccidents && accidents && accidents.length > 0) {
    accident = new DensityGrid(CONFIG.risk.radiusM);
    for (const p of accidents) accident.add(p.position, p.risk);
  }

  const [median, threshold] = crime.densityPercentiles([0.5, CONFIG.risk.hotspotPercentile]);

  let accidentFactor = CONFIG.risk.accidentFactor;
  if (accident) {
    const [accMedian] = accident.densityPercentiles([0.5]);
    if (accMedian > 0 && median > 0) accidentFactor *= median / accMedian;
  }

  // Iluminação: grade de curto alcance (escala de rua). A referência é o nível de uma
  // rua tipicamente iluminada da cidade; abaixo dela o trecho conta como parcialmente escuro.
  let light: DensityGrid | null = null;
  let lightRef = 0;
  if (lights && lights.length > 0) {
    light = new DensityGrid(CONFIG.lighting.radiusM);
    for (const p of lights) light.add(p.position, p.n);
    [lightRef] = light.densityPercentiles([CONFIG.lighting.referencePercentile]);
  }

  return {
    crime,
    accident,
    light,
    lightRef,
    night: isNightHour(hour),
    hotspotThreshold: threshold,
    reference: median,
    accidentFactor,
    sampleStepM: CONFIG.risk.sampleStepM,
  };
}
