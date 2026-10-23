/**
 * Builds the in-memory universe hierarchy (star → planets/comets → moons)
 * from the JSON resource files under `resources/`.
 */
import fs from 'node:fs';
import path from 'node:path';

export const TEXTURE_FIELDS = Object.freeze(['map', 'bumpMap', 'specMap', 'cloudMap', 'alphaMap']);

/** Reference values used to derive a sane spin for tidally-locked moons. */
const MOON_REFERENCE_SPIN = 0.036;
const MOON_REFERENCE_PERIOD = 27.3;

/** Default semi-major axis (scene "moon units") for moons without one. */
export const DEFAULT_MOON_SEMI_MAJOR_AXIS = 2.0;

const silentLogger = { info() { }, warn() { }, log() { }, error() { } };

export const stripBOM = (str) => (str.charCodeAt(0) === 0xfeff ? str.slice(1) : str);

export function readJSON(filename) {
  return JSON.parse(stripBOM(fs.readFileSync(filename, 'utf8')));
}

/** Last path segment for either `/` or `\` separated paths. */
export function basenameFromPath(pathStr) {
  return String(pathStr ?? '').split(/[\\/]/).pop() ?? '';
}

/** Read every `*.json` file in a directory into `{ [filename]: data }`, skipping malformed files. */
export function readJsonFilesSync(dirPath, logger = silentLogger) {
  const result = {};
  if (!fs.existsSync(dirPath)) return result;
  for (const entry of fs.readdirSync(dirPath).sort()) {
    if (path.extname(entry).toLowerCase() !== '.json') continue;
    const fullPath = path.join(dirPath, entry);
    try {
      if (!fs.statSync(fullPath).isFile()) continue;
      result[entry] = readJSON(fullPath);
    } catch (err) {
      logger.warn(`[universe] Skipping malformed JSON ${fullPath}: ${err.message}`);
    }
  }
  return result;
}

const clone = (value) => structuredClone(value);

/**
 * Parse the compact moon CSV format used by some planet files:
 * `name,map,diameter,atmosphere,wSeg,hSeg,mass,pow,color,period,tilt,spin,ecc,inc,sma;...`
 */
export function parseMoonCsv(csv) {
  return String(csv)
    .split(';')
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => {
      const col = row.split(',').map((c) => c.trim());
      return {
        name: col[0],
        type: 'moon',
        map: col[1] ?? '',
        diameter: parseFloat(col[2]),
        atmosphere: parseFloat(col[3]),
        widthSegments: parseInt(col[4], 10),
        heightSegments: parseInt(col[5], 10),
        mass: parseFloat(col[6]),
        pow: parseInt(col[7], 10),
        color: col[8],
        period: parseFloat(col[9]),
        tilt: parseFloat(col[10]),
        spin: parseFloat(col[11]),
        eccentricity: parseFloat(col[12]),
        inclination: parseFloat(col[13]),
        semiMajorAxis: parseFloat(col[14]),
      };
    });
}

/**
 * Spin is applied per rendered frame (radians). Several data files copied the
 * orbital period into `spin`, which makes moons spin wildly; derive a
 * tidally-locked rate from the period instead.
 */
export const MAX_DERIVED_SPIN = 0.5;

export function sanitizeSpin(spin, period) {
  if (Number.isFinite(spin) && Math.abs(spin) < 1) return spin;
  if (period > 0) return Math.min(MAX_DERIVED_SPIN, (MOON_REFERENCE_SPIN * MOON_REFERENCE_PERIOD) / period);
  return MOON_REFERENCE_SPIN;
}

