import { CRIME_CATEGORIES, HOUR_SLOTS, slotCode, type CrimeCategory, type CrimeCell, type CrimeMeta } from '../../src/types';

const NCAT = CRIME_CATEGORIES.length;

/** Mês como inteiro (ano × 12 + mês-1) a partir de AAAA-MM-DD. */
export function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

export function monthLabel(m: number): string {
  return `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`;
}

interface CrimeCellAcc {
  x: number;
  y: number;
  slots: Float64Array;
  /** mês → contagem por categoria. Mês -1 = sem data. */
  months: Map<number, Float64Array>;
}

/**
 * Agrega crimes por célula guardando hora × categoria e mês × categoria. O mês só é
 * resolvido no final (quando a data mais recente é conhecida) em peso por recência e
 * janelas de tendência.
 */
export class CrimeAggregator {
  private readonly cells = new Map<string, CrimeCellAcc>();
  private maxMonth = -Infinity;
  /** Total por mês, para achar o período realmente coberto pelos arquivos. */
  private readonly monthTotals = new Map<number, number>();

  constructor(readonly cellDeg: number) {}

  get size(): number {
    return this.cells.size;
  }

  add(lon: number, lat: number, cat: CrimeCategory, hour: number | null, date: string | null, inc = 1): void {
    const x = Math.floor(lon / this.cellDeg);
    const y = Math.floor(lat / this.cellDeg);
    const key = `${x}:${y}`;
    let c = this.cells.get(key);
    if (!c) this.cells.set(key, (c = { x, y, slots: new Float64Array(NCAT * HOUR_SLOTS), months: new Map() }));
    const ci = CRIME_CATEGORIES.indexOf(cat);
    c.slots[slotCode(ci, hour)] += inc;
    const m = date ? monthIndex(date) : -1;
    if (m >= 0) this.monthTotals.set(m, (this.monthTotals.get(m) ?? 0) + inc);
    let arr = c.months.get(m);
    if (!arr) c.months.set(m, (arr = new Float64Array(NCAT)));
    arr[ci] += inc;
  }

  /**
   * @param halfLifeMonths meia-vida do peso por recência (ocorrências com essa idade valem 0,5)
   */
  /**
   * Meses com volume real de dados. B.O.s registrados hoje sobre fatos antigos criam
   * meses "fantasmas" com poucas ocorrências (ex.: 2004 num arquivo de 2024); eles não
   * contam como cobertura, senão a tendência compararia com um ano quase vazio.
   */
  coverage(): { from: number; to: number } | null {
    if (this.monthTotals.size === 0) return null;
    // Referência = média dos 3 meses mais cheios: meses fantasmas podem ser muitos
    // (anos de registros tardios), então percentis sobre todos os meses enganam.
    const counts = [...this.monthTotals.values()].sort((a, b) => b - a);
    const top = counts.slice(0, 3);
    const typical = top.reduce((a, b) => a + b, 0) / top.length;
    const real = [...this.monthTotals.entries()].filter(([, n]) => n >= typical * 0.2).map(([m]) => m);
    return { from: Math.min(...real), to: Math.max(...real) };
  }

  finish(halfLifeMonths: number): { cells: CrimeCell[]; trend: CrimeMeta['trend']; coverage: { from: string; to: string } | null } {
    const cov = this.coverage();
    if (cov) this.maxMonth = cov.to;
    const hasDates = cov !== null;
    const max = hasDates ? this.maxMonth : 0;
    const curFrom = max - 11;
    const prevFrom = max - 23;
    const out: CrimeCell[] = [];
    const r2 = (n: number) => Math.round(n * 100) / 100;

    for (const c of this.cells.values()) {
      const pairs: number[] = [];
      for (let i = 0; i < c.slots.length; i++) if (c.slots[i] > 0) pairs.push(i, r2(c.slots[i]));
      const recent = new Array<number>(NCAT).fill(0);
      const cur = new Array<number>(NCAT).fill(0);
      const prev = new Array<number>(NCAT).fill(0);
      for (const [m, counts] of c.months) {
        // Sem data: peso neutro de 0,5 e fora das janelas de tendência.
        // Sem data: peso neutro 0,5. Depois do fim da cobertura: peso 1 (nunca acima).
        const w = m < 0 || !hasDates ? 0.5 : 0.5 ** (Math.max(0, max - m) / halfLifeMonths);
        for (let k = 0; k < NCAT; k++) {
          recent[k] += counts[k] * w;
          if (m >= curFrom) cur[k] += counts[k];
          else if (m >= prevFrom) prev[k] += counts[k];
        }
      }
      out.push([
        +((c.x + 0.5) * this.cellDeg).toFixed(5),
        +((c.y + 0.5) * this.cellDeg).toFixed(5),
        pairs,
        recent.map(r2),
        cur,
        prev,
      ]);
    }

    const trend = hasDates
      ? {
          current: [monthLabel(curFrom), monthLabel(max)] as [string, string],
          previous: [monthLabel(prevFrom), monthLabel(curFrom - 1)] as [string, string],
          complete: cov!.from <= prevFrom,
        }
      : undefined;
    const coverage = cov ? { from: `${monthLabel(cov.from)}-01`, to: `${monthLabel(cov.to)}-28` } : null;
    return { cells: out, trend, coverage };
  }
}

