/**
 * Converte os dados abertos em JSON agregado para o front-end.
 *
 *   npm run data -- --raw-dir data/raw          # usa tudo que o scraper baixou
 *   npm run data -- --crimes arquivo.xlsx --accidents sinistros.csv
 *
 * Crimes: planilhas SPDadosCriminais_<ANO>.xlsx da SSP-SP (ou .csv).
 * Acidentes: CSV de "sinistros" do Infosiga-SP / DETRAN-SP.
 *
 * As colunas são detectadas por nome; use --col-* para forçar, caso a SSP mude o layout.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import type { AccidentDataset, CrimeDataset } from '../src/types';
import {
  CellAggregator,
  CrimeAggregator,
  categorize,
  findColumn,
  norm,
  parseCoord,
  parseDate,
  parseHour,
  periodStartHour,
} from './lib/common';
import { readCsvRows, readRows } from './lib/readers';

const { values: args } = parseArgs({
  options: {
    'raw-dir': { type: 'string' },
    crimes: { type: 'string', multiple: true, default: [] },
    accidents: { type: 'string', multiple: true, default: [] },
    out: { type: 'string', default: 'public/data' },
    cell: { type: 'string', default: '0.001' },
    bbox: { type: 'string', default: '-46.83,-24.01,-46.36,-23.35' },
    since: { type: 'string' },
    'half-life': { type: 'string', default: '12' },
    municipio: { type: 'string' },
    'col-lat': { type: 'string' },
    'col-lon': { type: 'string' },
    'col-natureza': { type: 'string' },
    'col-hora': { type: 'string' },
    'col-data': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

// --raw-dir: pega automaticamente as planilhas da SSP e o CSV de sinistros da pasta.
if (args['raw-dir']) {
  const dir = args['raw-dir'];
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  for (const n of names) {
    const full = path.join(dir, n);
    if (/^SPDadosCriminais.*\.(xlsx|csv)$/i.test(n)) args.crimes!.push(full);
    else if (/sinistros.*\.csv$/i.test(n)) args.accidents!.push(full);
  }
  console.log(`▶ ${dir}: ${args.crimes!.length} planilha(s) de crimes, ${args.accidents!.length} arquivo(s) de acidentes`);
}

if (args.help || (args.crimes!.length === 0 && args.accidents!.length === 0)) {
  console.log(`Uso: npm run data -- [--raw-dir data/raw] [--crimes arquivo.xlsx ...] [--accidents sinistros.csv ...]
  --raw-dir DIR      usa SPDadosCriminais*.xlsx e sinistros*.csv dessa pasta
  --out DIR          pasta de saída (padrão public/data)
  --cell GRAUS       tamanho da célula (padrão 0.001 ≈ 110 m)
  --bbox w,s,e,n     recorte geográfico (padrão: município de SP)
  --since AAAA-MM-DD descarta ocorrências anteriores
  --half-life MESES  meia-vida do peso por recência (padrão 12)
  --municipio NOME   filtra pela coluna de município (ex.: "S.PAULO")
  --col-lat/--col-lon/--col-natureza/--col-hora/--col-data  força nomes de coluna`);
  process.exit(args.help ? 0 : 1);
}

const cellDeg = Number(args.cell);
const [W, S, E, N] = args.bbox!.split(',').map(Number);
const since = args.since ?? null;
const municipio = args.municipio ? norm(args.municipio) : null;
const inside = (lon: number, lat: number) => lon >= W && lon <= E && lat >= S && lat <= N;

interface Range {
  from: string | null;
  to: string | null;
}
const track = (r: Range, d: string | null) => {
  if (!d) return;
  if (!r.from || d < r.from) r.from = d;
  if (!r.to || d > r.to) r.to = d;
};

function progress(label: string, n: number) {
  if (n % 100_000 === 0) process.stdout.write(`\r    ${label}: ${n.toLocaleString('pt-BR')} linhas lidas`);
}

// ---------------- crimes ----------------

async function processCrimes(files: string[]): Promise<CrimeDataset | null> {
  if (files.length === 0) return null;
  const agg = new CrimeAggregator(cellDeg);
  const range: Range = { from: null, to: null };
  const seen = new Set<string>();
  let kept = 0;
  const skipped = { coords: 0, bbox: 0, date: 0, dup: 0, municipio: 0 };
  let byPeriod = 0;

  for (const file of files) {
    console.log(`  lendo ${path.basename(file)}…`);
    let cols: Record<string, string | undefined> | null = null;
    let headerKey = '';
    let n = 0;
    for await (const row of readRows(file, (name) => console.log(`\n    aba "${name}"`))) {
      progress(path.basename(file), ++n);
      const keys = Object.keys(row);
      // Cada aba pode ter cabeçalho próprio: redetecta quando muda.
      if (!cols || keys.join('|') !== headerKey) {
        headerKey = keys.join('|');
        cols = {
          lat: findColumn(keys, ['LATITUDE', 'LAT'], args['col-lat']),
          lon: findColumn(keys, ['LONGITUDE', 'LON', 'LONG'], args['col-lon']),
          nat: findColumn(keys, ['NATUREZA_APURADA', 'RUBRICA', 'NATUREZA', 'DESCR_NATUREZA', 'DESC_NATUREZA'], args['col-natureza']),
          hora: findColumn(keys, ['HORA_OCORRENCIA_BO', 'HORA_OCORRENCIA', 'HORAOCORRENCIA', 'HORA_FATO', 'HORA'], args['col-hora']),
          periodo: findColumn(keys, ['DESC_PERIODO', 'PERIODO', 'PERIODO_OCORRENCIA']),
          data: findColumn(keys, ['DATA_OCORRENCIA_BO', 'DATA_OCORRENCIA', 'DATAOCORRENCIA', 'DATA_FATO', 'DATA'], args['col-data']),
          num: findColumn(keys, ['NUM_BO', 'NUMERO_BOLETIM', 'NUM_BOLETIM', 'NUMERO_BO']),
          ano: findColumn(keys, ['ANO_BO', 'ANO']),
          dp: findColumn(keys, ['NOME_DELEGACIA', 'DELEGACIA', 'NOME_DELEGACIA_CIRCUNSCRICAO', 'DP']),
          mun: findColumn(keys, ['NOME_MUNICIPIO', 'MUNICIPIO', 'CIDADE', 'NOME_MUNICIPIO_CIRCUNSCRICAO']),
        };
        console.log('\n    colunas detectadas:', cols);
        if (!cols.lat || !cols.lon) throw new Error(`Colunas de latitude/longitude não encontradas em ${file}. Use --col-lat/--col-lon.`);
      }

      if (municipio && cols.mun && norm(row[cols.mun]) !== municipio) {
        skipped.municipio++;
        continue;
      }
      const lat = parseCoord(row[cols.lat!]);
      const lon = parseCoord(row[cols.lon!]);
      if (lat === null || lon === null) {
        skipped.coords++;
        continue;
      }
      if (!inside(lon, lat)) {
        skipped.bbox++;
        continue;
      }
      const date = cols.data ? parseDate(row[cols.data]) : null;
      if (since && date && date < since) {
        skipped.date++;
        continue;
      }
      const cat = categorize(cols.nat ? row[cols.nat] : '');
      // Um mesmo B.O. aparece em várias linhas (vítimas, objetos). Conta uma vez por natureza.
      if (cols.num) {
        const key = `${cols.ano ? row[cols.ano] : ''}|${row[cols.num]}|${cols.dp ? row[cols.dp] : ''}|${cat}`;
        if (seen.has(key)) {
          skipped.dup++;
          continue;
        }
        seen.add(key);
      }
      const hour = cols.hora ? parseHour(row[cols.hora]) : null;
      const pStart = hour === null && cols.periodo ? periodStartHour(row[cols.periodo]) : null;
      if (pStart !== null) {
        // Só a faixa é conhecida ("De madrugada"...): espalha 1/6 em cada hora dela.
        for (let h = pStart; h < pStart + 6; h++) agg.add(lon, lat, cat, h, date, 1 / 6);
        byPeriod++;
      } else {
        agg.add(lon, lat, cat, hour, date);
      }
      track(range, date);
      kept++;
    }
    process.stdout.write('\n');
  }

  console.log(`  crimes: ${kept.toLocaleString('pt-BR')} mantidos em ${agg.size.toLocaleString('pt-BR')} células; descartados:`, skipped);
  if (byPeriod) console.log(`  ${byPeriod.toLocaleString('pt-BR')} ocorrências sem hora exata distribuídas pela faixa do dia (DESC_PERIODO)`);
  const halfLifeMonths = Number(args['half-life']);
  const { cells, trend, coverage } = agg.finish(halfLifeMonths);
  if (coverage) console.log(`  período coberto pelos arquivos: ${coverage.from.slice(0, 7)} a ${coverage.to.slice(0, 7)}`);
  if (trend && !trend.complete) {
    console.log(`  (tendência parcial: para comparar 12 meses com os 12 anteriores, inclua dados desde ${trend.previous[0]})`);
  }
  return {
    version: 2,
    meta: {
      source: 'SSP-SP — dados criminais abertos',
      generatedAt: new Date().toISOString(),
      // Período pela cobertura real (não pela data mais antiga, que pode ser um registro tardio).
      period: coverage ?? (range.from && range.to ? { from: range.from, to: range.to } : undefined),
      records: kept,
      isDemo: false,
      notes: `Arquivos: ${files.map((f) => path.basename(f)).join(', ')}`,
      halfLifeMonths,
      trend,
    },
    cellSizeDeg: cellDeg,
    cells,
  };
}

// ---------------- acidentes ----------------

async function processAccidents(files: string[]): Promise<AccidentDataset | null> {
  if (files.length === 0) return null;
  const agg = new CellAggregator(cellDeg, 2);
  const range: Range = { from: null, to: null };
  let kept = 0;
  let fatalTotal = 0;
  const skipped = { coords: 0, bbox: 0, date: 0 };

  for (const file of files) {
    console.log(`  lendo ${path.basename(file)}…`);
    let cols: Record<string, string | undefined> | null = null;
    let n = 0;
    for await (const row of readCsvRows(file)) {
      progress(path.basename(file), ++n);
      if (!cols) {
        const keys = Object.keys(row);
        cols = {
          lat: findColumn(keys, ['latitude', 'lat']),
          lon: findColumn(keys, ['longitude', 'lon', 'long']),
          data: findColumn(keys, ['data_sinistro', 'data', 'data_ocorrencia']),
          tipo: findColumn(keys, ['tipo_registro', 'tipo_sinistro', 'gravidade']),
          // Contagem de óbitos, quando existir (o nome varia entre versões do Infosiga).
          obitos: keys.find((h) => /OBITO|FATAL/.test(norm(h)) && !/TIPO/.test(norm(h))),
        };
        console.log('\n    colunas detectadas:', cols);
        if (!cols.lat || !cols.lon) throw new Error(`Colunas de latitude/longitude não encontradas em ${file}.`);
      }
      const lat = parseCoord(row[cols.lat!]);
      const lon = parseCoord(row[cols.lon!]);
      if (lat === null || lon === null) {
        skipped.coords++;
        continue;
      }
      if (!inside(lon, lat)) {
        skipped.bbox++;
        continue;
      }
      const date = cols.data ? parseDate(row[cols.data]) : null;
      if (since && date && date < since) {
        skipped.date++;
        continue;
      }
      let fatal = false;
      if (cols.obitos) fatal = Number(String(row[cols.obitos]).replace(',', '.')) > 0;
      if (!fatal && cols.tipo) {
        const t = norm(row[cols.tipo]);
        fatal = t.includes('FATAL') && !t.includes('NAO_FATAL');
      }
      agg.add(lon, lat, 0);
      if (fatal) {
        agg.add(lon, lat, 1);
        fatalTotal++;
      }
      track(range, date);
      kept++;
    }
    process.stdout.write('\n');
  }

  console.log(`  acidentes: ${kept.toLocaleString('pt-BR')} mantidos (${fatalTotal} fatais) em ${agg.size.toLocaleString('pt-BR')} células; descartados:`, skipped);
  return {
    meta: {
      source: 'Infosiga-SP / DETRAN-SP',
      generatedAt: new Date().toISOString(),
      period: range.from && range.to ? { from: range.from, to: range.to } : undefined,
      records: kept,
      isDemo: false,
      notes: `Arquivos: ${files.map((f) => path.basename(f)).join(', ')}`,
    },
    cellSizeDeg: cellDeg,
    cells: agg.toCells(),
  };
}

// ---------------- main ----------------

function save(name: string, data: unknown) {
  const out = path.join(args.out!, name);
  fs.writeFileSync(out, JSON.stringify(data));
  console.log(`✔ ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
}

async function main() {
  fs.mkdirSync(args.out!, { recursive: true });
  const crimes = await processCrimes(args.crimes!);
  if (crimes) save('crimes.json', crimes);
  const accidents = await processAccidents(args.accidents!);
  if (accidents) save('accidents.json', accidents);
  // Sem acidentes reais, não mistura com a demonstração sintética.
  if (crimes && !accidents) {
    const acc = path.join(args.out!, 'accidents.json');
    try {
      const existing = JSON.parse(fs.readFileSync(acc, 'utf8')) as AccidentDataset;
      if (existing.meta.isDemo) {
        fs.rmSync(acc);
        console.log('  (acidentes de demonstração removidos; adicione o CSV do Infosiga para ter essa camada)');
      }
    } catch {
      /* não havia arquivo */
    }
  }
}

main().catch((err) => {
  console.error('\n✖', err instanceof Error ? err.message : err);
  process.exit(1);
});
