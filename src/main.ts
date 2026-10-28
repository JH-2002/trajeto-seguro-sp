import './styles.css';
import { CONFIG } from './config';
import {
  buildAccidentPoints,
  buildCrimePoints,
  buildLightPoints,
  buildRiskModel,
  loadDatasets,
  type CrimeStore,
} from './data/dataStore';
import { inspectArea } from './data/inspect';
import { reversePlace } from './geocoding/photon';
import { MapView } from './map/mapView';
import { avoidedSegments, type RiskModel } from './risk/scoring';
import { OsrmProvider } from './routing/provider';
import { findSafeRoutes, rankRoutes, type SafeRouteResult } from './routing/safeRouter';
import {
  CATEGORY_LABELS,
  CRIME_CATEGORIES,
  HOUR_SLOTS,
  hourLabel,
  isNightHour,
  type AccidentDataset,
  type AccidentPoint,
  type AvoidedSegment,
  type CrimeCategory,
  type HourFilter,
  type LightPoint,
  type LightingDataset,
  type LngLat,
  type MapPoint,
  type Route,
  type TravelMode,
} from './types';
import { AddressField, esc } from './ui/autocomplete';
import { renderInspector } from './ui/inspector';
import { renderRouteCards } from './ui/routeCards';
import { Timeline } from './ui/timeline';
import { copyText, readShareState, toQuery, writeShareState, type ShareState } from './ui/urlState';
import { inBbox } from './utils/geo';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// ---------- estado ----------
const state = {
  store: null as CrimeStore | null,
  accidentsDs: null as AccidentDataset | null,
  lightingDs: null as LightingDataset | null,
  crimePoints: [] as MapPoint[],
  accidentPoints: [] as AccidentPoint[],
  lightPoints: [] as LightPoint[],
  categories: new Set<CrimeCategory>(CRIME_CATEGORIES),
  recency: false,
  mode: 'foot' as TravelMode,
  tolerance: 0.3,
  avoidAccidents: true,
  origin: null as LngLat | null,
  destination: null as LngLat | null,
  picking: null as 'origin' | 'destination' | null,
  model: null as RiskModel | null,
  candidates: [] as Route[],
  result: null as SafeRouteResult | null,
  avoided: [] as AvoidedSegment[],
  selectedId: '',
  controller: null as AbortController | null,
  inspectCenter: null as LngLat | null,
  inspectTitle: '',
};

const view = new MapView($('#map'));
const provider = new OsrmProvider(CONFIG.osrm);
const timeline = new Timeline($('#timeline'), $('#timeBadge'), {
  onChange: (_h, live) => refreshCrimes(live),
  onSettle: () => {
    rebuildModel();
    syncUrl();
  },
});

// ---------- dados ----------

/** `live` = durante a animação: atualiza só o visual (o risco é recalculado ao parar). */
function refreshCrimes(live = false): void {
  if (!state.store) return;
  const { points, total } = buildCrimePoints(state.store, {
    categories: state.categories,
    hour: timeline.value,
    recency: state.recency,
  });
  state.crimePoints = points;
  view.setCrimes(points);
  const h = timeline.value;
  $('#stats').innerHTML = `
    <div><strong>${total.toLocaleString('pt-BR')}</strong><span>${h === 'todos' ? 'ocorrências no filtro' : `ocorrências por volta das ${hourLabel(h)}`}</span></div>
    <div><strong>${points.length.toLocaleString('pt-BR')}</strong><span>áreas com registro</span></div>
    ${state.accidentsDs ? `<div><strong>${state.accidentsDs.meta.records.toLocaleString('pt-BR')}</strong><span>acidentes</span></div>` : ''}`;
  if (!live) rebuildModel();
}

/** Perfil horário da cidade (barras da linha do tempo) para as categorias escolhidas. */
function refreshHourProfile(): void {
  const s = state.store;
  if (!s) return;
  const byHour = new Array<number>(24).fill(0);
  const cats = CRIME_CATEGORIES.map((c, i) => ({ c, i })).filter(({ c }) => state.categories.has(c));
  const width = CRIME_CATEGORIES.length * HOUR_SLOTS;
  for (let i = 0; i < s.n; i++)
    for (const { i: c } of cats) {
      const base = i * width + c * HOUR_SLOTS;
      for (let h = 0; h < 24; h++) byHour[h] += s.slots[base + h];
    }
  timeline.setProfile(byHour);
}

