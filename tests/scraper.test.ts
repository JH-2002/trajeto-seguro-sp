import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  discover,
  download,
  extractFromBundle,
  extractHtmlLinks,
  extractScriptUrls,
  needsDownload,
  patternNames,
  probe,
  yearOf,
} from '../scripts/lib/sspScraper';

// ---------- parsing ----------

test('extrai scripts e links de planilha do HTML', () => {
  const html = `<html><script src="main.4f2a.js"></script><script src="https://cdn.x.com/lib.js"></script>
    <a href="/assets/estatistica/a/SPDadosCriminais_2023.xlsx">2023</a><a href="/sobre">x</a></html>`;
  const page = 'https://www.ssp.sp.gov.br/estatistica/consultas';
  assert.deepEqual(extractScriptUrls(html, page), ['https://www.ssp.sp.gov.br/estatistica/main.4f2a.js']);
  assert.deepEqual(extractHtmlLinks(html, page), ['https://www.ssp.sp.gov.br/assets/estatistica/a/SPDadosCriminais_2023.xlsx']);
});

test('extrai arquivos e pastas de dados do bundle Angular', () => {
  const js = `const a="assets/estatistica/transparencia/spDados/",b='./assets/estatistica/transparencia/spDados/SPDadosCriminais_2024.xlsx';
    url:"assets/img/logo.png",x=\`assets/estatistica/transparencia/celulares/CelularesSubtraidos_2024.xlsx\``;
  const r = extractFromBundle(js, 'https://www.ssp.sp.gov.br');
  assert.ok(r.dirs.includes('https://www.ssp.sp.gov.br/assets/estatistica/transparencia/spDados/'));
  assert.ok(r.files.includes('https://www.ssp.sp.gov.br/assets/estatistica/transparencia/spDados/SPDadosCriminais_2024.xlsx'));
  assert.equal(r.files.length, 2);
});

test('padrões de nome e ano', () => {
  assert.equal(patternNames(2025)[0], 'SPDadosCriminais_2025.xlsx');
  assert.equal(yearOf('https://x/SPDadosCriminais_2024_2.xlsx'), 2024);
});

test('needsDownload compara ETag, Last-Modified e tamanho', () => {
  const local = { url: 'u', file: 'f', etag: '"a"', size: 10, downloadedAt: '' };
  assert.equal(needsDownload({ url: 'u', ok: true, status: 200, etag: '"a"' }, local, true), false);
  assert.equal(needsDownload({ url: 'u', ok: true, status: 200, etag: '"b"' }, local, true), true);
  assert.equal(needsDownload({ url: 'u', ok: true, status: 200, etag: '"a"' }, local, false), true);
  assert.equal(needsDownload({ url: 'u', ok: true, status: 200, size: 11 }, { ...local, etag: undefined }, true), true);
});

// ---------- servidor que imita o portal da SSP (SPA Angular) ----------

const XLSX_BODY = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(8000, 7)]);
const BIG_BODY = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.from(Array.from({ length: 1_000_000 }, (_, i) => i % 251))]);
const flakyRanges: number[] = [];
let flakyFull = 0;
let server: http.Server;
let base = '';
let headAllowed = true;

