#!/usr/bin/env node
/**
 * Harvest infobox metadata and images for historical scientists from
 * Wikipedia into `dist/harvest/<Article>/`.
 *
 * Previously this ran automatically (and broke) on every server start; it is
 * now an explicit, polite, rate-limited CLI:
 *
 *   npm run harvest                 # all figures
 *   npm run harvest -- Euclid Hypatia
 *
 * Options (env): HARVEST_DIR, HARVEST_DELAY_MS (default 1000), HARVEST_MAX_IMAGES (default 25)
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FIGURES = Object.freeze([
  'Thales_of_Miletus', 'Oenopides', 'Pythagoras', 'Hippocrates_of_Chios', 'Aristotle', 'Euclid', 'Archimedes',
  'Apollonius_of_Perga', 'Ptolemy', 'Hypatia', 'Alhazen', 'Omar_Khayyam', 'Fibonacci', 'Nicolaus_Copernicus',
  'Tycho_Brahe', 'John_Napier', 'Galileo_Galilei', 'Johannes_Kepler', 'René_Descartes', 'Pierre_de_Fermat',
  'Blaise_Pascal', 'Christiaan_Huygens', 'Robert_Hooke', 'Isaac_Newton', 'Gottfried_Wilhelm_Leibniz',
  'Jacob_Bernoulli', 'Daniel_Bernoulli', 'Benjamin_Franklin', 'Leonhard_Euler', 'Joseph-Louis_Lagrange',
  'Alessandro_Volta', 'Pierre-Simon_Laplace', 'Joseph_Fourier', 'André-Marie_Ampère', 'Carl_Friedrich_Gauss',
  'Augustin-Louis_Cauchy', 'Georg_Ohm', 'Michael_Faraday', 'Niels_Henrik_Abel', 'Carl_Gustav_Jacob_Jacobi',
  'William_Rowan_Hamilton', 'Évariste_Galois', 'Ada_Lovelace', 'George_Boole', 'Bernhard_Riemann',
  'James_Clerk_Maxwell', 'Josiah_Willard_Gibbs', 'Ludwig_Boltzmann', 'Georg_Cantor', 'Hendrik_Lorentz',
  'Henri_Poincaré', 'Nikola_Tesla', 'Heinrich_Hertz', 'Max_Planck', 'David_Hilbert', 'Marie_Curie',
  'Ernest_Rutherford', 'Albert_Einstein', 'Emmy_Noether', 'Niels_Bohr', 'Srinivasa_Ramanujan',
  'Erwin_Schrödinger', 'Werner_Heisenberg', 'Enrico_Fermi', 'Paul_Dirac', 'John_von_Neumann', 'Alan_Turing',
  'Richard_Feynman', 'Stephen_Hawking', 'Murray_Gell-Mann', 'Roger_Penrose', 'Chaos_theory',
]);

/** Wikimedia requires an identifying User-Agent; anonymous requests get 403/429. */
export const USER_AGENT = 'PlanetsHarvester/2.0 (https://github.com/xyzzyzzyx/Planets)';

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** Convert an HTML fragment to readable plain text. */
export function cleanText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[\d+\]/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Return the inner HTML of the `<table>` opening at `start`, honouring nested tables. */
export function extractBalancedTable(html, start) {
  const open = html.indexOf('>', start);
  if (open < 0) return '';
  const tag = /<(\/?)table\b/gi;
  tag.lastIndex = open;
  let depth = 1;
  let m;
  while ((m = tag.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open + 1, m.index);
  }
  return html.slice(open + 1);
}

/** Find the biography infobox and convert its rows into a key → value object. */
export function parseInfobox(html) {
  const data = {};
  const startMatch = /<table[^>]*class="[^"]*\binfobox\b[^"]*"[^>]*>/i.exec(html);
  if (!startMatch) return { data, found: false };
  const infobox = extractBalancedTable(html, startMatch.index);

  const img = /<img[^>]+src=["']([^"']+)["']/i.exec(infobox);
  if (img) data.image_url = img[1].startsWith('//') ? `https:${img[1]}` : img[1];

  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let row;
  while ((row = rowRegex.exec(infobox))) {
    const th = /<th\b[^>]*>([\s\S]*?)<\/th>/i.exec(row[1]);
    const td = /<td\b[^>]*>([\s\S]*?)<\/td>/i.exec(row[1]);
    if (!th || !td) continue;
    const key = cleanText(th[1]);
    const val = cleanText(td[1]);
    if (!key || !val) continue;
    if (key in data) data[key] = [].concat(data[key], val);
    else data[key] = val;
  }
  return { data, found: true };
}

