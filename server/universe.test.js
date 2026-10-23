import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  basenameFromPath,
  createUniverseBuilder,
  DEFAULT_MOON_SEMI_MAJOR_AXIS,
  listBodies,
  parseMoonCsv,
  readJsonFilesSync,
  sanitizeSpin,
  stripBOM,
} from './universe.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeResources() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planets-universe-'));
  for (const sub of ['stars', 'planets', 'moons', 'images/planets']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.writeFileSync(path.join(dir, 'images/planets/real.png'), '');
  return dir;
}
const writeJson = (dir, rel, data, bom = false) => fs.writeFileSync(path.join(dir, rel), (bom ? '\uFEFF' : '') + JSON.stringify(data));
const logger = () => ({ info: vi.fn(), warn: vi.fn(), log: vi.fn(), error: vi.fn() });

describe('helpers', () => {
  it('stripBOM removes a leading byte-order mark only', () => {
    expect(stripBOM('\uFEFF{"a":1}')).toBe('{"a":1}');
    expect(stripBOM('{"a":1}')).toBe('{"a":1}');
  });

  it('basenameFromPath handles both separators and nullish input', () => {
    expect(basenameFromPath('/planets/earth.json')).toBe('earth.json');
    expect(basenameFromPath('C:\\planets\\mars.json')).toBe('mars.json');
    expect(basenameFromPath(undefined)).toBe('');
  });

  it('parseMoonCsv parses every column and ignores blank rows', () => {
    const [titan, rhea, ...rest] = parseMoonCsv('Titan,/m.png,0.5,0.01,32,16,1.3,23,#d2b48c,15.9,0.3,0.02,0.03,0.33,12.2;Rhea,,0.15,0,8,8,2.3,21,#b0a088,4.5,0.35,0.01,0.001,0.35,5.27;;');
    expect(rest).toEqual([]);
    expect(titan).toEqual({
      name: 'Titan', type: 'moon', map: '/m.png', diameter: 0.5, atmosphere: 0.01, widthSegments: 32, heightSegments: 16,
      mass: 1.3, pow: 23, color: '#d2b48c', period: 15.9, tilt: 0.3, spin: 0.02, eccentricity: 0.03, inclination: 0.33, semiMajorAxis: 12.2,
    });
    expect(rhea.map).toBe('');
  });

  it('parseMoonCsv accepts a single moon without a trailing separator', () => {
    expect(parseMoonCsv('Solo,,1,0,8,8,1,20,#fff,2,0,0.01,0,0,3')).toHaveLength(1);
  });

  it.each([
    [0.036, 27.3, 0.036],
    [-0.2, 10, -0.2],
    [15.945, 15.945, (0.036 * 27.3) / 15.945], // period copied into spin
    [NaN, 27.3, 0.036],
    [5, 0, 0.036],
    [3, 0.1, 0.5], // very short periods are capped
  ])('sanitizeSpin(%f, %f) → %f', (spin, period, expected) => {
    expect(sanitizeSpin(spin, period)).toBeCloseTo(expected, 12);
  });

  it('listBodies orders star, planets, comets', () => {
    const star = { name: 'S', planets: [{ name: 'P' }], comets: [{ name: 'C' }] };
    expect(listBodies(star).map((b) => b.name)).toEqual(['S', 'P', 'C']);
    expect(listBodies(null)).toEqual([]);
    expect(listBodies({ name: 'Lonely' }).map((b) => b.name)).toEqual(['Lonely']);
  });
});

describe('readJsonFilesSync', () => {
  let dir;
  beforeEach(() => { dir = makeResources(); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads JSON (with or without BOM) and skips malformed or non-JSON files', () => {
    writeJson(dir, 'planets/a.json', { name: 'A' }, true);
    writeJson(dir, 'planets/b.JSON', { name: 'B' });
    fs.writeFileSync(path.join(dir, 'planets/broken.json'), '{nope');
    fs.writeFileSync(path.join(dir, 'planets/readme.txt'), 'hi');
    const log = logger();
    const result = readJsonFilesSync(path.join(dir, 'planets'), log);
    expect(Object.keys(result).sort()).toEqual(['a.json', 'b.JSON']);
    expect(result['a.json']).toEqual({ name: 'A' });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('broken.json'));
  });

  it('returns an empty object for a missing directory', () => {
    expect(readJsonFilesSync(path.join(dir, 'nope'))).toEqual({});
  });
});

