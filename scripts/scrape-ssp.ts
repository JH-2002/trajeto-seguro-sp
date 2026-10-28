/**
 * Baixa automaticamente as planilhas de dados criminais da SSP-SP.
 *
 *   npm run data:scrape                       # ano atual e os dois anteriores
 *   npm run data:scrape -- --years 2023-2025  # intervalo
 *   npm run data:scrape -- --dry-run          # só mostra o que encontrou
 *
 * Arquivos vão para data/raw/ e um manifesto (data/raw/ssp-manifest.json) guarda
 * ETag/Last-Modified para baixar de novo apenas o que mudou.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import {
  SSP_DEFAULT_DIR,
  SSP_PAGE,
  discover,
  download,
  fileNameOf,
  isCrimeSheet,
  needsDownload,
  patternNames,
  probe,
  readManifest,
  writeManifest,
  yearOf,
  type Candidate,
  type RemoteInfo,
} from './lib/sspScraper';

const { values: args } = parseArgs({
  options: {
    years: { type: 'string' },
    out: { type: 'string', default: 'data/raw' },
    page: { type: 'string', default: SSP_PAGE },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

if (args.help) {
  console.log(`Uso: npm run data:scrape -- [opções]
  --years 2025 | 2023,2025 | 2022-2025   anos desejados (padrão: atual e os dois anteriores)
  --out DIR                              destino (padrão data/raw)
  --page URL                             página de consultas da SSP-SP
  --dry-run                              só lista o que encontrou, sem baixar
  --force                                baixa de novo mesmo sem mudanças`);
  process.exit(0);
}

function parseYears(spec: string | undefined): number[] {
  const now = new Date().getFullYear();
  // Três anos garantem as duas janelas de 12 meses usadas na tendência.
  if (!spec) return [now - 2, now - 1, now];
  const years = new Set<number>();
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map((s) => Number(s.trim()));
    if (!Number.isInteger(a)) throw new Error(`Ano inválido: ${part}`);
    for (let y = a; y <= (Number.isInteger(b) ? b : a); y++) years.add(y);
  }
  return [...years].sort();
}

const mb = (n?: number) => (n === undefined ? '?' : `${(n / 1e6).toFixed(1)} MB`);
const log = (m: string) => console.log(m);

async function main() {
  const years = parseYears(args.years);
  const outDir = args.out!;
  const manifestPath = path.join(outDir, 'ssp-manifest.json');
  const manifest = readManifest(manifestPath);
  const origin = new URL(args.page!).origin;

  console.log(`▶ SSP-SP · anos ${years.join(', ')}`);

  // 1-2. Descoberta na página e nos bundles JS
  let discovered: Candidate[] = [];
  let dirs: string[] = [];
  try {
    const d = await discover(args.page!, { log });
    discovered = d.candidates.filter((c) => isCrimeSheet(c.url));
    dirs = d.dirs.filter((x) => /spdados|transparencia/i.test(x));
    console.log(`  descobertos: ${discovered.length} link(s) de planilha, ${dirs.length} pasta(s) de dados`);
  } catch (err) {
    console.warn(`  ⚠ descoberta falhou (${(err as Error).message}); seguindo só com o padrão de nomes`);
  }

  // 3. Candidatos finais: descobertos dos anos pedidos + padrão de nome em cada pasta
  const defaultDir = new URL(new URL(SSP_DEFAULT_DIR).pathname, origin).href;
  const searchDirs = [...new Set([...dirs, defaultDir])];
  const candidates = new Map<string, Candidate>();
  for (const c of discovered) {
    const y = yearOf(c.url);
    if (y === null || years.includes(y)) candidates.set(c.url, c);
  }
  for (const dir of searchDirs)
    for (const y of years) for (const name of patternNames(y)) {
      const url = new URL(name, dir).href;
      if (!candidates.has(url)) candidates.set(url, { url, origin: 'pattern' });
    }

  // 4. Validação
  console.log(`  validando ${candidates.size} candidato(s)…`);
  const valid: RemoteInfo[] = [];
  for (const c of candidates.values()) {
    try {
      const info = await probe(c.url, { log });
      if (info.ok) {
        valid.push(info);
        console.log(`  ✔ ${fileNameOf(c.url)} (${mb(info.size)}, ${c.origin}${info.lastModified ? `, ${info.lastModified}` : ''})`);
      } else if (c.origin !== 'pattern') {
        console.log(`  ✖ ${fileNameOf(c.url)}: ${info.reason}`);
      }
    } catch (err) {
      if (c.origin !== 'pattern') console.log(`  ✖ ${fileNameOf(c.url)}: ${(err as Error).message}`);
    }
  }

  // Um arquivo anual torna os semestrais do mesmo ano redundantes, e vice-versa.
  const byName = new Map(valid.map((v) => [fileNameOf(v.url), v]));
  const files = valid.filter((v) => {
    const m = fileNameOf(v.url).match(/_(\d{4})_[12]\.xlsx$/i);
    return !(m && byName.has(`${fileNameOf(v.url).split('_')[0]}_${m[1]}.xlsx`));
  });

  const missing = years.filter((y) => !files.some((f) => yearOf(f.url) === y));
  if (missing.length) console.warn(`  ⚠ nenhuma planilha encontrada para: ${missing.join(', ')} (o ano pode ainda não ter sido publicado)`);
  if (files.length === 0) {
    console.error('✖ Nada para baixar. Confira a página de consultas da SSP-SP ou use --page.');
    process.exit(2);
  }
  if (args['dry-run']) return;

  // 5. Download incremental
  fs.mkdirSync(outDir, { recursive: true });
  let downloaded = 0;
  const failed: string[] = [];
  for (const info of files) {
    const name = fileNameOf(info.url);
    const dest = path.join(outDir, name);
    if (!args.force && !needsDownload(info, manifest[name], fs.existsSync(dest))) {
      console.log(`  = ${name} sem mudanças, mantido`);
      continue;
    }
    console.log(`  ↓ ${name}`);
    const started = Date.now();
    let bytes: number;
    try {
      bytes = await download(info, dest, {
        log,
        onProgress: (done, total) => {
          const pct = total ? ` ${Math.floor((done / total) * 100)}%` : '';
          process.stdout.write(`\r    ${mb(done)}${total ? ` / ${mb(total)}` : ''}${pct}   `);
        },
      });
    } catch (err) {
      // Segue para os próximos; o .part fica guardado e a próxima execução continua dele.
      process.stdout.write('\n');
      console.error(`    ✖ ${name}: ${(err as Error).message}`);
      failed.push(name);
      continue;
    }
    process.stdout.write('\n');
    manifest[name] = {
      url: info.url,
      file: name,
      size: bytes,
      lastModified: info.lastModified,
      etag: info.etag,
      downloadedAt: new Date().toISOString(),
    };
    writeManifest(manifestPath, manifest);
    downloaded++;
    console.log(`    ✔ ${mb(bytes)} em ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
  if (failed.length) {
    console.error(
      `✖ ${failed.length} arquivo(s) não terminaram: ${failed.join(', ')}. Rode o mesmo comando de novo: o download continua de onde parou.`,
    );
    process.exit(1);
  }
  console.log(`✔ ${downloaded} arquivo(s) baixado(s), ${files.length - downloaded - failed.length} já atualizado(s) → ${outDir}/`);
}

main().catch((err) => {
  const e = err as Error & { cause?: { code?: string } };
  console.error(`✖ ${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''}`);
  if (e.cause?.code && /CERT|SSL|TLS/.test(e.cause.code)) {
    console.error('  Problema de certificado. Veja a seção "Problemas comuns" no README.');
  }
  process.exit(1);
});
