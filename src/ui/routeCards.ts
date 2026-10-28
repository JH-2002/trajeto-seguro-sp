import { riskProfile, type RiskModel } from '../risk/scoring';
import type { AvoidedSegment, ScoredRoute } from '../types';

export interface CardContext {
  safestId: string;
  fastestId: string;
  selectedId: string;
  model: RiskModel;
  avoided: AvoidedSegment[];
}

function minutes(s: number): string {
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

function km(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

function riskLevel(index: number): { label: string; cls: string } {
  if (index < 25) return { label: 'Baixo', cls: 'lvl-low' };
  if (index < 50) return { label: 'Moderado', cls: 'lvl-mid' };
  if (index < 75) return { label: 'Alto', cls: 'lvl-high' };
  return { label: 'Muito alto', cls: 'lvl-max' };
}

/** Gráfico de área com a densidade de crimes ao longo do trajeto. */
function sparkline(route: ScoredRoute, model: RiskModel): string {
  const prof = riskProfile(route, model, 60);
  if (prof.length < 2) return '';
  const w = 240;
  const h = 36;
  const maxD = Math.max(model.hotspotThreshold * 1.4, ...prof.map((p) => p.density), 1e-6);
  const total = prof[prof.length - 1].alongM || 1;
  const pts = prof.map((p) => `${((p.alongM / total) * w).toFixed(1)},${(h - (p.density / maxD) * (h - 2)).toFixed(1)}`);
  const thY = (h - (model.hotspotThreshold / maxD) * (h - 2)).toFixed(1);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="sg-${route.id}" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#fff176" stop-opacity=".15"/><stop offset="1" stop-color="#e53935" stop-opacity=".75"/>
    </linearGradient></defs>
    <polygon points="0,${h} ${pts.join(' ')} ${w},${h}" fill="url(#sg-${route.id})"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="#ffb74d" stroke-width="1.2"/>
    <line x1="0" x2="${w}" y1="${thY}" y2="${thY}" class="spark__th"/>
  </svg>`;
}

/** Resumo "por que esta rota?" exibido no card da rota sugerida. */
function whyHtml(avoided: AvoidedSegment[]): string {
  if (!avoided.length) return '';
  const total = avoided.reduce((s, a) => s + a.lengthM, 0);
  const worst = Math.max(...avoided.map((a) => a.intensity));
  return `<p class="why">
    <svg viewBox="0 0 24 24"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/></svg>
    Evita ${avoided.length} trecho${avoided.length === 1 ? '' : 's'} crítico${avoided.length === 1 ? '' : 's'} da rota mais rápida
    (${km(total)}${worst >= 1.5 ? `, até ${worst >= 10 ? Math.round(worst) : worst.toFixed(1).replace('.', ',')}× a média da cidade` : ''}), marcado${avoided.length === 1 ? '' : 's'} em vermelho no mapa.
  </p>`;
}

export function renderRouteCards(container: HTMLElement, routes: ScoredRoute[], ctx: CardContext): void {
  const fastest = routes.find((r) => r.id === ctx.fastestId)!;
  const cards = routes
    .map((r) => {
      const isSafe = r.id === ctx.safestId;
      const isFast = r.id === ctx.fastestId;
      const tag = isSafe && isFast ? 'Mais segura e mais rápida' : isSafe ? 'Mais segura' : isFast ? 'Mais rápida' : 'Alternativa';
      const kind = isSafe ? 'safe' : isFast ? 'fast' : 'alt';
      const lvl = riskLevel(r.riskIndex);
      const extra = r.durationS - fastest.durationS;
      const reduction = fastest.cost > 0 ? Math.round((1 - r.cost / fastest.cost) * 100) : 0;
      const delta =
        !isFast && extra > 30
          ? `<span class="delta">+${minutes(extra)}${reduction > 0 ? ` · −${reduction}% exposição` : ''}</span>`
          : '';
      const lit =
        ctx.model.night && r.litShare !== undefined
          ? `<span class="lit">${Math.round(r.litShare * 100)}% iluminado</span>`
          : '';
      return `<button class="route-card route-card--${kind} ${r.id === ctx.selectedId ? 'is-selected' : ''}" data-route="${r.id}">
        <div class="route-card__top">
          <span class="tag tag--${kind}">${tag}</span>
          <span class="risk ${lvl.cls}" title="Índice de risco (0–100)">${r.riskIndex}<small>${lvl.label}</small></span>
        </div>
        <div class="route-card__meta">
          <strong>${minutes(r.durationS)}</strong><span>${km(r.distanceM)}</span>
          <span>${r.hotspots} ponto${r.hotspots === 1 ? '' : 's'} crítico${r.hotspots === 1 ? '' : 's'}</span>
          ${lit}
        </div>
        ${delta}
        ${isSafe && !isFast ? whyHtml(ctx.avoided) : ''}
        ${r.id === ctx.selectedId ? sparkline(r, ctx.model) : ''}
      </button>`;
    })
    .join('');
  container.innerHTML = `${cards}
    <button class="link-btn" data-act="share">
      <svg viewBox="0 0 24 24"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>
      Copiar link desta rota
    </button>`;
}
