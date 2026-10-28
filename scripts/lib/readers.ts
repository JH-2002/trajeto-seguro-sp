/**
 * Leitores em streaming: processam planilhas de centenas de MB linha a linha,
 * sem carregar o arquivo inteiro na memória.
 */
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { splitCsvLine } from './common';

export type Row = Record<string, unknown>;

/** Converte valores de célula do ExcelJS (fórmula, rich text, hyperlink) em valor simples. */
export function cellValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || v instanceof Date) return v;
  const o = v as { result?: unknown; richText?: { text: string }[]; text?: unknown; error?: unknown };
  if ('result' in o) return cellValue(o.result);
  if (Array.isArray(o.richText)) return o.richText.map((t) => t.text).join('');
  if ('text' in o) return o.text;
  if ('error' in o) return null;
  return null;
}

function isHeaderRow(values: unknown[]): boolean {
  const texts = values.filter((v) => typeof v === 'string' && v.trim() !== '');
  return texts.length >= 3 && texts.some((t) => /LATITUDE/i.test(String(t)));
}

/**
 * Linhas de todas as abas de um .xlsx. O cabeçalho de cada aba é detectado
 * procurando a linha que contém "LATITUDE" (algumas planilhas têm título antes).
 */
export async function* readXlsxRows(file: string, onSheet?: (name: string) => void): AsyncGenerator<Row> {
  // Carregado sob demanda: só é necessário para .xlsx.
  const { default: ExcelJS } = await import('exceljs');
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, {
    entries: 'emit',
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore',
    worksheets: 'emit',
  });
  let sheetNo = 0;
  for await (const sheet of reader) {
    sheetNo++;
    onSheet?.((sheet as unknown as { name?: string }).name ?? `aba ${sheetNo}`);
    let headers: string[] | null = null;
    let scanned = 0;
    for await (const row of sheet) {
      const values = (row.values as unknown[]).slice(1).map(cellValue);
      if (!headers) {
        if (isHeaderRow(values)) headers = values.map((v, i) => String(v ?? `COL_${i + 1}`).trim());
        else if (++scanned > 20) break; // aba sem tabela de ocorrências
        continue;
      }
      const rec: Row = {};
      for (let i = 0; i < headers.length; i++) rec[headers[i]] = values[i] ?? null;
      yield rec;
    }
  }
}

export function detectEncoding(file: string): BufferEncoding {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(65536);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const nl = buf.lastIndexOf(10, n);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, nl > 0 ? nl : n));
    return 'utf8';
  } catch {
    return 'latin1';
  }
}

/** Linhas de um CSV (separador ; ou , detectado no cabeçalho; UTF-8 ou Latin-1). */
export async function* readCsvRows(file: string): AsyncGenerator<Row> {
  const encoding = detectEncoding(file);
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding }), crlfDelay: Infinity });
  let headers: string[] | null = null;
  let sep = ';';
  for await (const raw of rl) {
    const line = raw.replace(/^﻿/, '');
    if (!line.trim()) continue;
    if (!headers) {
      sep = (line.match(/;/g)?.length ?? 0) >= (line.match(/,/g)?.length ?? 0) ? ';' : ',';
      headers = splitCsvLine(line, sep).map((h) => h.trim());
      continue;
    }
    const f = splitCsvLine(line, sep);
    const rec: Row = {};
    for (let i = 0; i < headers.length; i++) rec[headers[i]] = f[i] ?? null;
    yield rec;
  }
}

export function readRows(file: string, onSheet?: (name: string) => void): AsyncGenerator<Row> {
  return /\.xlsx$/i.test(file) ? readXlsxRows(file, onSheet) : readCsvRows(file);
}
