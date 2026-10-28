import { CONFIG } from '../config';
import { findPeaks, pickRoutes, scoreRoute, type RiskModel } from '../risk/scoring';
export type { RiskModel };
import type { LngLat, Route, ScoredRoute, TravelMode } from '../types';
import { destination, overlapRatio } from '../utils/geo';
import type { RoutingProvider } from './provider';

export interface SafeRouteResult {
  routes: ScoredRoute[];
  safest: ScoredRoute;
  fastest: ScoredRoute;
}

export interface SafeRouteRequest {
  origin: LngLat;
  destination: LngLat;
  mode: TravelMode;
  /** Tempo extra aceito em relação à rota mais rápida (0.3 = +30%). */
  tolerance: number;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
}

/**
 * Estratégia:
 * 1. Pede ao motor de rotas a rota direta + alternativas.
 * 2. Encontra os picos de criminalidade na rota mais rápida.
 * 3. Gera pontos de desvio perpendiculares a cada pico (esquerda/direita, 2 distâncias),
 *    descartando desvios que caem em áreas igualmente críticas.
 * 4. Pontua tudo e escolhe a de menor exposição dentro da tolerância de tempo.
 */
export async function findSafeRoutes(
  provider: RoutingProvider,
  model: RiskModel,
  req: SafeRouteRequest,
): Promise<SafeRouteResult & { candidates: Route[] }> {
  const { origin, destination: dest, mode, signal } = req;
  req.onProgress?.('Buscando rotas base…');
  const base = await provider.route([origin, dest], mode, { alternatives: true, signal });
  if (base.length === 0) throw new Error('Nenhuma rota encontrada entre os pontos.');

  const candidates: Route[] = [];
  const addUnique = (r: Route) => {
    const dup = candidates.some(
      (c) => Math.abs(c.distanceM - r.distanceM) < 150 && overlapRatio(r.geometry, c.geometry) > CONFIG.routing.duplicateOverlap,
    );
    if (!dup) candidates.push(r);
  };
  base.forEach(addUnique);

  const fastestBase = base.reduce((a, b) => (b.durationS < a.durationS ? b : a));
  const peaks = fastestBase.distanceM > 1200 ? findPeaks(fastestBase, model, CONFIG.routing.maxPeaks) : [];

  const vias: LngLat[] = [];
  for (const peak of peaks) {
    for (const offset of CONFIG.routing.detourOffsetsM) {
      for (const side of [90, -90]) {
        const via = destination(peak.position, peak.headingDeg + side, offset);
        // Só vale desviar para um lugar claramente mais tranquilo que o pico.
        if (model.crime.densityAt(via) < peak.density * 0.5) vias.push(via);
      }
    }
  }
  const selectedVias = vias.slice(0, CONFIG.routing.maxDetourRequests);

  if (selectedVias.length > 0) {
    req.onProgress?.(`Testando ${selectedVias.length} desvios ao redor de ${peaks.length} ponto(s) crítico(s)…`);
    const results = await Promise.allSettled(
      selectedVias.map((via) => provider.route([origin, via, dest], mode, { signal })),
    );
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    for (const r of results) if (r.status === 'fulfilled') r.value.forEach(addUnique);
  }

  req.onProgress?.('Calculando exposição ao risco…');
  return { ...rankRoutes(candidates, model, req.tolerance), candidates };
}

/**
 * Pontua e ordena candidatas já obtidas. É barato, então roda de novo sempre que o
 * usuário muda filtros ou a tolerância, sem consultar o servidor de rotas.
 */
export function rankRoutes(candidates: Route[], model: RiskModel, tolerance: number): SafeRouteResult {
  const scored = candidates.map((r) => scoreRoute(r, model));
  const { safest, fastest } = pickRoutes(scored, tolerance);
  const ordered = [safest, ...(fastest.id !== safest.id ? [fastest] : [])];
  const others = scored
    .filter((r) => r.id !== safest.id && r.id !== fastest.id)
    .sort((a, b) => a.cost - b.cost)
    .slice(0, 2);
  return { routes: [...ordered, ...others], safest, fastest };
}
