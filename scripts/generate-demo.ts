/**
 * Gera dados SINTÉTICOS para testar a interface sem baixar as bases oficiais.
 * Os focos são posicionados aleatoriamente (semente fixa) e não representam
 * a criminalidade, os acidentes ou a iluminação reais de nenhum bairro.
 *
 *   npm run data:demo
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CRIME_CATEGORIES,
  type AccidentDataset,
  type CrimeCategory,
  type CrimeDataset,
  type LightingDataset,
} from '../src/types';
import { CellAggregator, CrimeAggregator } from './lib/common';

const OUT = process.argv[2] ?? 'public/data';
const CELL = 0.001;
// Núcleo urbanizado aproximado (evita a represa e a serra ao sul).
const AREA = { w: -46.79, s: -23.72, e: -46.4, n: -23.42 };
const CENTER = { lon: -46.635, lat: -23.55 };
const MONTHS = 24;
const END = new Date(Date.UTC(2026, 8, 30)); // 30/09/2026

let seed = 20261027;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
const uniform = (a: number, b: number) => a + (b - a) * rand();
const M_LAT = 111_320;
const M_LON = 111_320 * Math.cos((-23.55 * Math.PI) / 180);
const wrapHour = (h: number) => ((Math.round(h) % 24) + 24) % 24;

/** Perfis de horário: comercial (pico 12–18h), noturno (pico 21–2h) e misto. */
type Profile = 'comercial' | 'noturno' | 'misto';
function pickHour(profile: Profile): number | null {
  if (rand() < 0.07) return null;
  if (profile === 'comercial') return wrapHour(14 + gauss() * 3.2);
  if (profile === 'noturno') return wrapHour(23 + gauss() * 3);
  return wrapHour(rand() < 0.5 ? 13 + gauss() * 4 : 20 + gauss() * 3);
}

function pickCategory(mix: number[]): CrimeCategory {
  let r = rand();
  for (let i = 0; i < mix.length; i++) if ((r -= mix[i]) <= 0) return CRIME_CATEGORIES[i];
  return 'outros';
}

/** Data aleatória nos últimos 24 meses; `trend` > 1 concentra no período recente. */
function pickDate(trend: number): string | null {
  if (rand() < 0.02) return null;
  // Amostragem com densidade linear: trend 1 = uniforme.
  const u = rand();
  const t = trend === 1 ? u : (Math.sqrt(1 + (trend ** 2 - 1) * u) - 1) / (trend - 1);
  const d = new Date(END.getTime() - (1 - t) * MONTHS * 30.4 * 86400_000);
  return d.toISOString().slice(0, 10);
}

// ---------------- crimes ----------------
const crimes = new CrimeAggregator(CELL);
let crimeCount = 0;
let minDate = '9999';
let maxDate = '0000';
const addCrime = (lon: number, lat: number, cat: CrimeCategory, hour: number | null, date: string | null) => {
  crimes.add(lon, lat, cat, hour, date);
  if (date) {
    if (date < minDate) minDate = date;
    if (date > maxDate) maxDate = date;
  }
  crimeCount++;
};

const profiles: Profile[] = ['comercial', 'noturno', 'misto'];
const clusters = Array.from({ length: 46 }, () => {
  const mix = [uniform(0.02, 0.08), uniform(0.2, 0.5), uniform(0.2, 0.55), uniform(0.05, 0.2)];
  const total = mix.reduce((a, b) => a + b, 0);
  return {
    lon: uniform(AREA.w, AREA.e),
    lat: uniform(AREA.s, AREA.n),
    sigma: uniform(300, 1300),
    size: Math.round(Math.exp(uniform(Math.log(300), Math.log(5200)))),
    mix: mix.map((m) => m / total),
    profile: profiles[Math.floor(rand() * profiles.length)],
    trend: uniform(0.6, 1.6),
  };
});

for (const c of clusters) {
  for (let i = 0; i < c.size; i++) {
    const lon = c.lon + (gauss() * c.sigma) / M_LON;
    const lat = c.lat + (gauss() * c.sigma) / M_LAT;
    addCrime(lon, lat, pickCategory(c.mix), pickHour(c.profile), pickDate(c.trend));
  }
}
// Fundo mais concentrado perto do centro (menos "poeira" uniforme que antes).
for (let i = 0; i < 14000; i++) {
  const r = Math.abs(gauss()) * 9000;
  const a = rand() * Math.PI * 2;
  const lon = CENTER.lon + (Math.cos(a) * r) / M_LON;
  const lat = CENTER.lat + (Math.sin(a) * r) / M_LAT;
  if (lon < AREA.w || lon > AREA.e || lat < AREA.s || lat > AREA.n) continue;
  addCrime(lon, lat, pickCategory([0.04, 0.3, 0.46, 0.2]), pickHour('misto'), pickDate(1));
}

