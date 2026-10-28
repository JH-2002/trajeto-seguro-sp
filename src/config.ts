import type { CrimeCategory, TravelMode } from './types';

const env: Record<string, string | undefined> =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export const CONFIG = {
  mapStyle: env.VITE_MAP_STYLE ?? 'https://tiles.openfreemap.org/styles/dark',
  osrm: {
    foot: env.VITE_OSRM_FOOT ?? 'https://routing.openstreetmap.de/routed-foot',
    bike: env.VITE_OSRM_BIKE ?? 'https://routing.openstreetmap.de/routed-bike',
    car: env.VITE_OSRM_CAR ?? 'https://routing.openstreetmap.de/routed-car',
  } satisfies Record<TravelMode, string>,
  photonUrl: env.VITE_PHOTON_URL ?? 'https://photon.komoot.io',

  /** Município de São Paulo (aprox.). [oeste, sul, leste, norte] */
  bbox: [-46.83, -24.01, -46.36, -23.35] as const,
  initialView: { center: [-46.6333, -23.5505] as [number, number], zoom: 11.3, pitch: 52, bearing: -18 },

  risk: {
    /** Raio de influência de uma concentração de crimes sobre o trajeto. */
    radiusM: 180,
    /** Espaçamento das amostras ao longo da rota. */
    sampleStepM: 30,
    /** Peso de gravidade por categoria (usado só no cálculo de risco, não no visual). */
    crimeWeights: { violento: 3, roubo: 2, furto: 1, outros: 0.5 } satisfies Record<CrimeCategory, number>,
    accidentWeight: 1,
    fatalAccidentWeight: 4,
    /** Quanto acidentes pesam frente a crimes na escolha da rota, quando ativado. */
    accidentFactor: 0.6,
    /** Percentil de densidade que define um trecho "crítico". */
    hotspotPercentile: 0.85,
  },

  lighting: {
    /** Alcance de um ponto de luz (escala de rua). */
    radiusM: 80,
    /** Percentil da densidade de luz que define "rua bem iluminada". */
    referencePercentile: 0.4,
    /** À noite, crimes em trecho escuro pesam até (1 + isto). */
    darkCrimeBoost: 0.6,
    /** À noite, custo-base de um trecho escuro, em frações da densidade típica de crimes. */
    darkBaseline: 0.35,
    /** Acima desta "luminosidade" (0–1) o trecho conta como iluminado. */
    litThreshold: 0.6,
  },

  inspector: {
    radiusM: 300,
  },

  performance: {
    /** Inclinação máxima: quanto mais deitado, mais horizonte (e mais tiles) entra na tela. */
    maxPitch: 62,
    maxPitchLite: 50,
    /** Teto de resolução em telas de alta densidade (1 = sem upscale). */
    pixelRatioCap: 1.5,
    /**
     * Nível de detalhe em vistas inclinadas: quantos níveis de zoom podem coexistir na
     * tela e a razão entre o tile mais próximo e o mais distante. Menor = horizonte mais
     * grosseiro e mais leve.
     */
    tileLod: { normal: [3, 2.5], lite: [2, 1.6] } as Record<'normal' | 'lite', [number, number]>,
    /** Abaixo disto (quadros por segundo, medidos ao mover o mapa) o modo leve liga sozinho. */
    autoLiteFps: 28,
  },

  routing: {
    maxDetourRequests: 6,
    detourOffsetsM: [450, 900],
    maxPeaks: 2,
    /** Rotas que se sobrepõem mais que isto são tratadas como a mesma. */
    duplicateOverlap: 0.92,
  },

  /** Gradiente amarelo → vermelho do "calor". */
  heatColors: [
    [255, 241, 118],
    [255, 213, 79],
    [255, 167, 38],
    [251, 115, 36],
    [229, 57, 53],
    [176, 18, 32],
  ] as [number, number, number][],

  colors: {
    safe: [46, 229, 157] as [number, number, number],
    fastest: [139, 124, 246] as [number, number, number],
    alternative: [150, 160, 180] as [number, number, number],
    accident: [76, 201, 240] as [number, number, number],
    critical: [255, 82, 82] as [number, number, number],
  },
};
