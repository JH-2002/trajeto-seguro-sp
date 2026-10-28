/** Longitude, latitude (ordem GeoJSON). */
export type LngLat = [number, number];

export const CRIME_CATEGORIES = ['violento', 'roubo', 'furto', 'outros'] as const;
export type CrimeCategory = (typeof CRIME_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<CrimeCategory, string> = {
  violento: 'Crimes violentos',
  roubo: 'Roubos',
  furto: 'Furtos',
  outros: 'Outros',
};

/** 24 horas + 1 posição para ocorrências sem horário registrado. */
export const HOUR_SLOTS = 25;
export const UNKNOWN_HOUR = 24;

/** Código do contador (categoria, hora) usado nos pares esparsos das células. */
export function slotCode(cat: number, hour: number | null): number {
  return cat * HOUR_SLOTS + (hour === null ? UNKNOWN_HOUR : hour);
}

/** 'todos' ou uma hora de 0 a 23. */
export type HourFilter = 'todos' | number;

export function isNightHour(h: HourFilter): boolean {
  return h !== 'todos' && (h >= 18 || h < 6);
}

export function hourLabel(h: HourFilter): string {
  return h === 'todos' ? 'Todos os horários' : `${String(h).padStart(2, '0')}h`;
}

export interface DatasetMeta {
  source: string;
  generatedAt: string;
  /** Intervalo de datas das ocorrências (AAAA-MM-DD). */
  period?: { from: string; to: string };
  records: number;
  isDemo: boolean;
  notes?: string;
}

export interface CrimeMeta extends DatasetMeta {
  /** Meia-vida (meses) usada no peso por recência. */
  halfLifeMonths: number;
  /** Janelas de 12 meses usadas na tendência. `complete` = há dados nas duas inteiras. */
  trend?: { current: [string, string]; previous: [string, string]; complete: boolean };
}

/**
 * Célula de crimes (~110 m):
 * [lon, lat, pares, recentes, atual12m, anterior12m]
 * - pares: lista plana [código, n, código, n, ...] com código = slotCode(cat, hora)
 * - recentes: contagem ponderada por recência, por categoria
 * - atual12m / anterior12m: contagens por categoria nas janelas de tendência
 */
export type CrimeCell = [number, number, number[], number[], number[], number[]];

export interface CrimeDataset {
  version: 2;
  meta: CrimeMeta;
  cellSizeDeg: number;
  cells: CrimeCell[];
}

/** Acidentes agregados. Cada célula: [lon, lat, total, fatais]. */
export interface AccidentDataset {
  meta: DatasetMeta;
  cellSizeDeg: number;
  cells: number[][];
}

/** Iluminação agregada. Cada célula: [lon, lat, pontos de luz]. */
export interface LightingDataset {
  meta: DatasetMeta & { method: 'geosampa' | 'osm' | 'demo' };
  cellSizeDeg: number;
  cells: number[][];
}

/** Ponto pronto para as camadas: `count` alimenta o visual, `risk` alimenta o roteamento. */
export interface MapPoint {
  position: LngLat;
  count: number;
  risk: number;
}

export interface AccidentPoint {
  position: LngLat;
  total: number;
  fatal: number;
  risk: number;
}

export interface LightPoint {
  position: LngLat;
  n: number;
}

export type TravelMode = 'foot' | 'bike' | 'car';

export interface Route {
  id: string;
  geometry: LngLat[];
  distanceM: number;
  durationS: number;
  /** Ponto de passagem usado para gerar a rota (desvios). */
  via?: LngLat;
}

export interface ScoredRoute extends Route {
  /** Exposição acumulada a crimes ao longo do trajeto (densidade × km). */
  crimeExposure: number;
  accidentExposure: number;
  /** Penalidade por trechos mal iluminados (só à noite). */
  darkExposure: number;
  /** Custo usado na escolha: crimes + acidentes + escuridão. */
  cost: number;
  /** 0–100, comparável entre rotas e entre buscas. */
  riskIndex: number;
  /** Trechos contínuos que passam por concentração alta. */
  hotspots: number;
  /** Pontos do trajeto acima do limiar crítico (para destacar no mapa). */
  criticalPoints: LngLat[];
  /** Fração do trajeto (0–1) em trechos bem iluminados, quando há dados de iluminação. */
  litShare?: number;
}

/** Trechos críticos da rota mais rápida que a rota sugerida evita. */
export interface AvoidedSegment {
  path: LngLat[];
  lengthM: number;
  /** Densidade máxima no trecho ÷ densidade típica da cidade. */
  intensity: number;
}

export interface Place {
  label: string;
  detail: string;
  position: LngLat;
}