before(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/main.abc123.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      return res.end('var p="assets/estatistica/transparencia/spDados/";function f(a){return p+"SPDadosCriminais_"+a+".xlsx"}');
    }
    if (url === '/flaky.xlsx') {
      // Imita a SSP: na 1ª tentativa derruba a conexão no meio do arquivo; aceita Range.
      const big = BIG_BODY;
      const range = req.headers.range?.match(/bytes=(\d+)-/);
      const ifRange = req.headers['if-range'];
      if (range && ifRange === '"big1"') {
        const start = Number(range[1]);
        flakyRanges.push(start);
        res.writeHead(206, { 'content-type': 'application/octet-stream', etag: '"big1"', 'content-range': `bytes ${start}-${big.length - 1}/${big.length}`, 'content-length': big.length - start });
        return res.end(big.subarray(start));
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', etag: '"big1"', 'content-length': big.length, 'accept-ranges': 'bytes' });
      if (req.method === 'HEAD') return res.end();
      flakyFull++;
      res.write(big.subarray(0, 300_000));
      return setTimeout(() => req.socket.destroy(), 20);
    }
    if (url === '/assets/estatistica/transparencia/spDados/SPDadosCriminais_2025.xlsx') {
      if (req.method === 'HEAD' && !headAllowed) {
        res.writeHead(405);
        return res.end();
      }
      const headers: Record<string, string | number> = {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        etag: '"v1"',
        'last-modified': 'Mon, 05 Oct 2026 10:00:00 GMT',
      };
      if (req.headers.range) {
        res.writeHead(206, { ...headers, 'content-range': `bytes 0-3/${XLSX_BODY.length}`, 'content-length': 4 });
        return res.end(XLSX_BODY.subarray(0, 4));
      }
      res.writeHead(200, { ...headers, 'content-length': XLSX_BODY.length });
      return res.end(req.method === 'HEAD' ? undefined : XLSX_BODY);
    }
    // Fallback de SPA: qualquer outro caminho devolve o index.html com 200.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><app-root></app-root><script src="/main.abc123.js"></script></body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

test('descobre a pasta de dados lendo o bundle JS da página', async () => {
  const { dirs } = await discover(`${base}/estatistica/consultas`);
  assert.deepEqual(dirs, [`${base}/assets/estatistica/transparencia/spDados/`]);
});

test('probe aceita a planilha e rejeita o fallback HTML da SPA', async () => {
  const ok = await probe(`${base}/assets/estatistica/transparencia/spDados/SPDadosCriminais_2025.xlsx`);
  assert.equal(ok.ok, true);
  assert.equal(ok.size, XLSX_BODY.length);
  assert.equal(ok.etag, '"v1"');
  const fake = await probe(`${base}/assets/estatistica/transparencia/spDados/SPDadosCriminais_2024.xlsx`);
  assert.equal(fake.ok, false);
  assert.match(fake.reason!, /HTML/);
});

test('probe usa GET com Range quando o servidor recusa HEAD', async () => {
  headAllowed = false;
  try {
    const info = await probe(`${base}/assets/estatistica/transparencia/spDados/SPDadosCriminais_2025.xlsx`);
    assert.equal(info.ok, true);
    assert.equal(info.size, XLSX_BODY.length);
  } finally {
    headAllowed = true;
  }
});

test('download grava o arquivo completo e valida a assinatura', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-'));
  const url = `${base}/assets/estatistica/transparencia/spDados/SPDadosCriminais_2025.xlsx`;
  const dest = path.join(dir, 'SPDadosCriminais_2025.xlsx');
  const bytes = await download(await probe(url), dest);
  assert.equal(bytes, XLSX_BODY.length);
  assert.ok(fs.readFileSync(dest).equals(XLSX_BODY));
  assert.equal(fs.existsSync(`${dest}.part`), false);

  // Uma página HTML salva como .xlsx é recusada e não deixa lixo.
  const bad = path.join(dir, 'falso.xlsx');
  await assert.rejects(download({ url: `${base}/qualquer.xlsx`, ok: true, status: 200 }, bad), /não é uma planilha/);
  assert.equal(fs.existsSync(bad), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('download retoma de onde parou quando a conexão cai no meio', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-'));
  const dest = path.join(dir, 'SPDadosCriminais_2025.xlsx');
  const info = await probe(`${base}/flaky.xlsx`);
  assert.equal(info.etag, '"big1"');
  const logs: string[] = [];
  const bytes = await download(info, dest, { log: (m) => logs.push(m), maxResumes: 3 });
  assert.equal(bytes, BIG_BODY.length);
  assert.ok(fs.readFileSync(dest).equals(BIG_BODY), 'arquivo final íntegro');
  assert.equal(flakyFull, 1, 'só uma requisição completa');
  assert.ok(flakyRanges.length >= 1 && flakyRanges[0] > 0, 'continuou com Range a partir do que já tinha');
  assert.ok(logs.some((l) => l.includes('retomando')));
  fs.rmSync(dir, { recursive: true, force: true });
});
