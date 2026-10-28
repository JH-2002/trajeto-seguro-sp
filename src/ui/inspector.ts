import type { AreaStats } from '../data/inspect';
import { CATEGORY_LABELS, hourLabel, type HourFilter, type LngLat } from '../types';
import { esc } from './autocomplete';

export interface InspectorActions {
  onClose: () => void;
  onUse: (kind: 'origin' | 'destination', p: LngLat) => void;
}

const nf = (n: number) => Math.round(n).toLocaleString('pt-BR');

function trendHtml(t: number | null, cls = 'trend'): string {
  if (t === null) return '';
  const pct = Math.round(t * 100);
  if (pct === 0) return `<em class="${cls} ${cls}--flat">estável</em>`;
  return `<em class="${cls} ${pct > 0 ? `${cls}--up` : `${cls}--down`}">${pct > 0 ? '+' : ''}${pct}%</em>`;
}

function lightLabel(l: number | null): string {
  if (l === null) return '';
  if (l >= 0.75) return '<span class="pill pill--good">Iluminação boa</span>';
  if (l >= 0.4) return '<span class="pill pill--mid">Iluminação média</span>';
  return '<span class="pill pill--bad">Iluminação baixa</span>';
}

function hoursSvg(byHour: number[], peak: number | null, selected: HourFilter): string {
  const max = Math.max(...byHour, 1);
  const w = 280;
  const h = 52;
  const bw = w / 24;
  const bars = byHour
    .map((v, i) => {
      const bh = Math.max(1.5, (v / max) * (h - 12));
      const cls = i === peak ? 'is-peak' : selected !== 'todos' && i === selected ? 'is-active' : '';
      return `<rect class="${cls}" x="${(i * bw + 1).toFixed(1)}" y="${(h - 10 - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5"><title>${i}h: ${nf(v)}</title></rect>`;
    })
    .join('');
  const ticks = [0, 6, 12, 18, 23].map((t) => `<text x="${(t * bw + bw / 2).toFixed(1)}" y="${h - 1}">${t}h</text>`).join('');
  return `<svg class="insp-hours" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${bars}${ticks}</svg>`;
}

export function renderInspector(
  el: HTMLElement,
  s: AreaStats,
  title: string,
  hour: HourFilter,
  trendPeriod: string | null,
  actions: InspectorActions,
): void {
  const maxCat = Math.max(...s.byCategory.map((c) => c.n), 1);
  const empty = s.total === 0;
  el.innerHTML = `
    <header class="insp-head">
      <div>
        <h3>${esc(title)}</h3>
        <p>Raio de ${s.radiusM} m · todos os horários</p>
      </div>
      <button class="icon-btn" data-act="close" aria-label="Fechar">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </header>
    ${
      empty
        ? '<p class="insp-empty">Nenhuma ocorrência registrada nesta área para os tipos selecionados.</p>'
        : `
    <div class="insp-kpis">
      <div><strong>${nf(s.total)}</strong><span>ocorrências</span></div>
      ${s.trend !== null ? `<div><strong>${trendHtml(s.trend, 'kpi')}</strong><span>${esc(trendPeriod ?? 'últimos 12 meses')}</span></div>` : ''}
      ${s.vsCity !== null ? `<div><strong>${s.vsCity >= 10 ? Math.round(s.vsCity) : s.vsCity.toFixed(1).replace('.', ',')}×</strong><span>a média da cidade</span></div>` : ''}
    </div>
    <div class="insp-section">
      <div class="insp-row"><span>Por hora do dia</span>${s.peakHour !== null ? `<b>Pico ${hourLabel(s.peakHour)}–${hourLabel((s.peakHour + 1) % 24)}</b>` : ''}</div>
      ${hoursSvg(s.byHour, s.peakHour, hour)}
      ${s.unknownHour > 0 ? `<p class="insp-note">${nf(s.unknownHour)} sem horário registrado</p>` : ''}
    </div>
    <ul class="insp-cats">
      ${s.byCategory
        .filter((c) => c.n > 0)
        .map(
          (c) => `<li>
            <span>${CATEGORY_LABELS[c.cat]}</span>
            <i style="--w:${((c.n / maxCat) * 100).toFixed(0)}%"></i>
            <b>${nf(c.n)}</b>${trendHtml(c.trend)}
          </li>`,
        )
        .join('')}
    </ul>`
    }
    <div class="insp-foot">
      ${s.accidents ? `<span class="pill">${nf(s.accidents.total)} acidente${s.accidents.total === 1 ? '' : 's'}${s.accidents.fatal ? ` · ${s.accidents.fatal} fata${s.accidents.fatal === 1 ? 'l' : 'is'}` : ''}</span>` : ''}
      ${lightLabel(s.litness)}
    </div>
    <div class="insp-actions">
      <button class="ghost" data-act="origin">Usar como origem</button>
      <button class="ghost" data-act="destination">Usar como destino</button>
    </div>`;
  el.hidden = false;
  el.onclick = (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'close') actions.onClose();
    else if (act === 'origin' || act === 'destination') actions.onUse(act, s.center);
  };
}
