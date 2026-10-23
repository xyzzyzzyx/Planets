import { describe, expect, it } from 'vitest';
import {
  clampDateMs,
  clampEccentricity,
  computeTrueAnomalies,
  daysSinceJ2000,
  eclipticLongitude,
  J2000_MS,
  MAX_DATE_MS,
  MAX_ECCENTRICITY,
  meanAnomalyAt,
  meanAnomalyFromTrue,
  normalizeAngle,
  orbitalPosition,
  orbitalRadius,
  periodFromSemiMajorAxis,
  solveEccentricAnomaly,
  solveKepler,
  trueAnomalyAt,
  TWO_PI,
} from './orbital.js';

import fs from 'node:fs';

const readJson = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/^﻿/, ''));
const DEG = 180 / Math.PI;
/** Smallest signed difference between two angles, in degrees. */
const angleDiffDeg = (a, b) => {
  const d = ((a - b) * DEG) % 360;
  return Math.abs(d > 180 ? d - 360 : d < -180 ? d + 360 : d);
};

describe('normalizeAngle', () => {
  it.each([
    [0, 0],
    [Math.PI, Math.PI],
    [TWO_PI, 0],
    [-Math.PI / 2, (3 * Math.PI) / 2],
    [5 * TWO_PI + 1, 1],
  ])('normalizes %f to %f', (input, expected) => {
    expect(normalizeAngle(input)).toBeCloseTo(expected, 12);
  });

  it('maps non-finite input to 0', () => {
    expect(normalizeAngle(NaN)).toBe(0);
    expect(normalizeAngle(Infinity)).toBe(0);
  });
});

describe('clampEccentricity', () => {
  it('clamps to the closed-orbit range', () => {
    expect(clampEccentricity(-1)).toBe(0);
    expect(clampEccentricity(NaN)).toBe(0);
    expect(clampEccentricity(0.5)).toBe(0.5);
    expect(clampEccentricity(1)).toBe(MAX_ECCENTRICITY);
    expect(clampEccentricity(3)).toBe(MAX_ECCENTRICITY);
  });
});

describe('solveEccentricAnomaly / solveKepler', () => {
  const eccentricities = [0, 0.0167, 0.2056, 0.5, 0.9, 0.967, 0.995];
  const anomalies = Array.from({ length: 24 }, (_, i) => (i / 24) * TWO_PI + 0.01);

  it.each(eccentricities)('satisfies Kepler\'s equation for e=%f', (e) => {
    for (const M of anomalies) {
      const E = solveEccentricAnomaly(M, e);
      const residual = normalizeAngle(E - e * Math.sin(E)) - normalizeAngle(M);
      expect(Math.abs(residual)).toBeLessThan(1e-9);
    }
  });

  it('returns M unchanged for a circular orbit', () => {
    for (const M of anomalies) expect(solveKepler(M, 0)).toBeCloseTo(normalizeAngle(M), 12);
  });

  it('is symmetric about perihelion and aphelion', () => {
    expect(solveKepler(0, 0.6)).toBeCloseTo(0, 12);
    expect(solveKepler(Math.PI, 0.6)).toBeCloseTo(Math.PI, 12);
  });

  it('always returns finite angles in [0, 2π) even for extreme inputs', () => {
    for (const e of [0.999, 1, 1.5, -2, NaN]) {
      for (const M of [-100, -1, 0, 1, 100]) {
        const nu = solveKepler(M, e);
        expect(Number.isFinite(nu)).toBe(true);
        expect(nu).toBeGreaterThanOrEqual(0);
        expect(nu).toBeLessThan(TWO_PI);
      }
    }
  });

  it('round-trips through meanAnomalyFromTrue', () => {
    for (const e of eccentricities) {
      for (const M of anomalies) {
        expect(meanAnomalyFromTrue(solveKepler(M, e), e)).toBeCloseTo(normalizeAngle(M), 8);
      }
    }
  });
});

describe('time helpers', () => {
  it('daysSinceJ2000 is zero at the epoch and counts days', () => {
    expect(daysSinceJ2000(J2000_MS)).toBe(0);
    expect(daysSinceJ2000(J2000_MS + 86_400_000 * 10)).toBe(10);
  });

  it('periodFromSemiMajorAxis follows Kepler\'s third law', () => {
    expect(periodFromSemiMajorAxis(1)).toBeCloseTo(365.25, 10);
    expect(periodFromSemiMajorAxis(4)).toBeCloseTo(8 * 365.25, 10);
  });

  it('clampDateMs keeps timestamps representable by Date', () => {
    expect(clampDateMs(1e20)).toBe(MAX_DATE_MS);
    expect(clampDateMs(-1e20)).toBe(-MAX_DATE_MS);
    expect(clampDateMs(NaN)).toBe(0);
    expect(new Date(clampDateMs(1e20)).getTime()).toBe(MAX_DATE_MS);
  });
});

describe('meanAnomalyAt / trueAnomalyAt', () => {
  it('uses M0 at the epoch and advances one revolution per period', () => {
    const body = { period: 100, M0: 1 };
    expect(meanAnomalyAt(body, J2000_MS)).toBeCloseTo(1, 12);
    expect(meanAnomalyAt(body, J2000_MS + 100 * 86_400_000)).toBeCloseTo(1, 9);
    expect(meanAnomalyAt(body, J2000_MS + 25 * 86_400_000)).toBeCloseTo(1 + Math.PI / 2, 9);
  });

  it('handles dates before J2000', () => {
    const body = { period: 100, M0: 0 };
    expect(meanAnomalyAt(body, J2000_MS - 25 * 86_400_000)).toBeCloseTo((3 * Math.PI) / 2, 9);
  });

  it('treats bodies without a positive period as stationary', () => {
    expect(trueAnomalyAt({ period: 0 }, Date.now())).toBe(0);
    expect(trueAnomalyAt({}, Date.now())).toBe(0);
    expect(trueAnomalyAt(null, Date.now())).toBe(0);
    expect(meanAnomalyAt({ period: 0, M0: 1 }, Date.now())).toBe(1);
  });
});