// ---------------- acidentes ----------------
// Concentrados ao longo de "corredores" retos aleatórios, imitando grandes avenidas.
const accidents = new CellAggregator(CELL, 2);
let accidentCount = 0;
for (let k = 0; k < 18; k++) {
  const a: [number, number] = [uniform(AREA.w, AREA.e), uniform(AREA.s, AREA.n)];
  const ang = uniform(0, Math.PI);
  const len = uniform(4000, 14000);
  const b: [number, number] = [a[0] + (Math.cos(ang) * len) / M_LON, a[1] + (Math.sin(ang) * len) / M_LAT];
  const n = Math.round(uniform(150, 900));
  for (let i = 0; i < n; i++) {
    const t = rand();
    const lon = a[0] + (b[0] - a[0]) * t + (gauss() * 40) / M_LON;
    const lat = a[1] + (b[1] - a[1]) * t + (gauss() * 40) / M_LAT;
    accidents.add(lon, lat, 0);
    if (rand() < 0.03) accidents.add(lon, lat, 1);
    accidentCount++;
  }
}

// ---------------- iluminação ----------------
// Postes ao longo de uma malha de ruas sintética: densa no centro, rala na periferia,
// com algumas manchas escuras aleatórias.
const lights = new CellAggregator(CELL, 1);
let lightCount = 0;
const darkSpots = Array.from({ length: 30 }, () => ({ lon: uniform(AREA.w, AREA.e), lat: uniform(AREA.s, AREA.n), r: uniform(500, 1500) }));
const STEP = 0.0016; // ~175 m entre "ruas"
for (let lon = AREA.w; lon <= AREA.e; lon += STEP) {
  for (let lat = AREA.s; lat <= AREA.n; lat += STEP) {
    const dCenter = Math.hypot((lon - CENTER.lon) * M_LON, (lat - CENTER.lat) * M_LAT);
    const pStreet = Math.max(0.35, 1 - dCenter / 26000);
    if (rand() > pStreet) continue;
    const dark = darkSpots.some((s) => Math.hypot((lon - s.lon) * M_LON, (lat - s.lat) * M_LAT) < s.r);
    // Postes a cada ~35–50 m nas ruas iluminadas, como na malha real.
    const poles = dark ? 1 : 10 + Math.floor(rand() * 7);
    for (let i = 0; i < poles; i++) {
      lights.add(lon + uniform(-STEP / 2, STEP / 2), lat + uniform(-STEP / 2, STEP / 2), 0);
      lightCount++;
    }
  }
}

// ---------------- saída ----------------
const notes = 'Dados sintéticos gerados por scripts/generate-demo.ts. Não representam a realidade.';
const base = (records: number) => ({
  source: 'Demonstração (sintético)',
  generatedAt: new Date().toISOString(),
  records,
  isDemo: true,
  notes,
});

const { cells, trend } = crimes.finish(12);
const crimeDs: CrimeDataset = {
  version: 2,
  meta: { ...base(crimeCount), period: { from: minDate, to: maxDate }, halfLifeMonths: 12, trend },
  cellSizeDeg: CELL,
  cells,
};
const accDs: AccidentDataset = { meta: base(accidentCount), cellSizeDeg: CELL, cells: accidents.toCells() };
const lightDs: LightingDataset = { meta: { ...base(lightCount), method: 'demo' }, cellSizeDeg: CELL, cells: lights.toCells() };

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'crimes.json'), JSON.stringify(crimeDs));
fs.writeFileSync(path.join(OUT, 'accidents.json'), JSON.stringify(accDs));
fs.writeFileSync(path.join(OUT, 'lighting.json'), JSON.stringify(lightDs));
console.log(
  `✔ demo: ${crimeCount} crimes em ${crimes.size} células · ${accidentCount} acidentes · ${lightCount} pontos de luz em ${lights.size} células → ${OUT}/`,
);
