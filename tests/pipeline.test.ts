import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorize, findColumn, parseCoord, parseDate, parseHour, periodStartHour, splitCsvLine } from '../scripts/lib/common';

test('parseCoord aceita vírgula decimal e números sem ponto', () => {
  assert.equal(parseCoord('-23,5505'), -23.5505);
  assert.equal(parseCoord(-46.6333), -46.6333);
  assert.ok(Math.abs(parseCoord('-235505000')! + 23.5505) < 1e-9);
  assert.equal(parseCoord('0'), null);
  assert.equal(parseCoord(''), null);
});

test('parseHour entende texto, fração do Excel e Date', () => {
  assert.equal(parseHour('21:45:00'), 21);
  assert.equal(parseHour(0.5), 12);
  assert.equal(parseHour(new Date(2025, 0, 1, 3, 10)), 3);
  assert.equal(parseHour('sem info'), null);
});

test('parseDate normaliza formatos comuns', () => {
  assert.equal(parseDate('05/03/2025'), '2025-03-05');
  assert.equal(parseDate('2025-03-05T10:00:00'), '2025-03-05');
  assert.equal(parseDate(45721), '2025-03-05');
});

test('categorize agrupa naturezas da SSP', () => {
  assert.equal(categorize('Roubo (art. 157) - CELULAR'), 'roubo');
  assert.equal(categorize('LATROCÍNIO'), 'violento');
  assert.equal(categorize('Furto de veículo'), 'furto');
  assert.equal(categorize('Lesão corporal dolosa'), 'violento');
  assert.equal(categorize('Ameaça'), 'outros');
});

test('findColumn ignora acentos e caixa', () => {
  assert.equal(findColumn(['Latitude', 'Natureza Apurada'], ['NATUREZA_APURADA']), 'Natureza Apurada');
});

test('splitCsvLine respeita aspas', () => {
  assert.deepEqual(splitCsvLine('a;"b;c";"d ""e"""', ';'), ['a', 'b;c', 'd "e"']);
});

test('formato real da SSP: "NULL", hora em fração de dia e período por extenso', () => {
  assert.equal(parseCoord('NULL'), null);
  assert.equal(parseHour('NULL'), null);
  assert.equal(parseHour(0.9965277777777778), 23);
  assert.equal(parseDate(45288), '2023-12-28');
  assert.equal(periodStartHour('De madrugada'), 0);
  assert.equal(periodStartHour('Pela manhã'), 6);
  assert.equal(periodStartHour('À tarde'), 12);
  assert.equal(periodStartHour('À noite'), 18);
  assert.equal(periodStartHour('Em hora incerta'), null);
  assert.equal(categorize('ESTUPRO DE VULNERÁVEL'), 'violento');
  assert.equal(categorize('FURTO - OUTROS'), 'furto');
});
