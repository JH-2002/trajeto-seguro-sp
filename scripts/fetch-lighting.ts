/**
 * Baixa dados de iluminação pública e gera public/data/lighting.json.
 *
 *   npm run data:lighting                    # tenta GeoSampa e, se falhar, OpenStreetMap
 *   npm run data:lighting -- --source osm
 *   npm run data:lighting -- --layer geoportal:nome_da_camada
 *
 * GeoSampa (Prefeitura de SP): pontos de iluminação pública via WFS. O nome da camada é
 * descoberto no GetCapabilities procurando por "iluminação"/"poste".
 * OpenStreetMap (Overpass): vias marcadas com lit=yes e postes (highway=street_lamp).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import type { LightingDataset } from '../src/types';
import { CellAggregator } from './lib/common';
import { httpGet } from './lib/sspScraper';

const { values: args } = parseArgs({
  options: {
    source: { type: 'string', default: 'auto' },
    layer: { type: 'string' },
    wfs: { type: 'string', default: 'http://wfs.geosampa.prefeitura.sp.gov.br/geoserver/ows' },
    overpass: { type: 'string', default: 'https://overpass-api.de/api/interpreter' },
    out: { type: 'string', default: 'public/data' },
    bbox: { type: 'string', default: '-46.83,-24.01,-46.36,-23.35' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (args.help) {
  console.log(`Uso: npm run data:lighting -- [--source auto|geosampa|osm] [--layer NOME] [--out DIR]`);
  process.exit(0);
}

const CELL = 0.001;
const [W, S, E, N] = args.bbox!.split(',').map(Number);
const inside = (lon: number, lat: number) => lon >= W && lon <= E && lat >= S && lat <= N;
const log = (m: string) => console.log(m);

/** Garante ordem [lon, lat]: alguns servidores WFS devolvem lat/lon em EPSG:4326. */
function lonLat(c: number[]): [number, number] {
  const [a, b] = c;
  return Math.abs(a) < Math.abs(b) && a > -30 && a < -20 ? [b, a] : [a, b];
}

/** Todos os vértices de uma geometria GeoJSON (pontos, linhas ou polígonos). */
function* vertices(g: { type: string; coordinates?: unknown; geometries?: unknown[] } | null): Generator<number[]> {
  if (!g) return;
  if (g.type === 'GeometryCollection') {
    for (const x of (g.geometries ?? []) as never[]) yield* vertices(x);
    return;
  }
  const walk = function* (c: unknown): Generator<number[]> {
    if (Array.isArray(c) && typeof c[0] === 'number') yield c as number[];
    else if (Array.isArray(c)) for (const x of c) yield* walk(x);
  };
  yield* walk(g.coordinates);
}

// ---------------- GeoSampa (WFS) ----------------