/** Agrega contagens simples em células de grade (~110 m com 0.001°). */
export class CellAggregator {
  private readonly cells = new Map<string, { x: number; y: number; counts: number[] }>();

  constructor(
    readonly cellDeg: number,
    private readonly width: number,
  ) {}

  add(lon: number, lat: number, index: number, inc = 1): void {
    const x = Math.floor(lon / this.cellDeg);
    const y = Math.floor(lat / this.cellDeg);
    const key = `${x}:${y}`;
    let c = this.cells.get(key);
    if (!c) this.cells.set(key, (c = { x, y, counts: new Array(this.width).fill(0) }));
    c.counts[index] += inc;
  }

  get size(): number {
    return this.cells.size;
  }

  toCells(): number[][] {
    const out: number[][] = [];
    for (const c of this.cells.values()) {
      const lon = +((c.x + 0.5) * this.cellDeg).toFixed(5);
      const lat = +((c.y + 0.5) * this.cellDeg).toFixed(5);
      out.push([lon, lat, ...c.counts.map((n) => +n.toFixed(2))]);
    }
    return out;
  }
}


/** Normaliza nomes de coluna e textos: maiúsculas, sem acento, só [A-Z0-9_]. */
export function norm(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Encontra a primeira coluna existente entre os candidatos (comparação normalizada). */
export function findColumn(headers: string[], candidates: string[], override?: string): string | undefined {
  if (override) return headers.find((h) => norm(h) === norm(override));
  const map = new Map(headers.map((h) => [norm(h), h]));
  for (const c of candidates) {
    const hit = map.get(norm(c));
    if (hit) return hit;
  }
  return undefined;
}

/** Coordenada aceitando vírgula decimal e valores sem ponto (ex.: -235505123). */
export function parseCoord(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  let n = typeof v === 'number' ? v : Number(String(v).trim().replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n === 0) return null;
  let guard = 0;
  while (Math.abs(n) > 180 && guard++ < 12) n /= 10;
  return n;
}

/** Hora (0–23) a partir de Date, fração de dia do Excel ou texto "HH:MM[:SS]". */
export function parseHour(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getHours();
  if (typeof v === 'number') {
    if (v >= 0 && v < 1) return Math.floor(v * 24);
    if (Number.isInteger(v) && v >= 0 && v < 24) return v;
    if (v >= 1) return Math.floor((v % 1) * 24); // data+hora do Excel
    return null;
  }
  const m = String(v).match(/(\d{1,2})[:h](\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 0 && h < 24 ? h : null;
}

/** Data em AAAA-MM-DD a partir de Date, serial do Excel, ISO ou DD/MM/AAAA. */
export function parseDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    return new Date(Math.round((v - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

const VIOLENT = /HOMICIDIO|LATROCINIO|LESAO_CORPORAL|ESTUPRO|FEMINICIDIO|MORTE|TENTATIVA_DE_HOMICIDIO|SEQUESTRO/;

/** Agrupa a natureza do B.O. nas categorias usadas no mapa. */
export function categorize(natureza: unknown): CrimeCategory {
  const n = norm(natureza);
  if (VIOLENT.test(n)) return 'violento';
  if (n.includes('ROUBO')) return 'roubo';
  if (n.includes('FURTO')) return 'furto';
  return 'outros';
}

/**
 * Faixa do dia descrita em texto (coluna DESC_PERIODO da SSP), usada quando a hora
 * exata não foi registrada. Retorna a primeira hora da faixa de 6 horas, ou null.
 */
export function periodStartHour(v: unknown): number | null {
  const n = norm(v);
  if (!n || n === 'NULL') return null;
  if (n.includes('MADRUGADA')) return 0;
  if (n.includes('MANHA')) return 6;
  if (n.includes('TARDE')) return 12;
  if (n.includes('NOITE')) return 18;
  return null;
}

/** Parser de CSV com aspas, para um separador conhecido. */
export function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
