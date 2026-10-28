import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CrimeAggregator } from '../scripts/lib/common';
import { buildCrimePoints, decodeCrimes, hourWeights } from '../src/data/dataStore';
import { inspectArea } from '../src/data/inspect';
import { CRIME_CATEGORIES, type CrimeDataset } from '../src/types';
import { readShareState, toQuery } from '../src/ui/urlState';

function dataset(): CrimeDataset {
  const agg = new CrimeAggregator(0.001);
  // Célula A: roubos à noite, crescendo no último ano.
  for (let i = 0; i < 10; i++) agg.add(-46.6335, -23.5505, 'roubo', 21, '2024-03-10');
  for (let i = 0; i < 20; i++) agg.add(-46.6335, -23.5505, 'roubo', 21, '2025-06-10');
  // Célula A: furtos de manhã, sem data.
  for (let i = 0; i < 4; i++) agg.add(-46.6335, -23.5505, 'furto', 9, null);
  // Célula B, longe (~2 km): violento sem hora.
  agg.add(-46.6535, -23.5505, 'violento', null, '2025-08-01');
  const { cells, trend } = agg.finish(12);
  return {
    version: 2,
    meta: { source: 't', generatedAt: '', records: 35, isDemo: true, halfLifeMonths: 12, trend },
    cellSizeDeg: 0.001,
    cells,
  };
}

test('agregador: janelas de tendência e peso por recência', () => {
  const ds = dataset();
  // Cobertura vai até 2025-06 (o único B.O. de 2025-08 é avulso demais para contar como mês coberto).
  assert.deepEqual(ds.meta.trend, { current: ['2024-07', '2025-06'], previous: ['2023-07', '2024-06'], complete: false });
  const a = ds.cells.find((c) => c[0] === -46.6335)!;
  const roubo = CRIME_CATEGORIES.indexOf('roubo');
  assert.equal(a[4][roubo], 20, '12 meses atuais');
  assert.equal(a[5][roubo], 10, '12 meses anteriores');
  // Mais antigo pesa menos: 10 × 0,5^(15/12) + 20 × 1 ≈ 4,2 + 20
  assert.ok(a[3][roubo] > 23.5 && a[3][roubo] < 25);
  const b = ds.cells.find((c) => c[0] === -46.6535)!;
  assert.equal(b[3][CRIME_CATEGORIES.indexOf('violento')], 1, 'após a cobertura o peso é 1, não mais');
});

test('filtro por hora usa janela suave e conta ocorrências sem hora', () => {
  const store = decodeCrimes(dataset());
  const all = new Set(CRIME_CATEGORIES);
  const w = hourWeights(21);
  assert.equal(w[21], 1);
  assert.equal(w[22], 0.5);
  assert.equal(w[20], 0.5);
  assert.equal(buildCrimePoints(store, { categories: all, hour: 'todos', recency: false }).total, 35);
  const at21 = buildCrimePoints(store, { categories: new Set(['roubo']), hour: 21, recency: false });
  assert.equal(at21.points.length, 1);
  assert.equal(at21.points[0].count, 30);
  const at9 = buildCrimePoints(store, { categories: new Set(['furto']), hour: 10, recency: false });
  assert.equal(at9.points[0].count, 2, 'vizinha (9h) vale metade');
});

test('recência reduz o peso de células com ocorrências antigas', () => {
  const store = decodeCrimes(dataset());
  const all = new Set(CRIME_CATEGORIES);
  const plain = buildCrimePoints(store, { categories: all, hour: 'todos', recency: false });
  const rec = buildCrimePoints(store, { categories: all, hour: 'todos', recency: true });
  assert.equal(rec.total, plain.total, 'a contagem visual não muda');
  const riskOf = (r: typeof plain, lon: number) => r.points.find((p) => p.position[0] === lon)!.risk;
  // Célula B (só ocorrência recente) ganha peso relativo frente à célula A.
  assert.ok(riskOf(rec, -46.6535) / riskOf(rec, -46.6335) > riskOf(plain, -46.6535) / riskOf(plain, -46.6335));
});

test('inspetor soma só o raio escolhido e acha o horário de pico', () => {
  const store = decodeCrimes(dataset());
  const s = inspectArea(store, [-46.6335, -23.5505], 300, new Set(CRIME_CATEGORIES), null, null);
  assert.equal(s.total, 34, 'célula B fica fora do raio');
  assert.equal(s.peakHour, 21);
  assert.equal(s.byCategory[0].cat, 'roubo');
  assert.equal(s.trend, null, 'tendência só com as duas janelas completas');
});

test('link compartilhável: ida e volta', () => {
  const q = toQuery({
    origin: [-46.63391, -23.55031],
    destination: [-46.65577, -23.56142],
    mode: 'bike',
    tolerance: 0.5,
    hour: 22,
    categories: new Set(['roubo', 'violento']),
    recency: true,
  });
  const back = readShareState(q);
  assert.deepEqual(back.origin, [-46.63391, -23.55031]);
  assert.deepEqual(back.destination, [-46.65577, -23.56142]);
  assert.equal(back.mode, 'bike');
  assert.equal(back.tolerance, 0.5);
  assert.equal(back.hour, 22);
  assert.deepEqual([...back.categories!].sort(), ['roubo', 'violento']);
  assert.equal(back.recency, true);
  assert.equal(toQuery({ origin: null, destination: null, mode: 'foot', tolerance: 0.3, hour: 'todos', categories: new Set(CRIME_CATEGORIES), recency: false }), '');
  assert.deepEqual(readShareState('?o=lixo&h=99&m=aviao'), {});
});

test('cobertura ignora registros tardios de anos antigos na tendência', () => {
  const agg = new CrimeAggregator(0.001);
  // Um ano inteiro de 2024 (100/mês) + poucos B.O.s sobre fatos de 2004 e 2023.
  for (let m = 1; m <= 12; m++) for (let i = 0; i < 100; i++) agg.add(-46.63, -23.55, 'furto', 10, `2024-${String(m).padStart(2, '0')}-10`);
  for (let i = 0; i < 3; i++) agg.add(-46.63, -23.55, 'furto', 10, '2004-07-28');
  for (let i = 0; i < 8; i++) agg.add(-46.63, -23.55, 'furto', 10, '2023-05-02');
  // Muitos meses fantasmas (como no arquivo real de 2024): 2012–2023 com ~5 registros cada.
  for (let y = 2012; y <= 2023; y++) for (let m = 1; m <= 12; m++) for (let i = 0; i < 5; i++) agg.add(-46.63, -23.55, 'furto', 10, `${y}-${String(m).padStart(2, '0')}-15`);
  const { trend, coverage } = agg.finish(12);
  assert.deepEqual(coverage, { from: '2024-01-01', to: '2024-12-28' });
  assert.equal(trend?.complete, false, 'só 2024 de verdade: sem tendência');
});