export function createUniverseBuilder({ resourcesRoot, logger = silentLogger } = {}) {
  if (!resourcesRoot) throw new Error('createUniverseBuilder: resourcesRoot is required');
  const imagesRoot = path.join(resourcesRoot, 'images');

  const logAdded = (type, name, meta) => {
    logger.info(`[universe][ADD] ${type.padEnd(7)} • ${name}${meta ? ` (${meta})` : ''}`);
  };

  function textureExists(texturePath) {
    if (typeof texturePath !== 'string' || !texturePath.trim()) return false;
    const rel = texturePath.replace(/^\/?images\//, '');
    const resolved = path.resolve(imagesRoot, rel);
    if (!resolved.startsWith(path.resolve(imagesRoot))) return false; // no path traversal
    return fs.existsSync(resolved);
  }

  function resourceExists(resourcePath) {
    if (typeof resourcePath !== 'string' || !resourcePath) return false;
    return fs.existsSync(path.join(resourcesRoot, resourcePath.replace(/^\//, '')));
  }

  function scrubTextures(body) {
    for (const field of TEXTURE_FIELDS) {
      if (body[field] && !textureExists(body[field])) body[field] = '';
    }
    return body;
  }

  function normalizeRing(ring, ownerName) {
    const r = clone(ring);
    if (r.texture && !textureExists(r.texture)) r.texture = '';
    r.inner = Number(r.inner ?? 0);
    r.outer = Number(r.outer ?? 0);
    r.thickness = Number(r.thickness ?? 0.01);
    logAdded('Ring', r.name ?? '(unnamed)', `owner=${ownerName}`);
    return r;
  }

  function normalizeRings(rings, ownerName) {
    return Array.isArray(rings) ? rings.filter((r) => r && typeof r === 'object').map((r) => normalizeRing(r, ownerName)) : [];
  }

  function buildMoons(planet, moonMap) {
    let entries;
    if (typeof planet.moons === 'string') entries = parseMoonCsv(planet.moons);
    else if (Array.isArray(planet.moons)) entries = planet.moons;
    else return [];

    const seen = new Set();
    const moons = [];
    for (const entry of entries) {
      let moon;
      if (typeof entry === 'string') {
        const key = basenameFromPath(entry);
        const data = moonMap[key];
        if (!data) { logger.warn(`[universe] Missing moon: ${key}`); continue; }
        moon = clone(data);
        moon.resource = `/moons/${key}`;
      } else if (entry && typeof entry === 'object') {
        moon = clone(entry);
      } else {
        logger.warn(`[universe] Invalid moon entry for planet "${planet.name}"`);
        continue;
      }

      if (!moon.name) { logger.warn(`[universe] Unnamed moon skipped for planet "${planet.name}"`); continue; }
      if (seen.has(moon.name)) { logger.warn(`[universe] Duplicate moon "${moon.name}" skipped for planet "${planet.name}"`); continue; }
      seen.add(moon.name);

      moon.type = 'moon';
      scrubTextures(moon);
      moon.spin = sanitizeSpin(moon.spin, moon.period);
      moon.semiMajorAxis = Number.isFinite(moon.semiMajorAxis) && moon.semiMajorAxis > 0
        ? moon.semiMajorAxis
        : DEFAULT_MOON_SEMI_MAJOR_AXIS;
      moon.x = moon.semiMajorAxis;
      logAdded('Moon', moon.name, `planet=${planet.name}`);
      moons.push(moon);
    }
    return moons;
  }

  function buildPlanet(planetPath, planetMap, moonMap, starName) {
    const key = basenameFromPath(planetPath);
    const data = planetMap[key];
    if (!data) { logger.warn(`[universe] Missing planet: ${key}`); return null; }
    const planet = scrubTextures(clone(data));
    planet.type = planet.type || 'planet';
    planet.resource = `/planets/${key}`;
    planet.moons = buildMoons(planet, moonMap);
    planet.rings = normalizeRings(planet.rings, planet.name);
    logAdded('Planet', planet.name, `star=${starName}`);
    return planet;
  }

  /**
   * @param {Record<string, any>} starMap    `{ 'sun.json': {...} }`
   * @param {Record<string, any>} planetMap  `{ 'earth.json': {...} }`
   * @param {Record<string, any>} moonMap    `{ 'moon.json': {...} }`
   */
  function buildUniverseHierarchy(starMap, planetMap, moonMap) {
    const stars = [];
    for (const [starFile, starData] of Object.entries(starMap)) {
      const star = scrubTextures(clone(starData));
      star.type = 'star';
      star.resource = `/stars/${starFile}`;
      if (!resourceExists(star.resource)) logger.warn(`[universe] Missing star resource: ${star.resource}`);

      star.planets = Array.isArray(star.planets)
        ? star.planets.map((p) => buildPlanet(p, planetMap, moonMap, star.name)).filter(Boolean)
        : [];
      star.rings = normalizeRings(star.rings, star.name);
      star.comets = Array.isArray(star.comets)
        ? star.comets.filter((c) => c && typeof c === 'object').map((c) => {
          const comet = scrubTextures(clone(c));
          comet.type = 'comet';
          logAdded('Comet', comet.name ?? '(unnamed)', `owner=${star.name}`);
          return comet;
        })
        : [];

      logAdded('Star', star.name);
      stars.push(star);
    }
    return { stars };
  }

  function buildFromResources() {
    return buildUniverseHierarchy(
      readJsonFilesSync(path.join(resourcesRoot, 'stars'), logger),
      readJsonFilesSync(path.join(resourcesRoot, 'planets'), logger),
      readJsonFilesSync(path.join(resourcesRoot, 'moons'), logger),
    );
  }

  return { textureExists, resourceExists, buildUniverseHierarchy, buildFromResources };
}

/** Flatten a star into the body list sent to clients: star first, then planets, then comets. */
export function listBodies(star) {
  if (!star) return [];
  return [star, ...(star.planets ?? []), ...(star.comets ?? [])];
}
