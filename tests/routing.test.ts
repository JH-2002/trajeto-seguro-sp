import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DensityGrid } from '../src/risk/densityGrid';
import { avoidedSegments, findPeaks, pickRoutes, scoreRoute, type RiskModel } from '../src/risk/scoring';
import { findSafeRoutes } from '../src/routing/safeRouter';
import type { RoutingProvider } from '../src/routing/provider';
import type { LngLat, Route } from '../src/types';
import { destination, haversine, lineLength } from '../src/utils/geo';

const A: LngLat = [-46.70, -23.55];
const B: LngLat = [-46.62, -23.55];
const HOT: LngLat = [-46.66, -23.55]; // foco bem no meio da reta A→B

function modelWithHotspot(): RiskModel {
  const g = new DensityGrid(180);
  // Foco intenso no meio do caminho + fundo fraco espalhado.
  for (let i = 0; i < 200; i++) g.add(destination(HOT, (i * 37) % 360, (i % 7) * 25), 3);
  for (let x = -46.72; x <= -46.6; x += 0.004)
    for (let y = -23.58; y <= -23.52; y += 0.004) g.add([x, y], 0.3);
  const [median, p85] = g.densityPercentiles([0.5, 0.85]);
  return { crime: g, accident: null, light: null, lightRef: 0, night: false, hotspotThreshold: p85, reference: median, accidentFactor: 0.6, sampleStepM: 30 };
}

const route = (id: string, geometry: LngLat[], speed = 1.4): Route => {
  const d = lineLength(geometry);
  return { id, geometry, distanceM: d, durationS: d / speed };
};

test('rota que cruza o foco tem mais exposição que a que contorna', () => {
  const m = modelWithHotspot();
  const direct = scoreRoute(route('d', [A, B]), m);
  const around = scoreRoute(route('a', [A, destination(HOT, 0, 900), B]), m);
  assert.ok(direct.cost > around.cost * 2, `direta ${direct.cost} vs contorno ${around.cost}`);
  assert.ok(direct.hotspots >= 1);
  assert.ok(direct.riskIndex > around.riskIndex);
});

test('findPeaks localiza o foco no meio da rota', () => {
  const m = modelWithHotspot();
  const [peak] = findPeaks(route('d', [A, B]), m, 2);
  assert.ok(peak, 'deveria achar um pico');
  assert.ok(haversine(peak.position, HOT) < 200, `pico a ${haversine(peak.position, HOT)} m do foco`);
});

test('pickRoutes respeita a tolerância de tempo', () => {
  const m = modelWithHotspot();
  const fast = scoreRoute(route('f', [A, B]), m);
  const slowSafe = scoreRoute(route('s', [A, destination(HOT, 0, 3000), B]), m);
  assert.equal(pickRoutes([fast, slowSafe], 0.1).safest.id, 'f', 'desvio longo demais para +10%');
  assert.equal(pickRoutes([fast, slowSafe], 2).safest.id, 's', 'com +200% a segura vence');
});

test('findSafeRoutes gera desvios e escolhe um que evita o foco', async () => {
  const m = modelWithHotspot();
  const calls: LngLat[][] = [];
  // Provedor falso: devolve a reta entre os pontos (passando pelo via, se houver).
  const fake: RoutingProvider = {
    async route(waypoints) {
      calls.push(waypoints);
      return [route(`r${calls.length}`, waypoints)];
    },
  };
  const res = await findSafeRoutes(fake, m, { origin: A, destination: B, mode: 'foot', tolerance: 0.5 });
  assert.ok(calls.length > 1, 'deveria testar desvios');
  assert.notEqual(res.safest.id, res.fastest.id);
  assert.ok(res.safest.cost < res.fastest.cost * 0.6);
  assert.ok(res.safest.durationS <= res.fastest.durationS * 1.5 + 1);
});

test('à noite, rota por rua escura custa mais que por rua iluminada', () => {
  const m = modelWithHotspot();
  const north: LngLat[] = [destination(A, 0, 1500), destination(B, 0, 1500)];
  const south: LngLat[] = [destination(A, 180, 1500), destination(B, 180, 1500)];
  const light = new DensityGrid(60);
  // Só o trajeto norte tem postes.
  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    light.add([north[0][0] + (north[1][0] - north[0][0]) * t, north[0][1]], 3);
  }
  const [ref] = light.densityPercentiles([0.4]);
  const night = { ...m, light, lightRef: ref, night: true };
  const day = { ...m, light, lightRef: ref, night: false };
  const lit = scoreRoute(route('n', north), night);
  const dark = scoreRoute(route('s', south), night);
  assert.ok(dark.darkExposure > lit.darkExposure, 'trecho escuro deve pesar à noite');
  assert.ok(lit.litShare! > 0.8 && dark.litShare! < 0.2);
  assert.equal(scoreRoute(route('s', south), day).darkExposure, 0, 'de dia a iluminação não pesa');
});

test('avoidedSegments aponta o trecho crítico que a rota segura evita', () => {
  const m = modelWithHotspot();
  const fast = route('f', [A, B]);
  const safe = route('s', [A, destination(HOT, 0, 900), B]);
  const segs = avoidedSegments(fast, safe, m);
  assert.ok(segs.length >= 1);
  const covers = segs.some((s) => s.path.some((p) => haversine(p, HOT) < 100));
  assert.ok(covers, 'o foco deve estar dentro de um trecho evitado');
  assert.ok(segs[0].intensity > 1);
  assert.deepEqual(avoidedSegments(fast, fast, m), []);
});
