/**
 * Descoberta e download das planilhas de dados criminais da SSP-SP.
 *
 * A página de consultas (https://www.ssp.sp.gov.br/estatistica/consultas) é uma
 * aplicação Angular: os links das planilhas não estão no HTML, são montados no
 * JavaScript. Por isso o scraper:
 *   1. baixa o HTML e procura links diretos;
 *   2. baixa os bundles JS referenciados e extrai caminhos de planilhas e a pasta
 *      onde ficam (ex.: assets/estatistica/transparencia/spDados/);
 *   3. combina isso com o padrão de nome conhecido (SPDadosCriminais_<ANO>.xlsx);
 *   4. valida cada candidato (não pode ser HTML, precisa começar com "PK" de .xlsx);
 *   5. baixa só o que é novo ou mudou (ETag / Last-Modified / tamanho).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const SSP_ORIGIN = 'https://www.ssp.sp.gov.br';
export const SSP_PAGE = `${SSP_ORIGIN}/estatistica/consultas`;
/** Pasta conhecida das planilhas; usada se a descoberta não encontrar outra. */
export const SSP_DEFAULT_DIR = `${SSP_ORIGIN}/assets/estatistica/transparencia/spDados/`;
export const FILE_PREFIX = 'SPDadosCriminais';

const USER_AGENT = 'TrajetoSeguroSP-data/0.2 (dados abertos; uso nao comercial)';

export interface Candidate {
  url: string;
  /** Como chegamos nele: link no HTML/JS ou padrão de nome. */
  origin: 'html' | 'bundle' | 'pattern';
}

export interface RemoteInfo {
  url: string;
  ok: boolean;
  status: number;
  size?: number;
  lastModified?: string;
  etag?: string;
  reason?: string;
}

export interface ManifestEntry {
  url: string;
  file: string;
  size?: number;
  lastModified?: string;
  etag?: string;
  downloadedAt: string;
}
export type Manifest = Record<string, ManifestEntry>;

// ---------------------------------------------------------------- parsing (puro)

const SHEET_EXT = /\.(xlsx|xls|csv|zip)(?:\?[^"'`\s<>]*)?$/i;

/** Extrai URLs de scripts (<script src>) do HTML, resolvidas contra a página. */
export function extractScriptUrls(html: string, pageUrl: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    try {
      const u = new URL(m[1], pageUrl);
      if (u.origin === new URL(pageUrl).origin && u.pathname.endsWith('.js')) out.add(u.href);
    } catch {
      /* ignora src inválido */
    }
  }
  return [...out];
}

/** Links para planilhas em atributos href/src do HTML. */
export function extractHtmlLinks(html: string, pageUrl: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/(?:href|src)=["']([^"']+)["']/gi)) {
    if (!SHEET_EXT.test(m[1])) continue;
    try {
      out.add(new URL(m[1], pageUrl).href);
    } catch {
      /* ignora */
    }
  }
  return [...out];
}

/**
 * Procura, dentro de um bundle JS, strings que pareçam caminhos de planilhas
 * ("assets/.../SPDadosCriminais_2024.xlsx") e pastas de planilhas ("assets/.../spDados/").
 */