function rebuildModel(): void {
  state.model = buildRiskModel({
    crimes: state.crimePoints,
    accidents: state.accidentPoints,
    lights: state.lightPoints.length ? state.lightPoints : null,
    avoidAccidents: state.avoidAccidents,
    hour: timeline.value,
  });
  rerank();
  if (state.inspectCenter) showInspector(state.inspectCenter, false);
  updateRouteButton();
}

function describeSource(problem?: string): void {
  const c = state.store?.ds.meta;
  const a = state.accidentsDs?.meta;
  const l = state.lightingDs?.meta;
  const fmt = (d?: string) => (d ? d.split('-').reverse().join('/') : '');
  const parts: string[] = [];
  if (c) parts.push(`Crimes: ${esc(c.source)}${c.period ? ` (${fmt(c.period.from)} a ${fmt(c.period.to)})` : ''}`);
  if (a) parts.push(`Acidentes: ${esc(a.source)}${a.period ? ` (${fmt(a.period.from)} a ${fmt(a.period.to)})` : ''}`);
  if (l) parts.push(`Iluminação: ${esc(l.source)}`);
  $('#sourceInfo').innerHTML = parts.join('<br>');
  if (c) $('#recencyNote').textContent = `meia-vida de ${c.halfLifeMonths} meses`;

  const banner = $('#dataBanner');
  if (!c) {
    banner.hidden = false;
    banner.className = 'banner banner--error';
    banner.innerHTML =
      problem ?? 'Nenhum dado encontrado em <code>public/data/</code>. Rode <code>npm run data:update</code> (dados reais) ou <code>npm run data:demo</code>.';
  } else if (c.isDemo || a?.isDemo || l?.isDemo) {
    banner.hidden = false;
    banner.className = 'banner banner--demo';
    banner.innerHTML = '<strong>Dados de demonstração.</strong> Os pontos são sintéticos. Para baixar os registros reais da SSP-SP, rode <code>npm run data:update</code>.';
  }
}

// ---------- rotas ----------
function updateRouteButton(): void {
  $<HTMLButtonElement>('#routeBtn').disabled = !(state.origin && state.destination && state.model);
}

function setStatus(msg: string, kind: 'info' | 'error' = 'info'): void {
  const el = $('#routeStatus');
  el.textContent = msg;
  el.dataset.kind = kind;
}

function rerank(): void {
  if (!state.model || state.candidates.length === 0) return;
  const prevSafest = state.result?.safest.id;
  state.result = rankRoutes(state.candidates, state.model, state.tolerance);
  // Mantém a rota escolhida pelo usuário, a menos que ela tenha sido a "mais segura" anterior.
  if (!state.result.routes.some((r) => r.id === state.selectedId) || state.selectedId === prevSafest) {
    state.selectedId = state.result.safest.id;
  }
  paintRoutes(false);
}

function paintRoutes(fit: boolean): void {
  const res = state.result;
  if (!res || !state.model) return;
  state.avoided = avoidedSegments(res.fastest, res.safest, state.model);
  view.setRoutes({ routes: res.routes, safestId: res.safest.id, fastestId: res.fastest.id, selectedId: state.selectedId });
  view.setAvoided(state.avoided);
  renderRouteCards($('#routeResults'), res.routes, {
    safestId: res.safest.id,
    fastestId: res.fastest.id,
    selectedId: state.selectedId,
    model: state.model,
    avoided: state.avoided,
  });
  const selected = res.routes.find((r) => r.id === state.selectedId);
  if (fit && selected) view.fitRoute(selected, panelWidth());
}

