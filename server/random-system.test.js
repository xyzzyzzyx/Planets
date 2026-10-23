import { describe, expect, it } from 'vitest';
import { periodFromSemiMajorAxis } from '../shared/orbital.js';
import {
  generateRandomComet,
  generateRandomMoon,
  generateRandomPlanet,
  generateRandomRing,
  generateRandomStarSystem,
  hexColor,
  mulberry32,
  randomGalaxyPosition,
  SCENE_UNITS_PER_AU,
  STAR_TYPES,
} from './random-system.js';

const HEX = /^#[0-9a-f]{6}$/;

/** Collect every colour string in a generated system. */
function colours(star) {
  const out = [star.color];
  for (const p of star.planets) {
    out.push(p.color);
    p.moons.forEach((m) => out.push(m.color));
    p.rings.forEach((r) => out.push(r.color));
  }
  star.comets.forEach((c) => out.push(c.color));
  star.rings.forEach((r) => out.push(r.color));
  return out;
}

describe('mulberry32', () => {
  it('is deterministic per seed and yields values in [0, 1)', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let i = 0; i < 1000; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('differs between seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe('hexColor', () => {
  it.each([
    [0, '#000000'],
    [0xabc, '#000abc'],
    [0xffffff, '#ffffff'],
    [0x1ffffff, '#ffffff'],
    [-5, '#000000'],
    [255.9, '#0000ff'],
  ])('hexColor(%d) → %s', (input, expected) => {
    expect(hexColor(input)).toBe(expected);
  });
});

describe('generateRandomStarSystem', () => {
  it('is reproducible for the same seed', () => {
    expect(generateRandomStarSystem(42)).toEqual(generateRandomStarSystem(42));
    expect(generateRandomStarSystem(42)).not.toEqual(generateRandomStarSystem(43));
  });

  it.each([1, 7, 42, 999, 123456789, 987654321])('produces a well-formed system for seed %i', (seed) => {
    const star = generateRandomStarSystem(seed);
    expect(star.type).toBe('star');
    expect(star.name).toBe(`Star-${seed.toString(16).toUpperCase()}`);
    expect(STAR_TYPES.map((t) => t.name)).toContain(star.spectralClass);
    expect(star.planets.length).toBeGreaterThanOrEqual(1);
    expect(star.planets.length).toBeLessThanOrEqual(9);
    expect(star.comets.length).toBeGreaterThanOrEqual(2);
    expect(star.comets.length).toBeLessThanOrEqual(6);
    expect(star.rings.length).toBeGreaterThanOrEqual(2);
    expect(star.rings.length).toBeLessThanOrEqual(6);

    for (const c of colours(star)) expect(c).toMatch(HEX);

    const aus = star.planets.map((p) => p.au);
    expect(aus).toEqual([...aus].sort((a, b) => a - b));

    const names = [star, ...star.planets, ...star.planets.flatMap((p) => p.moons), ...star.comets].map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);

    for (const body of [...star.planets, ...star.comets]) {
      expect(body.period).toBeCloseTo(periodFromSemiMajorAxis(body.au), 6);
      expect(body.eccentricity).toBeLessThan(1);
    }
    for (const ring of star.rings) {
      expect(ring.outer).toBeGreaterThan(ring.inner);
      expect(ring.inner).toBeGreaterThanOrEqual(0.5 * SCENE_UNITS_PER_AU);
      expect(ring.keplerianRotation).toBe(true);
    }
  });

  it('sanitises non-finite or negative seeds', () => {
    expect(generateRandomStarSystem(NaN).name).toBe('Star-1');
    expect(generateRandomStarSystem(-42)).toEqual(generateRandomStarSystem(42));
  });

  it('only attaches a magnetic field object when one is generated', () => {
    for (let seed = 1; seed < 40; seed++) {
      const star = generateRandomStarSystem(seed);
      if ('magneticField' in star) expect(star.magneticField).toMatchObject({ strength: expect.any(Number), radius: expect.any(Number) });
    }
  });
});

describe('component generators', () => {
  const rng = mulberry32(5);
  const star = { name: 'S' };

  it('generateRandomPlanet names, sizes and rings', () => {
    for (let i = 0; i < 50; i++) {
      const p = generateRandomPlanet(rng, star, i);
      expect(p.name).toBe(`S-Planet${i + 1}`);
      expect(['rocky', 'gas_giant', 'ice_giant']).toContain(p.kind);
      if (p.kind === 'rocky') expect(p.rings).toEqual([]);
      expect(p.moons.length).toBeLessThan(5);
    }
  });

  it('generateRandomMoon scales with its planet', () => {
    const planet = { name: 'P', diameter: 10 };
    const moon = generateRandomMoon(rng, planet, 3);
    expect(moon.name).toBe('P-Moon3');
    expect(moon.diameter).toBeLessThanOrEqual(0.01 + 1.5);
    expect(moon.semiMajorAxis).toBeGreaterThanOrEqual(30);
  });

  it('generateRandomRing lies outside the planet\'s visual radius', () => {
    for (let i = 0; i < 50; i++) {
      const ring = generateRandomRing(rng, 4);
      expect(ring.inner).toBeGreaterThan(4 * 2 * 1.1); // client minimum safe radius is 0.55 × visual diameter
      expect(ring.outer).toBeGreaterThan(ring.inner);
      expect(ring.color).toMatch(HEX);
    }
  });

  it('generateRandomComet has an eccentric, Keplerian orbit', () => {
    const c = generateRandomComet(rng, star, 0);
    expect(c.eccentricity).toBeGreaterThanOrEqual(0.5);
    expect(c.eccentricity).toBeLessThan(1);
    expect(c.period).toBeCloseTo(periodFromSemiMajorAxis(c.au), 6);
  });

  it('randomGalaxyPosition lies in the disc between 15k and 75k units', () => {
    for (let i = 0; i < 100; i++) {
      const p = randomGalaxyPosition(rng);
      const r = Math.hypot(p.x, p.z);
      expect(p.y).toBe(0);
      expect(r).toBeGreaterThanOrEqual(15000 - 1e-6);
      expect(r).toBeLessThanOrEqual(75000 + 1e-6);
    }
  });
});
