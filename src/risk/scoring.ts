import { CONFIG } from '../config';
import type { AvoidedSegment, LngLat, Route, ScoredRoute } from '../types';
import { METERS_PER_DEG_LAT, bearing, haversine, sampleLine } from '../utils/geo';
import type { DensityGrid } from './densityGrid';

export interface RiskModel {
  crime: DensityGrid;
  accident: DensityGrid | null;
  /** Pontos de iluminação pública (null = sem dados). */
  light: DensityGrid | null;
  /** Densidade de luz de uma rua tipicamente iluminada. */
  lightRef: number;
  /** Horário noturno selecionado: ativa o fator de iluminação. */
  night: boolean;
  /** Densidade de crimes acima da qual um trecho é considerado crítico. */
  hotspotThreshold: number;
  /** Densidade típica da cidade; normaliza o índice 0–100. */
  reference: number;
  accidentFactor: number;
  sampleStepM: number;
}

export interface ProfilePoint {
  alongM: number;
  density: number;
}

/** "Luminosidade" de 0 (escuro) a 1 (rua bem iluminada), ou null sem dados. */
export function litnessAt(model: RiskModel, p: LngLat): number | null {
  if (!model.light || model.lightRef <= 0) return null;
  return Math.min(1, model.light.densityAt(p) / model.lightRef);
}

/**
 * Pontua uma rota integrando a densidade de ocorrências ao longo do trajeto.
 * Exposição = Σ densidade(amostra) × km representado pela amostra.
 * À noite, trechos mal iluminados somam uma penalidade (crimes pesam mais no escuro,
 * e há um custo-base mesmo sem registros).
 */
export function scoreRoute(route: Route, model: RiskModel): ScoredRoute {
  const samples = sampleLine(route.geometry, model.sampleStepM);
  const L = CONFIG.lighting;
  const useLight = model.night && model.light !== null && model.lightRef > 0;
  let crimeExposure = 0;
  let accidentExposure = 0;
  let darkExposure = 0;
  let litKm = 0;
  let lightKm = 0;
  let hotspots = 0;
  let inHotspot = false;
  const criticalPoints: LngLat[] = [];

  for (const s of samples) {
    const km = s.lengthM / 1000;
    const d = model.crime.densityAt(s.position);
    crimeExposure += d * km;
    if (model.accident) accidentExposure += model.accident.densityAt(s.position) * km;

    const lit = litnessAt(model, s.position);
    if (lit !== null) {
      lightKm += km;
      if (lit >= L.litThreshold) litKm += km;
      if (useLight) {
        const dark = 1 - lit;
        darkExposure += (d * L.darkCrimeBoost * dark + L.darkBaseline * model.reference * dark) * km;
      }
    }

    const critical = model.hotspotThreshold > 0 && d >= model.hotspotThreshold;
    if (critical) criticalPoints.push(s.position);
    if (critical && !inHotspot) hotspots++;
    inHotspot = critical;
  }

  const km = Math.max(route.distanceM / 1000, 0.05);
  const cost = crimeExposure + (model.accident ? model.accidentFactor * accidentExposure : 0) + darkExposure;
  const perKm = cost / km;
  const riskIndex = model.reference > 0 ? Math.round(100 * (1 - Math.exp(-perKm / (2 * model.reference)))) : 0;

  return {
    ...route,
    crimeExposure,
    accidentExposure,
    darkExposure,
    cost,
    riskIndex,
    hotspots,
    criticalPoints,
    litShare: lightKm > 0 ? litKm / lightKm : undefined,
  };
}

/**
 * "Por que esta rota?": trechos da rota mais rápida que a rota sugerida não percorre
 * e que passam por concentração alta de ocorrências.
 */