describe('orbitalRadius / orbitalPosition', () => {
  it('gives perihelion and aphelion distances', () => {
    expect(orbitalRadius(10, 0.5, 0)).toBeCloseTo(5, 12);
    expect(orbitalRadius(10, 0.5, Math.PI)).toBeCloseTo(15, 12);
  });

  it('places a circular, uninclined orbit in the XZ plane', () => {
    const p = orbitalPosition(10, 0, Math.PI / 2);
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(0, 12);
    expect(p.z).toBeCloseTo(10, 12);
  });

  it('tilts the orbit by its inclination', () => {
    const p = orbitalPosition(10, 0, Math.PI / 2, 90);
    expect(p.y).toBeCloseTo(-10, 12);
    expect(p.z).toBeCloseTo(0, 12);
  });

  it('rotates the perihelion by the longitude of perihelion', () => {
    const p = orbitalPosition(10, 0.5, 0, 0, 90);
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.z).toBeCloseTo(5, 12);
    expect(eclipticLongitude(0, 90)).toBeCloseTo(Math.PI / 2, 12);
  });
});

describe('ephemeris accuracy of the bundled resource data', () => {
  const earth = readJson('../resources/planets/earth.json');
  const mars = readJson('../resources/planets/mars.json');
  const sun = readJson('../resources/stars/sun.json');
  const longitudeAt = (body, iso) => eclipticLongitude(trueAnomalyAt(body, Date.parse(iso)), body.longitudeOfPerihelion);

  it.each([
    ['2024-03-20T03:06:00Z', 180], // March equinox: Sun at 0°, Earth opposite
    ['2024-09-22T12:44:00Z', 0], // September equinox
    ['2025-06-21T02:42:00Z', 270], // June solstice
  ])('Earth heliocentric longitude at %s is ≈%i°', (iso, expectedDeg) => {
    expect(angleDiffDeg(longitudeAt(earth, iso), expectedDeg / DEG)).toBeLessThan(1);
  });

  it('puts Mars at opposition (same longitude as Earth) on 2025-01-16', () => {
    const iso = '2025-01-16T02:32:00Z';
    expect(angleDiffDeg(longitudeAt(mars, iso), longitudeAt(earth, iso))).toBeLessThan(3);
  });

  it.each([
    ['Halley', '1986-02-09T00:00:00Z'],
    ['Halley', '2061-07-28T00:00:00Z'],
    ['Hale-Bopp', '1997-04-01T00:00:00Z'],
  ])('%s is at perihelion on %s', (name, iso) => {
    const comet = sun.comets.find((c) => c.name === name);
    const M = meanAnomalyAt(comet, Date.parse(iso));
    expect(Math.min(M, TWO_PI - M)).toBeLessThan(0.01);
  });

  it('stores comet periods in days, consistent with their semi-major axis', () => {
    for (const comet of sun.comets) {
      expect(comet.period / periodFromSemiMajorAxis(comet.au)).toBeGreaterThan(0.95);
      expect(comet.period / periodFromSemiMajorAxis(comet.au)).toBeLessThan(1.05);
    }
  });
});

describe('computeTrueAnomalies', () => {
  const star = {
    name: 'Sun',
    period: 0,
    rings: [
      { name: 'Belt', keplerianRotation: true },
      { name: 'Fast', period: 10 },
      { name: 'Static' },
      { period: 5 }, // unnamed → ignored
    ],
    planets: [
      { name: 'P1', period: 100, M0: 0.5, moons: [{ name: 'M1', period: 10, eccentricity: 0.1 }], rings: [{ name: 'PR', period: 3 }] },
    ],
    comets: [{ name: 'C1', period: 1000, eccentricity: 0.9, M0: 2 }],
  };

  it('computes an angle for every orbiting body and rotating ring', () => {
    const angles = computeTrueAnomalies(star, J2000_MS);
    expect(Object.keys(angles).sort()).toEqual(['Belt', 'C1', 'Fast', 'M1', 'P1', 'PR', 'Sun']);
    expect(angles['Sun']).toBe(0);
    expect(angles['P1']).toBeCloseTo(0.5, 12);
    expect(angles['C1']).toBeCloseTo(solveKepler(2, 0.9), 12);
  });

  it('matches trueAnomalyAt for each body (one source of truth)', () => {
    const t = Date.parse('2031-05-05T00:00:00Z');
    const angles = computeTrueAnomalies(star, t);
    expect(angles['P1']).toBeCloseTo(trueAnomalyAt(star.planets[0], t), 12);
    expect(angles['M1']).toBeCloseTo(trueAnomalyAt(star.planets[0].moons[0], t), 12);
  });

  it('uses the default period for Keplerian rings', () => {
    const t = J2000_MS + 420 * 86_400_000;
    expect(computeTrueAnomalies(star, t, 1680)['Belt']).toBeCloseTo(Math.PI / 2, 9);
  });

  it('returns an empty object for a missing star', () => {
    expect(computeTrueAnomalies(null, Date.now())).toEqual({});
  });
});