/** All unique absolute image URLs on a page. */
export function extractImageUrls(html, pageUrl) {
  const urls = new Set();
  const imgRegex = /<img\b[^>]*?\bsrc=["']([^"']+)["']/gi;
  let m;
  while ((m = imgRegex.exec(html))) {
    const src = m[1].trim();
    if (!src || src === '#' || src.startsWith('data:') || src.startsWith('blob:')) continue;
    try {
      urls.add(new URL(src.startsWith('//') ? `https:${src}` : src, pageUrl).href);
    } catch { /* skip unparsable */ }
  }
  return [...urls];
}

/** Filesystem-safe file name for an image URL. */
export function safeFilename(url, index) {
  let name = '';
  try { name = decodeURIComponent(path.posix.basename(new URL(url).pathname)); } catch { /* ignore */ }
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').replace(/^\.+/, '');
  return name || `image_${index + 1}.jpg`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch with User-Agent and exponential back-off on 429/5xx (honours Retry-After). */
export async function politeFetch(url, { fetchImpl = fetch, retries = 3, baseDelayMs = 2000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT } });
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt);
  }
}

async function exists(file) {
  try { await fsp.access(file); return true; } catch { return false; }
}

/**
 * Harvest one Wikipedia article: parse its infobox into `metadata.json` and
 * download up to `maxImages` images, skipping files that already exist.
 * `retryDelayMs` is the base back-off for retryable HTTP errors.
 */
export async function harvestFigure(name, { outDir, delayMs = 1000, maxImages = 25, retryDelayMs = 2000, fetchImpl = fetch, log = console.log } = {}) {
  const pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}`;
  log(`🔥 ${name.replace(/_/g, ' ')}`);
  const html = await (await politeFetch(pageUrl, { fetchImpl, baseDelayMs: retryDelayMs })).text();
  const { data, found } = parseInfobox(html);
  if (!found) log('   ⚠️  No infobox found (still harvesting images)');

  const dir = path.join(outDir, name);
  await fsp.mkdir(dir, { recursive: true });

  const images = extractImageUrls(html, pageUrl).slice(0, maxImages);
  let downloaded = 0;
  for (const [i, src] of images.entries()) {
    const file = path.join(dir, safeFilename(src, i));
    if (await exists(file)) continue;
    try {
      const res = await politeFetch(src, { fetchImpl, baseDelayMs: retryDelayMs });
      await fsp.writeFile(file, Buffer.from(await res.arrayBuffer()));
      downloaded++;
    } catch (err) {
      log(`   ❌ ${path.basename(file)}: ${err.message}`);
    }
    await sleep(delayMs);
  }

  const metadata = { source: pageUrl, harvestedAt: new Date().toISOString(), ...data };
  await fsp.writeFile(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2));
  log(`   ✅ ${Object.keys(data).length} fields, ${downloaded}/${images.length} new images`);
  return metadata;
}

export async function main(argv = process.argv.slice(2)) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const outDir = process.env.HARVEST_DIR ?? path.join(root, 'dist', 'harvest');
  const delayMs = Number(process.env.HARVEST_DELAY_MS ?? 1000);
  const maxImages = Number(process.env.HARVEST_MAX_IMAGES ?? 25);
  const names = argv.length ? argv : FIGURES;

  console.log(`📋 Harvesting ${names.length} figures into ${outDir}\n`);
  let failures = 0;
  for (const name of names) {
    try {
      await harvestFigure(name, { outDir, delayMs, maxImages });
    } catch (err) {
      failures++;
      console.error(`   ❌ ${name}: ${err.message}`);
    }
    await sleep(delayMs);
  }
  console.log(`\nDone — ${names.length - failures} succeeded, ${failures} failed.`);
  return failures === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}