async function discoverLayer(): Promise<string> {
  if (args.layer) return args.layer;
  const url = `${args.wfs}?service=WFS&version=2.0.0&request=GetCapabilities`;
  log(`  GetCapabilities: ${url}`);
  const res = await httpGet(url, {}, { log, timeoutMs: 60_000 });
  if (!res.ok) throw new Error(`GetCapabilities respondeu ${res.status}`);
  const xml = await res.text();
  const types = [...xml.matchAll(/<(?:wfs:)?FeatureType>([\s\S]*?)<\/(?:wfs:)?FeatureType>/g)].map((m) => ({
    name: m[1].match(/<(?:wfs:)?Name>([^<]+)</)?.[1] ?? '',
    title: m[1].match(/<(?:wfs:)?Title>([^<]+)</)?.[1] ?? '',
  }));
  const score = (t: { name: string; title: string }) => {
    const s = `${t.name} ${t.title}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (!/ilumina|poste/.test(s)) return 0;
    return 1 + (/ponto|poste/.test(s) ? 2 : 0) + (/led|moderniz/.test(s) ? -1 : 0);
  };
  const ranked = types.filter((t) => score(t) > 0).sort((a, b) => score(b) - score(a));
  log(`  ${types.length} camadas no serviço; candidatas: ${ranked.map((t) => `${t.name} (${t.title})`).join(', ') || 'nenhuma'}`);
  if (!ranked.length) throw new Error('Nenhuma camada de iluminação encontrada no WFS. Informe com --layer.');
  return ranked[0].name;
}

async function fromGeoSampa(agg: CellAggregator): Promise<number> {
  const layer = await discoverLayer();
  log(`  camada: ${layer}`);
  const PAGE = 50_000;
  let start = 0;
  let total = 0;
  for (;;) {
    const params = new URLSearchParams({
      service: 'WFS',
      version: '2.0.0',
      request: 'GetFeature',
      typeNames: layer,
      outputFormat: 'application/json',
      srsName: 'EPSG:4326',
      count: String(PAGE),
      startIndex: String(start),
    });
    const res = await httpGet(`${args.wfs}?${params}`, {}, { log, timeoutMs: 180_000 });
    if (!res.ok) throw new Error(`GetFeature respondeu ${res.status}`);
    const text = await res.text();
    if (!text.trimStart().startsWith('{')) throw new Error(`Resposta não é GeoJSON: ${text.slice(0, 160)}`);
    const fc = JSON.parse(text) as { features: { geometry: never }[] };
    for (const f of fc.features) {
      // Um ponto por feição (centroide dos vértices, para o caso de não ser ponto).
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (const v of vertices(f.geometry)) {
        const [lon, lat] = lonLat(v);
        sx += lon;
        sy += lat;
        n++;
      }
      if (!n) continue;
      const lon = sx / n;
      const lat = sy / n;
      if (!inside(lon, lat)) continue;
      agg.add(lon, lat, 0);
      total++;
    }
    process.stdout.write(`\r    ${total.toLocaleString('pt-BR')} pontos`);
    if (fc.features.length < PAGE) break;
    start += PAGE;
  }
  process.stdout.write('\n');
  if (total === 0) throw new Error('A camada não retornou pontos dentro da área.');
  return total;
}

// ---------------- OpenStreetMap (Overpass) ----------------

async function fromOsm(agg: CellAggregator): Promise<number> {
  // Divide a cidade em 4 faixas para não estourar o tempo limite do Overpass.
  const tiles: [number, number, number, number][] = [];
  const dy = (N - S) / 4;
  for (let i = 0; i < 4; i++) tiles.push([S + i * dy, W, S + (i + 1) * dy, E]);
  let total = 0;
  for (const [s, w, n, e] of tiles) {
    const q = `[out:json][timeout:180];(way["highway"]["lit"="yes"](${s},${w},${n},${e});node["highway"="street_lamp"](${s},${w},${n},${e}););out geom;`;
    log(`  Overpass: faixa ${s.toFixed(2)}…${n.toFixed(2)}`);
    const res = await httpGet(args.overpass!, { method: 'POST', body: new URLSearchParams({ data: q }) }, { log, timeoutMs: 240_000 });
    if (!res.ok) throw new Error(`Overpass respondeu ${res.status}`);
    const data = (await res.json()) as { elements: { type: string; lat?: number; lon?: number; geometry?: { lat: number; lon: number }[] }[] };
    for (const el of data.elements) {
      if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
        agg.add(el.lon, el.lat, 0);
        total++;
      } else if (el.geometry) {
        // Via iluminada: 1 "ponto de luz" equivalente a cada ~35 m.
        for (let i = 1; i < el.geometry.length; i++) {
          const a = el.geometry[i - 1];
          const b = el.geometry[i];
          const dist = Math.hypot((b.lon - a.lon) * 102_000, (b.lat - a.lat) * 111_320);
          const steps = Math.max(1, Math.round(dist / 35));
          for (let k = 0; k < steps; k++) {
            const t = (k + 0.5) / steps;
            const lon = a.lon + (b.lon - a.lon) * t;
            const lat = a.lat + (b.lat - a.lat) * t;
            if (inside(lon, lat)) {
              agg.add(lon, lat, 0);
              total++;
            }
          }
        }
      }
    }
    log(`    ${total.toLocaleString('pt-BR')} pontos até agora`);
  }
  return total;
}

// ---------------- main ----------------

async function main() {
  const agg = new CellAggregator(CELL, 1);
  let method: 'geosampa' | 'osm' = 'geosampa';
  let records = 0;
  if (args.source !== 'osm') {
    try {
      console.log('▶ Iluminação: GeoSampa (Prefeitura de SP)');
      records = await fromGeoSampa(agg);
    } catch (err) {
      if (args.source === 'geosampa') throw err;
      console.warn(`  ⚠ GeoSampa indisponível (${(err as Error).message}); usando OpenStreetMap`);
    }
  }
  if (records === 0) {
    method = 'osm';
    console.log('▶ Iluminação: OpenStreetMap (vias lit=yes e postes)');
    records = await fromOsm(agg);
  }

  const ds: LightingDataset = {
    meta: {
      source: method === 'geosampa' ? 'GeoSampa — Prefeitura de São Paulo' : 'OpenStreetMap (lit=yes, street_lamp)',
      generatedAt: new Date().toISOString(),
      records,
      isDemo: false,
      method,
      notes:
        method === 'osm'
          ? 'Cobertura do OSM é parcial: ausência de marcação não significa rua escura.'
          : 'Pontos de iluminação pública cadastrados pela Prefeitura.',
    },
    cellSizeDeg: CELL,
    cells: agg.toCells(),
  };
  fs.mkdirSync(args.out!, { recursive: true });
  const out = path.join(args.out!, 'lighting.json');
  fs.writeFileSync(out, JSON.stringify(ds));
  console.log(`✔ ${out}: ${records.toLocaleString('pt-BR')} pontos em ${agg.size.toLocaleString('pt-BR')} células (${method})`);
}

main().catch((err) => {
  console.error(`✖ ${(err as Error).message}`);
  process.exit(1);
});