async function computeRoute(): Promise<void> {
  if (!state.origin || !state.destination || !state.model) return;
  state.controller?.abort();
  const controller = (state.controller = new AbortController());
  const btn = $<HTMLButtonElement>('#routeBtn');
  btn.classList.add('is-loading');
  btn.disabled = true;
  try {
    const res = await findSafeRoutes(provider, state.model, {
      origin: state.origin,
      destination: state.destination,
      mode: state.mode,
      tolerance: state.tolerance,
      signal: controller.signal,
      onProgress: (m) => setStatus(m),
    });
    state.candidates = res.candidates;
    state.result = res;
    state.selectedId = res.safest.id;
    const gain = res.fastest.cost > 0 ? Math.round((1 - res.safest.cost / res.fastest.cost) * 100) : 0;
    const n = res.candidates.length;
    const analysed = n === 1 ? '1 rota analisada' : `${n} rotas analisadas`;
    const when = timeline.value === 'todos' ? '' : ` para as ${hourLabel(timeline.value)}`;
    setStatus(
      res.safest.id === res.fastest.id
        ? `${analysed}${when}. A mais rápida já é a de menor exposição.`
        : `${analysed}${when}. A rota sugerida reduz a exposição em ${gain}%.`,
    );
    paintRoutes(true);
    syncUrl();
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    setStatus((err as Error).message || 'Não foi possível calcular a rota.', 'error');
  } finally {
    btn.classList.remove('is-loading');
    updateRouteButton();
  }
}

function clearRoutes(): void {
  state.candidates = [];
  state.result = null;
  state.avoided = [];
  view.setRoutes(null);
  view.setAvoided([]);
  $('#routeResults').innerHTML = '';
  setStatus('');
}

// ---------- link compartilhável ----------
function shareState(): ShareState {
  return {
    origin: state.origin,
    destination: state.destination,
    mode: state.mode,
    tolerance: state.tolerance,
    hour: timeline.value,
    categories: state.categories,
    recency: state.recency,
  };
}

function syncUrl(): void {
  writeShareState(shareState());
}

async function shareLink(): Promise<void> {
  const url = `${window.location.origin}${window.location.pathname}${toQuery(shareState())}`;
  toast((await copyText(url)) ? 'Link copiado. Quem abrir verá esta mesma rota.' : url);
}

// ---------- pontos ----------
const fields = {
  origin: new AddressField(
    $('[data-stop="origin"]'),
    (p) => void setStop('origin', p.position, false),
    () => void setStop('origin', null, false),
  ),
  destination: new AddressField(
    $('[data-stop="destination"]'),
    (p) => void setStop('destination', p.position, false),
    () => void setStop('destination', null, false),
  ),
};

async function setStop(kind: 'origin' | 'destination', position: LngLat | null, fillLabel: boolean, label?: string): Promise<void> {
  state[kind] = position;
  view.setMarker(kind, position);
  clearRoutes();
  updateRouteButton();
  syncUrl();
  if (position && label) fields[kind].value = label;
  else if (position && fillLabel) {
    fields[kind].value = 'Ponto no mapa…';
    const place = await reversePlace(position);
    fields[kind].value = place ? [place.label, place.detail].filter(Boolean).join(' — ') : `${position[1].toFixed(5)}, ${position[0].toFixed(5)}`;
  }
  if (state.origin && state.destination) void computeRoute();
}

function startPicking(kind: 'origin' | 'destination' | null): void {
  state.picking = kind;
  document.body.classList.toggle('is-picking', !!kind);
  const hint = $('#pickHint');
  hint.hidden = !kind;
  if (kind) hint.textContent = `Clique no mapa para definir ${kind === 'origin' ? 'a origem' : 'o destino'} · Esc cancela`;
}

function locateMe(): void {
  if (!('geolocation' in navigator)) return toast('Seu navegador não oferece localização.');
  const btn = $('#locateBtn');
  btn.classList.add('is-busy');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.classList.remove('is-busy');
      const p: LngLat = [pos.coords.longitude, pos.coords.latitude];
      if (!inBbox(p, CONFIG.bbox)) return toast('Você parece estar fora do município de São Paulo.');
      void setStop('origin', p, false, 'Minha localização');
      if (!state.destination) view.flyTo(p, 14);
    },
    (err) => {
      btn.classList.remove('is-busy');
      toast(err.code === err.PERMISSION_DENIED ? 'Permissão de localização negada.' : 'Não foi possível obter sua localização.');
    },
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
  );
}

