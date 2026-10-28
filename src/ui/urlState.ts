import { CRIME_CATEGORIES, type CrimeCategory, type HourFilter, type LngLat, type TravelMode } from '../types';

/** O que vai para o link compartilhável. */
export interface ShareState {
  origin: LngLat | null;
  destination: LngLat | null;
  mode: TravelMode;
  tolerance: number;
  hour: HourFilter;
  categories: Set<CrimeCategory>;
  recency: boolean;
}

const MODES: TravelMode[] = ['foot', 'bike', 'car'];

function parsePoint(s: string | null): LngLat | null {
  if (!s) return null;
  const [lon, lat] = s.split(',').map(Number);
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : null;
}

const fmt = (p: LngLat) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;

export function readShareState(search = window.location.search): Partial<ShareState> {
  const q = new URLSearchParams(search);
  const out: Partial<ShareState> = {};
  const o = parsePoint(q.get('o'));
  const d = parsePoint(q.get('d'));
  if (o) out.origin = o;
  if (d) out.destination = d;
  const m = q.get('m') as TravelMode | null;
  if (m && MODES.includes(m)) out.mode = m;
  const t = Number(q.get('t'));
  if (q.has('t') && Number.isFinite(t) && t >= 0 && t <= 100) out.tolerance = t / 100;
  const h = q.get('h');
  if (h === 'todos') out.hour = 'todos';
  else if (h !== null && /^\d{1,2}$/.test(h) && Number(h) < 24) out.hour = Number(h);
  const c = q.get('c');
  if (c) {
    const cats = c.split(',').filter((x): x is CrimeCategory => (CRIME_CATEGORIES as readonly string[]).includes(x));
    if (cats.length) out.categories = new Set(cats);
  }
  if (q.get('r') === '1') out.recency = true;
  return out;
}

export function toQuery(s: ShareState): string {
  const q = new URLSearchParams();
  if (s.origin) q.set('o', fmt(s.origin));
  if (s.destination) q.set('d', fmt(s.destination));
  if (s.mode !== 'foot') q.set('m', s.mode);
  if (Math.round(s.tolerance * 100) !== 30) q.set('t', String(Math.round(s.tolerance * 100)));
  if (s.hour !== 'todos') q.set('h', String(s.hour));
  if (s.categories.size !== CRIME_CATEGORIES.length) q.set('c', CRIME_CATEGORIES.filter((c) => s.categories.has(c)).join(','));
  if (s.recency) q.set('r', '1');
  // Vírgulas legíveis no link (são válidas em query strings).
  const str = q.toString().replace(/%2C/gi, ',');
  return str ? `?${str}` : '';
}

let timer = 0;
/** Atualiza a URL sem recarregar nem poluir o histórico (com debounce). */
export function writeShareState(s: ShareState): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    const url = `${window.location.pathname}${toQuery(s)}${window.location.hash}`;
    window.history.replaceState(null, '', url);
  }, 250);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