export function avoidedSegments(fastest: Route, safest: Route, model: RiskModel): AvoidedSegment[] {
  if (fastest.id === safest.id) return [];
  const step = model.sampleStepM;
  const tolM = 60;
  const cell = tolM / METERS_PER_DEG_LAT;
  const onSafe = new Set<string>();
  for (const s of sampleLine(safest.geometry, step)) onSafe.add(`${Math.round(s.position[0] / cell)}:${Math.round(s.position[1] / cell)}`);
  const near = (p: LngLat) => {
    const x = Math.round(p[0] / cell);
    const y = Math.round(p[1] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (onSafe.has(`${x + dx}:${y + dy}`)) return true;
    return false;
  };

  const out: AvoidedSegment[] = [];
  let cur: { path: LngLat[]; max: number } | null = null;
  const close = () => {
    if (cur && cur.path.length >= 2 && cur.max >= model.hotspotThreshold * 0.7) {
      let len = 0;
      for (let i = 1; i < cur.path.length; i++) len += haversine(cur.path[i - 1], cur.path[i]);
      if (len >= 60) out.push({ path: cur.path, lengthM: len, intensity: model.reference > 0 ? cur.max / model.reference : 0 });
    }
    cur = null;
  };
  for (const s of sampleLine(fastest.geometry, step)) {
    if (near(s.position)) {
      close();
      continue;
    }
    const d = model.crime.densityAt(s.position);
    if (!cur) cur = { path: [], max: 0 };
    cur.path.push(s.position);
    if (d > cur.max) cur.max = d;
  }
  close();
  return out.sort((a, b) => b.intensity - a.intensity);
}

/** Perfil de densidade ao longo da rota (para o gráfico do card). */
export function riskProfile(route: Route, model: RiskModel, points = 80): ProfilePoint[] {
  const step = Math.max(model.sampleStepM, route.distanceM / points);
  return sampleLine(route.geometry, step).map((s) => ({
    alongM: s.alongM,
    density: model.crime.densityAt(s.position),
  }));
}

export interface Peak {
  position: LngLat;
  /** Rumo local do trajeto no pico (graus), para calcular desvios perpendiculares. */
  headingDeg: number;
  density: number;
}

/** Picos de densidade ao longo da rota, afastados entre si e das pontas. */
export function findPeaks(route: Route, model: RiskModel, maxPeaks: number): Peak[] {
  const samples = sampleLine(route.geometry, model.sampleStepM);
  if (samples.length < 5) return [];
  const total = samples[samples.length - 1].alongM;
  const margin = Math.min(400, total * 0.1);
  const scored = samples
    .map((s, i) => ({ i, d: model.crime.densityAt(s.position), along: s.alongM }))
    .filter((s) => s.along > margin && s.along < total - margin)
    .sort((a, b) => b.d - a.d);

  const chosen: { i: number; d: number; along: number }[] = [];
  const minGapM = Math.max(800, total / (maxPeaks + 1));
  for (const s of scored) {
    if (chosen.length >= maxPeaks || s.d < model.hotspotThreshold * 0.6) break;
    if (chosen.every((c) => Math.abs(c.along - s.along) > minGapM)) chosen.push(s);
  }
  return chosen.map(({ i, d }) => {
    const a = samples[Math.max(0, i - 3)].position;
    const b = samples[Math.min(samples.length - 1, i + 3)].position;
    return { position: samples[i].position, headingDeg: bearing(a, b), density: d };
  });
}

/**
 * Escolhe a rota mais segura entre as que respeitam a tolerância de tempo extra.
 * Retorna também a mais rápida para comparação.
 */
export function pickRoutes(routes: ScoredRoute[], toleranceRatio: number): { safest: ScoredRoute; fastest: ScoredRoute } {
  if (routes.length === 0) throw new Error('Nenhuma rota para escolher.');
  const fastest = routes.reduce((a, b) => (b.durationS < a.durationS ? b : a));
  const limit = fastest.durationS * (1 + toleranceRatio);
  const eligible = routes.filter((r) => r.durationS <= limit + 1);
  const safest = eligible.reduce((a, b) => {
    // Empate técnico (<3% de diferença de custo): fica com a mais rápida.
    if (Math.abs(a.cost - b.cost) <= 0.03 * Math.max(a.cost, b.cost)) return b.durationS < a.durationS ? b : a;
    return b.cost < a.cost ? b : a;
  });
  return { safest, fastest };
}