// ---------- inspetor de área ----------
function showInspector(center: LngLat, fetchTitle: boolean): void {
  if (!state.store) return;
  state.inspectCenter = center;
  const radius = CONFIG.inspector.radiusM;
  const stats = inspectArea(state.store, center, radius, state.categories, state.model, state.accidentPoints.length ? state.accidentPoints : null);
  view.setInspect(center, radius);
  const t = state.store.ds.meta.trend;
  const trendPeriod = t?.complete ? 'vs. 12 meses anteriores' : null;
  const draw = () =>
    renderInspector($('#inspector'), stats, state.inspectTitle || 'Região selecionada', timeline.value, trendPeriod, {
      onClose: closeInspector,
      onUse: (kind, p) => {
        closeInspector();
        void setStop(kind, p, true);
      },
    });
  if (fetchTitle) state.inspectTitle = '';
  draw();
  if (fetchTitle) {
    void reversePlace(center).then((place) => {
      if (!place || state.inspectCenter !== center) return;
      const area = place.detail.split(' · ')[0] || place.label;
      state.inspectTitle = `Arredores de ${area}`;
      draw();
    });
  }
}

function closeInspector(): void {
  state.inspectCenter = null;
  $('#inspector').hidden = true;
  view.setInspect(null);
}

view.onClick((p) => {
  if (!inBbox(p, CONFIG.bbox)) {
    if (state.picking) toast('Escolha um ponto dentro do município de São Paulo.');
    return;
  }
  if (state.picking) {
    const kind = state.picking;
    startPicking(null);
    void setStop(kind, p, true);
    return;
  }
  showInspector(p, true);
});

// ---------- UI ----------
function panelWidth(): number {
  const panel = $('#panel');
  return window.innerWidth > 720 && !panel.classList.contains('is-collapsed') ? panel.offsetWidth + 16 : 0;
}

let toastTimer = 0;
function toast(msg: string): void {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('is-visible'), 3600);
}

function paintCategoryChips(): void {
  $('#categoryChips').innerHTML = CRIME_CATEGORIES.map((c) => {
    const on = state.categories.has(c);
    return `<button class="chip ${on ? 'is-on' : ''}" data-cat="${c}" aria-pressed="${on}">${CATEGORY_LABELS[c]}</button>`;
  }).join('');
}

function setMode(mode: TravelMode): void {
  state.mode = mode;
  $('#modeSeg').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-checked', String(on));
  });
}

function setTolerance(t: number): void {
  state.tolerance = t;
  const tol = $<HTMLInputElement>('#tolerance');
  tol.value = String(Math.round(t * 100));
  $('#toleranceOut').textContent = `+${tol.value}%`;
  tol.style.setProperty('--fill', `${tol.value}%`);
}