export function extractFromBundle(js: string, origin: string): { files: string[]; dirs: string[] } {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const m of js.matchAll(/["'`]([^"'`\s]{3,300})["'`]/g)) {
    const s = m[1];
    const abs = (p: string) => {
      try {
        return new URL(p.startsWith('http') ? p : `/${p.replace(/^\.?\/+/, '')}`, origin).href;
      } catch {
        return null;
      }
    };
    if (SHEET_EXT.test(s) && /assets\/|\/estatistica\//i.test(s)) {
      const u = abs(s);
      if (u) files.add(u);
    } else if (/(^|\/)assets\/estatistica\/.*\/$/i.test(s) || /spDados\/?$/i.test(s)) {
      const u = abs(s.endsWith('/') ? s : `${s}/`);
      if (u) dirs.add(u);
    }
  }
  return { files: [...files], dirs: [...dirs] };
}

/** Nomes de arquivo a testar para um ano (anual e, por garantia, semestral). */
export function patternNames(year: number): string[] {
  return [`${FILE_PREFIX}_${year}.xlsx`, `${FILE_PREFIX}_${year}_1.xlsx`, `${FILE_PREFIX}_${year}_2.xlsx`];
}

export function isCrimeSheet(url: string): boolean {
  return new RegExp(`${FILE_PREFIX}`, 'i').test(decodeURIComponent(new URL(url).pathname));
}

export function yearOf(url: string): number | null {
  const m = decodeURIComponent(url).match(/(20\d{2})/);
  return m ? Number(m[1]) : null;
}

export function fileNameOf(url: string): string {
  return decodeURIComponent(path.posix.basename(new URL(url).pathname));
}

/** Decide se o remoto mudou em relação ao que já foi baixado. */
export function needsDownload(remote: RemoteInfo, local: ManifestEntry | undefined, fileExists: boolean): boolean {
  if (!local || !fileExists) return true;
  if (remote.etag && local.etag) return remote.etag !== local.etag;
  if (remote.lastModified && local.lastModified && remote.lastModified !== local.lastModified) return true;
  if (remote.size && local.size && remote.size !== local.size) return true;
  return false;
}

// ---------------------------------------------------------------- rede

export interface HttpOptions {
  retries?: number;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function httpGet(url: string, init: RequestInit = {}, opts: HttpOptions = {}): Promise<Response> {
  const retries = opts.retries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        ...init,
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...(init.headers ?? {}) },
        signal: init.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      // 5xx e 429 valem nova tentativa; 4xx é definitivo.
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const wait = 1000 * 2 ** attempt;
        opts.log?.(`    tentativa ${attempt + 1} falhou (${(err as Error).message}); nova tentativa em ${wait / 1000}s`);
        await sleep(wait);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function discover(pageUrl: string, opts: HttpOptions = {}): Promise<{ candidates: Candidate[]; dirs: string[] }> {
  const log = opts.log ?? (() => undefined);
  const origin = new URL(pageUrl).origin;
  const found = new Map<string, Candidate>();
  const dirs = new Set<string>();

  log(`  página: ${pageUrl}`);
  const res = await httpGet(pageUrl, {}, opts);
  if (!res.ok) throw new Error(`A página de consultas respondeu ${res.status}.`);
  const html = await res.text();

  for (const u of extractHtmlLinks(html, pageUrl)) found.set(u, { url: u, origin: 'html' });

  const scripts = extractScriptUrls(html, pageUrl).slice(0, 25);
  log(`  ${scripts.length} bundle(s) JS para inspecionar`);
  for (const s of scripts) {
    try {
      const r = await httpGet(s, {}, { ...opts, retries: 1 });
      if (!r.ok) continue;
      const { files, dirs: d } = extractFromBundle(await r.text(), origin);
      for (const f of files) if (!found.has(f)) found.set(f, { url: f, origin: 'bundle' });
      d.forEach((x) => dirs.add(x));
    } catch (err) {
      log(`    não consegui ler ${s}: ${(err as Error).message}`);
    }
  }
  return { candidates: [...found.values()], dirs: [...dirs] };
}

/** HEAD (ou GET de 1 byte, se o servidor não aceitar HEAD) para validar sem baixar. */
export async function probe(url: string, opts: HttpOptions = {}): Promise<RemoteInfo> {
  let res = await httpGet(url, { method: 'HEAD' }, { ...opts, retries: 1 });
  if (res.status === 405 || res.status === 403 || res.status === 501) {
    res = await httpGet(url, { headers: { Range: 'bytes=0-3' } }, { ...opts, retries: 1 });
  }
  const info: RemoteInfo = {
    url,
    ok: res.ok,
    status: res.status,
    lastModified: res.headers.get('last-modified') ?? undefined,
    etag: res.headers.get('etag') ?? undefined,
  };
  const range = res.headers.get('content-range');
  const len = range ? range.split('/')[1] : res.headers.get('content-length');
  if (len && /^\d+$/.test(len)) info.size = Number(len);
  if (res.body) await res.body.cancel().catch(() => undefined);

  if (!res.ok) return { ...info, ok: false, reason: `HTTP ${res.status}` };
  // Aplicações Angular devolvem o index.html (200) para qualquer caminho inexistente.
  if (/text\/html/i.test(res.headers.get('content-type') ?? '')) return { ...info, ok: false, reason: 'resposta é HTML, não planilha' };
  if (info.size !== undefined && info.size < 1024) return { ...info, ok: false, reason: `arquivo pequeno demais (${info.size} B)` };
  return info;
}

/**
 * Baixa em streaming para um .part e só renomeia se o conteúdo for um .xlsx válido
 * (assinatura ZIP). Se a conexão cair no meio, continua de onde parou com
 * `Range` + `If-Range` (o servidor só "emenda" se o arquivo remoto não mudou);
 * um .part deixado por uma execução anterior também é aproveitado.
 */
export async function download(
  info: RemoteInfo,
  dest: string,
  opts: HttpOptions & { onProgress?: (done: number, total?: number) => void; maxResumes?: number } = {},
): Promise<number> {
  const tmp = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const validator = info.etag ?? info.lastModified;
  const maxResumes = opts.maxResumes ?? 8;
  let total = info.size;
  let done = fs.existsSync(tmp) && validator ? fs.statSync(tmp).size : 0;
  if (done && total && done >= total) done = 0; // .part inconsistente: recomeça
  if (done) opts.log?.(`    retomando do byte ${done.toLocaleString('pt-BR')} (.part de execução anterior)`);

  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = {};
    if (done > 0 && validator) {
      headers.Range = `bytes=${done}-`;
      headers['If-Range'] = validator;
    }
    try {
      const res = await httpGet(info.url, { headers }, { ...opts, timeoutMs: 60 * 60_000 });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      if (res.status === 206) {
        const range = res.headers.get('content-range')?.split('/')[1];
        if (range && /^\d+$/.test(range)) total = Number(range);
      } else {
        // 200: o servidor ignorou o Range (ou o arquivo mudou) — recomeça do zero.
        done = 0;
        total = Number(res.headers.get('content-length')) || total;
      }

      let last = done;
      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          done += chunk.byteLength;
          if (done - last > 2_000_000) {
            last = done;
            opts.onProgress?.(done, total);
          }
          ctl.enqueue(chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(res.body.pipeThrough(counter) as never),
        fs.createWriteStream(tmp, { flags: res.status === 206 ? 'a' : 'w' }),
      );
      opts.onProgress?.(done, total);
      if (!total || done >= total) break;
      throw new Error(`conexão encerrada em ${done} de ${total} bytes`);
    } catch (err) {
      // O que já foi gravado no .part vale; recalcula pelo tamanho real do arquivo.
      done = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
      if (attempt >= maxResumes) throw new Error(`Download falhou após ${attempt + 1} tentativas: ${(err as Error).message}`);
      const wait = Math.min(30_000, 2000 * 2 ** attempt);
      const canResume = Boolean(validator);
      opts.log?.(
        `\n    conexão caiu (${(err as Error).message}); ${canResume ? `retomando do byte ${done.toLocaleString('pt-BR')}` : 'recomeçando'} em ${wait / 1000}s`,
      );
      if (!canResume) done = 0;
      await sleep(wait);
    }
  }

  const fd = fs.openSync(tmp, 'r');
  const sig = Buffer.alloc(2);
  fs.readSync(fd, sig, 0, 2, 0);
  fs.closeSync(fd);
  if (dest.toLowerCase().endsWith('.xlsx') && sig.toString('latin1') !== 'PK') {
    fs.rmSync(tmp, { force: true });
    throw new Error('O conteúdo baixado não é uma planilha .xlsx válida.');
  }
  if (total && done !== total) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Download incompleto (${done} de ${total} bytes).`);
  }
  fs.renameSync(tmp, dest);
  return done;
}

export function readManifest(file: string): Manifest {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
  } catch {
    return {};
  }
}

export function writeManifest(file: string, m: Manifest): void {
  fs.writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
}
