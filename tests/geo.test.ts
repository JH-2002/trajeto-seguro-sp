import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bearing, destination, haversine, lineLength, overlapRatio, sampleLine } from '../src/utils/geo';
import type { LngLat } from '../src/types';

const SE: LngLat = [-46.6339, -23.5503]; // Praça da Sé
const PAULISTA: LngLat = [-46.6558, -23.5614]; // MASP

test('haversine aproxima a distância Sé–MASP (~2,5 km)', () => {
  const d = haversine(SE, PAULISTA);
  assert.ok(d > 2300 && d < 2700, `obtido ${d}`);
});

test('destination e bearing são inversos', () => {
  const p = destination(SE, 75, 1000);
  assert.ok(Math.abs(haversine(SE, p) - 1000) < 1);
  assert.ok(Math.abs(bearing(SE, p) - 75) < 0.5);
});

test('sampleLine cobre o trajeto inteiro com amostras equidistantes', () => {
  const line: LngLat[] = [SE, [-46.64, -23.555], PAULISTA];
  const samples = sampleLine(line, 50);
  const covered = samples.reduce((s, x) => s + x.lengthM, 0);
  assert.ok(Math.abs(covered - lineLength(line)) < 1, 'soma dos trechos = comprimento');
  assert.deepEqual(samples[0].position, SE);
  assert.ok(haversine(samples[samples.length - 1].position, PAULISTA) < 1);
});

test('overlapRatio: igual = 1, rotas distantes = 0', () => {
  const a: LngLat[] = [SE, PAULISTA];
  const far: LngLat[] = [destination(SE, 0, 2000), destination(PAULISTA, 0, 2000)];
  assert.equal(overlapRatio(a, a), 1);
  assert.equal(overlapRatio(a, far), 0);
});
