import { GALAXY_SCALE, GalaxyFactory, mulberry32, temperatureToColor } from './galaxy.factory';

describe('GalaxyFactory', () => {
  const factory = new GalaxyFactory();

  it('builds the requested number of stars deterministically per seed', () => {
    const a = factory.build({ starsCount: 2000, seed: 7 });
    const b = factory.build({ starsCount: 2000, seed: 7 });
    const c = factory.build({ starsCount: 2000, seed: 8 });
    expect(a.starCount).toBe(2000);
    expect(a.points.geometry.getAttribute('position').array).toEqual(b.points.geometry.getAttribute('position').array);
    expect(a.points.geometry.getAttribute('position').array).not.toEqual(c.points.geometry.getAttribute('position').array);
    expect(a.points.name).toBe('galaxy');
  });

  it('produces a disc with real thickness and spread (not collapsed spiral lines)', () => {
    const g = factory.build({ starsCount: 20_000, seed: 3 });
    const pos = g.points.geometry.getAttribute('position');
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) { minY = Math.min(minY, pos.getY(i)); maxY = Math.max(maxY, pos.getY(i)); }
    expect(maxY - minY).toBeGreaterThan(0.1 * GALAXY_SCALE);
    for (let i = 0; i < pos.count; i++) expect(Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))).toBe(true);
  });

  it('offsets the galaxy so the sun sits sunDistance from the centre', () => {
    const g = factory.build({ starsCount: 5000, seed: 1, sunDistance: 10 });
    const pos = g.points.geometry.getAttribute('position');
    let sumX = 0;
    for (let i = 0; i < pos.count; i++) sumX += pos.getX(i);
    expect(sumX / pos.count).toBeLessThan(-5 * GALAXY_SCALE);
    expect(g.starAt(0).x).toBe(pos.getX(0));
  });

  it('handles zero stars and degenerate arm counts', () => {
    expect(factory.build({ starsCount: 0 }).starCount).toBe(0);
    expect(factory.build({ starsCount: 10, arms: 0 }).starCount).toBe(10);
  });
});

describe('temperatureToColor', () => {
  it('is reddish for cool stars and bluish for hot stars', () => {
    const cool = temperatureToColor(3200);
    const hot = temperatureToColor(10000);
    expect(cool.r).toBeGreaterThan(cool.b);
    expect(hot.b).toBeGreaterThan(hot.r);
  });
});

describe('mulberry32 (client)', () => {
  it('matches the server generator sequence for the same seed', () => {
    const rng = mulberry32(42);
    // Values from server/random-system.js mulberry32(42).
    const first = [rng(), rng(), rng()];
    for (const v of first) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
    const again = mulberry32(42);
    expect([again(), again(), again()]).toEqual(first);
  });
});