describe('createUniverseBuilder', () => {
  let dir;
  let log;
  let builder;

  beforeEach(() => {
    dir = makeResources();
    log = logger();
    builder = createUniverseBuilder({ resourcesRoot: dir, logger: log });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('requires a resources root', () => {
    expect(() => createUniverseBuilder()).toThrow(/resourcesRoot/);
  });

  it('textureExists only accepts files inside resources/images', () => {
    expect(builder.textureExists('/images/planets/real.png')).toBe(true);
    expect(builder.textureExists('images/planets/real.png')).toBe(true);
    expect(builder.textureExists('/images/planets/missing.png')).toBe(false);
    expect(builder.textureExists('/images/../planets/x.json')).toBe(false);
    expect(builder.textureExists('')).toBe(false);
    expect(builder.textureExists(42)).toBe(false);
  });

  it('builds the full hierarchy and resolves planet and moon references', () => {
    writeJson(dir, 'stars/sun.json', {
      name: 'Sun', type: 'star', map: '/images/planets/missing.png',
      planets: ['/planets/earth.json', '/planets/ghost.json'],
      rings: [{ name: 'Belt', inner: '10', outer: 20 }, null],
      comets: [{ name: 'Halley', period: 27563 }],
    });
    writeJson(dir, 'planets/earth.json', {
      name: 'Earth', map: '/images/planets/real.png', bumpMap: '/images/planets/nope.png',
      moons: ['/moons/moon.json', '/moons/missing.json', { name: 'Inline', period: 3 }, 7],
      rings: [{ name: 'R', texture: '/images/none.png' }],
    });
    writeJson(dir, 'moons/moon.json', { name: 'Moon', period: 27.3, spin: 0.036, semiMajorAxis: 3.844 });

    const { stars } = builder.buildFromResources();
    expect(stars).toHaveLength(1);
    const [sun] = stars;
    expect(sun.resource).toBe('/stars/sun.json');
    expect(sun.map).toBe(''); // missing texture scrubbed
    expect(sun.rings).toEqual([{ name: 'Belt', inner: 10, outer: 20, thickness: 0.01 }]);
    expect(sun.comets[0]).toMatchObject({ name: 'Halley', type: 'comet' });

    expect(sun.planets.map((p) => p.name)).toEqual(['Earth']);
    const [earth] = sun.planets;
    expect(earth).toMatchObject({ type: 'planet', resource: '/planets/earth.json', map: '/images/planets/real.png', bumpMap: '' });
    expect(earth.rings[0].texture).toBe('');
    expect(earth.moons.map((m) => m.name)).toEqual(['Moon', 'Inline']);
    expect(earth.moons[0]).toMatchObject({ resource: '/moons/moon.json', x: 3.844, type: 'moon' });
    expect(earth.moons[1].semiMajorAxis).toBe(DEFAULT_MOON_SEMI_MAJOR_AXIS);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Missing planet: ghost.json'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Missing moon: missing.json'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid moon entry'));
  });

  it('parses CSV moons and drops duplicate names', () => {
    writeJson(dir, 'stars/s.json', { name: 'S', planets: ['/planets/p.json'] });
    writeJson(dir, 'planets/p.json', { name: 'P', moons: 'A,,1,0,8,8,1,20,#fff,2,0,9,0,0,3;A,,1,0,8,8,1,20,#fff,2,0,0.1,0,0,3;B,,1,0,8,8,1,20,#fff,4,0,0.1,0,0,' });
    const [p] = builder.buildFromResources().stars[0].planets;
    expect(p.moons.map((m) => m.name)).toEqual(['A', 'B']);
    expect(p.moons[0].spin).toBeCloseTo((0.036 * 27.3) / 2, 12); // spin 9 rad/frame sanitised
    expect(p.moons[1].semiMajorAxis).toBe(DEFAULT_MOON_SEMI_MAJOR_AXIS); // empty column → default
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Duplicate moon "A"'));
  });

  it('does not mutate the source maps', () => {
    const planetMap = { 'p.json': { name: 'P', moons: [{ name: 'M' }] } };
    const snapshot = structuredClone(planetMap);
    builder.buildUniverseHierarchy({ 's.json': { name: 'S', planets: ['p.json'] } }, planetMap, {});
    expect(planetMap).toEqual(snapshot);
  });

  it('defaults missing collections to empty arrays', () => {
    const { stars } = builder.buildUniverseHierarchy({ 's.json': { name: 'S' } }, {}, {});
    expect(stars[0]).toMatchObject({ planets: [], rings: [], comets: [] });
  });
});

describe('bundled resources', () => {
  const builder = createUniverseBuilder({ resourcesRoot: path.join(ROOT, 'resources') });
  const { stars } = builder.buildFromResources();
  const sun = stars[0];

  it('contains the Sun with all eight planets and both comets', () => {
    expect(sun.name).toBe('Sun');
    expect(sun.planets.map((p) => p.name).sort()).toEqual(['Earth', 'Jupiter', 'Mars', 'Mercury', 'Neptune', 'Saturn', 'Uranus', 'Venus']);
    expect(sun.comets.map((c) => c.name)).toEqual(['Halley', 'Hale-Bopp']);
  });

  it('gives every planet J2000 elements and unique moon names', () => {
    for (const planet of sun.planets) {
      expect(planet.period, planet.name).toBeGreaterThan(0);
      expect(Number.isFinite(planet.M0), planet.name).toBe(true);
      expect(Number.isFinite(planet.longitudeOfPerihelion), planet.name).toBe(true);
      const names = planet.moons.map((m) => m.name);
      expect(new Set(names).size, planet.name).toBe(names.length);
      for (const moon of planet.moons) expect(Math.abs(moon.spin), moon.name).toBeLessThan(1);
    }
  });
});
