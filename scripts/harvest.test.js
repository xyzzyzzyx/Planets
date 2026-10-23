import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanText,
  extractBalancedTable,
  extractImageUrls,
  FIGURES,
  harvestFigure,
  parseInfobox,
  politeFetch,
  safeFilename,
  USER_AGENT,
} from './harvest.js';

const PAGE = `
<html><body>
<table class="infobox biography vcard">
  <tr><td><img src="//upload.wikimedia.org/a/Euclid.jpg"></td></tr>
  <tr><th>Born</th><td>c. 325 BC<sup class="reference">[1]</sup><br>Alexandria</td></tr>
  <tr><th>Known&nbsp;for</th><td><ul><li>Elements</li><li>Euclid&amp;s algorithm</li></ul></td></tr>
  <tr><th>Nested</th><td><table><tr><td>inner</td></tr></table></td></tr>
  <tr><th>Known&nbsp;for</th><td>Geometry</td></tr>
  <tr><th>Empty</th><td></td></tr>
</table>
<p>Text</p>
<img src="/static/logo.png"><img src="data:image/png;base64,xx"><img src="#"><img src="https://x.org/b%20c.png">
<img src="//upload.wikimedia.org/a/Euclid.jpg">
</body></html>`;

describe('cleanText', () => {
  it('strips tags, citations and entities and collapses whitespace', () => {
    expect(cleanText('a<sup>[1]\n</sup> <b>b</b>&nbsp;&amp;&lt;c&gt; [23]  d')).toBe('a b &<c> d');
    expect(cleanText('<ul><li>x</li><li>y</li></ul>')).toBe('• x • y');
    expect(cleanText('<style>.a{}</style>ok')).toBe('ok');
  });
});

describe('extractBalancedTable', () => {
  it('includes nested tables', () => {
    const html = '<table id="o"><tr><td><table><tr><td>in</td></tr></table></td></tr></table><table>next</table>';
    expect(extractBalancedTable(html, 0)).toBe('<tr><td><table><tr><td>in</td></tr></table></td></tr>');
  });

  it('copes with unterminated markup', () => {
    expect(extractBalancedTable('<table><tr>', 0)).toBe('<tr>');
    expect(extractBalancedTable('<table', 0)).toBe('');
  });
});

describe('parseInfobox', () => {
  it('extracts key/value rows, merging duplicate keys', () => {
    const { data, found } = parseInfobox(PAGE);
    expect(found).toBe(true);
    expect(data.image_url).toBe('https://upload.wikimedia.org/a/Euclid.jpg');
    expect(data.Born).toBe('c. 325 BC Alexandria');
    expect(data['Known for']).toEqual(['• Elements • Euclid&s algorithm', 'Geometry']);
    expect(data).not.toHaveProperty('Empty');
  });

  it('reports pages without an infobox', () => {
    expect(parseInfobox('<p>none</p>')).toEqual({ data: {}, found: false });
  });
});

describe('extractImageUrls', () => {
  it('resolves relative and protocol-relative URLs and de-duplicates', () => {
    expect(extractImageUrls(PAGE, 'https://en.wikipedia.org/wiki/Euclid')).toEqual([
      'https://upload.wikimedia.org/a/Euclid.jpg',
      'https://en.wikipedia.org/static/logo.png',
      'https://x.org/b%20c.png',
    ]);
  });
});

describe('safeFilename', () => {
  it.each([
    ['https://x.org/a/b%20c.png', 0, 'b c.png'],
    ['https://x.org/a/what%3F.png', 0, 'what_.png'],
    ['https://x.org/', 4, 'image_5.jpg'],
    ['not a url', 1, 'image_2.jpg'],
    ['https://x.org/..hidden', 0, 'hidden'],
  ])('%s → %s', (url, i, expected) => {
    expect(safeFilename(url, i)).toBe(expected);
  });
});

const response = (status, body = '', headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
});

describe('politeFetch', () => {
  it('sends a User-Agent', async () => {
    const fetchImpl = vi.fn(async () => response(200, 'ok'));
    await politeFetch('https://x', { fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers['User-Agent']).toBe(USER_AGENT);
  });

  it('retries 429/5xx with back-off then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(429, '', { 'retry-after': '0' }))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200, 'ok'));
    const res = await politeFetch('https://x', { fetchImpl, baseDelayMs: 1 });
    expect(await res.text()).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('gives up after the retry budget and does not retry 404', async () => {
    const always429 = vi.fn(async () => response(429));
    await expect(politeFetch('https://x', { fetchImpl: always429, retries: 2, baseDelayMs: 1 })).rejects.toThrow('HTTP 429');
    expect(always429).toHaveBeenCalledTimes(3);
    const notFound = vi.fn(async () => response(404));
    await expect(politeFetch('https://x', { fetchImpl: notFound, baseDelayMs: 1 })).rejects.toThrow('HTTP 404');
    expect(notFound).toHaveBeenCalledOnce();
  });
});

describe('harvestFigure', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planets-harvest-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes metadata and images, skipping files that already exist', async () => {
    const fetchImpl = vi.fn(async (url) => (url.includes('/wiki/') ? response(200, PAGE) : url.includes('logo') ? response(500) : response(200, 'IMG')));
    const log = vi.fn();
    fs.mkdirSync(path.join(dir, 'Euclid'));
    fs.writeFileSync(path.join(dir, 'Euclid', 'b c.png'), 'existing');

    const meta = await harvestFigure('Euclid', { outDir: dir, delayMs: 0, retryDelayMs: 0, fetchImpl, log });

    expect(meta.source).toBe('https://en.wikipedia.org/wiki/Euclid');
    expect(meta.Born).toBe('c. 325 BC Alexandria');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'Euclid', 'metadata.json'), 'utf8'));
    expect(saved.Born).toBe(meta.Born);
    expect(fs.readFileSync(path.join(dir, 'Euclid', 'Euclid.jpg'), 'utf8')).toBe('IMG');
    expect(fs.readFileSync(path.join(dir, 'Euclid', 'b c.png'), 'utf8')).toBe('existing');
    expect(fetchImpl.mock.calls.some(([u]) => u.includes('b%20c'))).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('logo.png'));
    expect(fetchImpl.mock.calls.filter(([u]) => u.includes('logo')).length).toBe(4); // 1 try + 3 retries
  });

  it('ships a list of unique article names', () => {
    expect(new Set(FIGURES).size).toBe(FIGURES.length);
  });
});