function setupControls(): void {
  paintCategoryChips();
  $('#categoryChips').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-cat]');
    if (!btn) return;
    const cat = btn.dataset.cat as CrimeCategory;
    if (state.categories.has(cat) && state.categories.size === 1) return toast('Mantenha ao menos um tipo de crime.');
    if (state.categories.has(cat)) state.categories.delete(cat);
    else state.categories.add(cat);
    paintCategoryChips();
    refreshHourProfile();
    refreshCrimes();
    syncUrl();
  });

  $<HTMLInputElement>('#recency').addEventListener('change', (e) => {
    state.recency = (e.target as HTMLInputElement).checked;
    refreshCrimes();
    syncUrl();
  });

  document.querySelectorAll<HTMLInputElement>('[data-layer]').forEach((input) =>
    input.addEventListener('change', () => view.setVisibility({ [input.dataset.layer!]: input.checked })),
  );

  $('#modeSeg').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-mode]');
    if (!btn || btn.dataset.mode === state.mode) return;
    setMode(btn.dataset.mode as TravelMode);
    syncUrl();
    if (state.origin && state.destination) void computeRoute();
  });

  const tol = $<HTMLInputElement>('#tolerance');
  setTolerance(state.tolerance);
  tol.addEventListener('input', () => {
    setTolerance(Number(tol.value) / 100);
    rerank();
    syncUrl();
  });

  $<HTMLInputElement>('#avoidAccidents').addEventListener('change', (e) => {
    state.avoidAccidents = (e.target as HTMLInputElement).checked;
    rebuildModel();
  });

  $('#routeBtn').addEventListener('click', () => void computeRoute());
  $('#locateBtn').addEventListener('click', locateMe);

  $('#swapBtn').addEventListener('click', () => {
    const [o, d] = [state.origin, state.destination];
    const [ot, dt] = [fields.origin.input.value, fields.destination.input.value];
    state.origin = d;
    state.destination = o;
    fields.origin.value = dt;
    fields.destination.value = ot;
    view.setMarker('origin', d);
    view.setMarker('destination', o);
    clearRoutes();
    syncUrl();
    if (d && o) void computeRoute();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((b) =>
    b.addEventListener('click', () => {
      const kind = b.dataset.pick as 'origin' | 'destination';
      startPicking(state.picking === kind ? null : kind);
    }),
  );
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    startPicking(null);
    closeInspector();
  });

  $('#routeResults').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-act="share"]')) return void shareLink();
    const card = target.closest<HTMLElement>('[data-route]');
    if (!card) return;
    state.selectedId = card.dataset.route!;
    paintRoutes(true);
  });

  // Câmera
  const b3d = $('#btn3d');
  b3d.addEventListener('click', () => {
    const is3d = view.toggle3D();
    b3d.textContent = is3d ? '3D' : '2D';
    b3d.setAttribute('aria-pressed', String(is3d));
  });
  const orbit = $('#btnOrbit');
  orbit.addEventListener('click', () => orbit.setAttribute('aria-pressed', String(view.toggleOrbit())));
  document.addEventListener('orbit-stopped', () => orbit.setAttribute('aria-pressed', 'false'));
  $('#btnReset').addEventListener('click', () => view.resetView());

  $('#collapseBtn').addEventListener('click', () => $('#panel').classList.toggle('is-collapsed'));

  // Modo leve (manual ou automático quando o mapa fica lento)
  const lite = $<HTMLInputElement>('#liteMode');
  const buildings = $<HTMLInputElement>('[data-layer="buildings"]');
  const applyLite = (on: boolean) => {
    lite.checked = on;
    view.setLiteMode(on);
    buildings.disabled = on;
    view.setVisibility({ buildings: !on && buildings.checked });
    try {
      localStorage.setItem('ts-lite-mode', on ? '1' : '0');
    } catch {
      /* armazenamento indisponível */
    }
  };
  lite.addEventListener('change', () => applyLite(lite.checked));
  document.addEventListener('map-slow', (e) => {
    applyLite(true);
    const fps = (e as CustomEvent<{ fps: number }>).detail.fps;
    toast(`O mapa estava lento (~${fps} quadros/s). Modo leve ativado; dá para desligar no painel.`);
  });
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('ts-lite-mode');
  } catch {
    /* armazenamento indisponível */
  }
  if (saved === '1') view.map.once('load', () => applyLite(true));
}

/** Aplica o estado vindo de um link compartilhado (antes de calcular qualquer coisa). */
function restoreFromUrl(): Partial<ShareState> {
  const s = readShareState();
  if (s.mode) setMode(s.mode);
  if (s.tolerance !== undefined) setTolerance(s.tolerance);
  if (s.categories) {
    state.categories = s.categories;
    paintCategoryChips();
  }
  if (s.recency) {
    state.recency = true;
    $<HTMLInputElement>('#recency').checked = true;
  }
  if (s.hour !== undefined) timeline.restore(s.hour as HourFilter);
  return s;
}

// ---------- início ----------
async function init(): Promise<void> {
  setupControls();
  const shared = restoreFromUrl();
  const { crimes, accidents, lighting, problem } = await loadDatasets();
  state.store = crimes;
  state.accidentsDs = accidents;
  state.lightingDs = lighting;

  if (accidents) {
    state.accidentPoints = buildAccidentPoints(accidents);
    view.setAccidents(state.accidentPoints);
  } else {
    $<HTMLInputElement>('[data-layer="accidents"]').disabled = true;
    $<HTMLInputElement>('#avoidAccidents').disabled = true;
  }
  if (lighting) {
    state.lightPoints = buildLightPoints(lighting);
    view.setLights(state.lightPoints);
  } else {
    $<HTMLInputElement>('[data-layer="lights"]').disabled = true;
  }

  describeSource(problem);
  refreshHourProfile();
  refreshCrimes();
  updateRouteButton();

  // Link compartilhado: posiciona os pontos e calcula a rota.
  if (shared.origin && inBbox(shared.origin, CONFIG.bbox)) await setStop('origin', shared.origin, true);
  if (shared.destination && inBbox(shared.destination, CONFIG.bbox)) await setStop('destination', shared.destination, true);
  if (isNightHour(timeline.value) && !lighting && shared.origin) {
    toast('Sem dados de iluminação: o horário noturno considera só os crimes.');
  }
}

void init();
