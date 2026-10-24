/**
 * Orbital mechanics shared by the Node server and the Angular client.
 *
 * Plain ES module (no dependencies) so Node can import it directly and the
 * Angular build can bundle it. Types live in `orbital.d.ts`.
 *
 * Conventions
 *  - `period` is the sidereal orbital period in **days**.
 *  - `M0` is the mean anomaly at the J2000 epoch, in **radians**.
 *  - `inclination`, `longitudeOfPerihelion` (ϖ = Ω + ω) and
 *    `longitudeOfAscendingNode` (Ω) are in **degrees**, J2000 ecliptic/equinox.
 *  - Scene frame: X = vernal equinox, Z = ecliptic longitude 90°, and
 *    **−Y = ecliptic north** (prograde orbits run X → Z, clockwise seen from +Y).
 *  - All returned angles are normalised to [0, 2π).
 */

export const TWO_PI = Math.PI * 2;
export const MS_PER_DAY = 86_400_000;
export const DAYS_PER_YEAR = 365.25;
/** J2000.0 epoch: 2000-01-01T12:00:00Z */
export const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
/** Largest/smallest millisecond value a JS Date can represent. */
export const MAX_DATE_MS = 8.64e15;
/** Highest eccentricity the solver accepts (parabolic/hyperbolic orbits are not supported). */
export const MAX_ECCENTRICITY = 0.999999;

const DEG = Math.PI / 180;

/** Normalise an angle in radians to [0, 2π). Non-finite input yields 0. */
export function normalizeAngle(rad) {
  if (!Number.isFinite(rad)) return 0;
  const r = rad % TWO_PI;
  const n = r < 0 ? r + TWO_PI : r;
  return n >= TWO_PI ? 0 : n; // -ε + 2π can round up to exactly 2π

}

/** Clamp an eccentricity to the closed-orbit range [0, MAX_ECCENTRICITY]. */
export function clampEccentricity(e) {
  if (!Number.isFinite(e) || e < 0) return 0;
  return Math.min(e, MAX_ECCENTRICITY);
}

/**
 * Solve Kepler's equation `M = E − e·sin(E)` for the eccentric anomaly E.
 * Newton–Raphson with a starting guess that converges for high eccentricities
 * (comets such as Hale-Bopp at e≈0.995).
 */
export function solveEccentricAnomaly(meanAnomaly, eccentricity, tolerance = 1e-12, maxIterations = 50) {
  const e = clampEccentricity(eccentricity);
  const M = normalizeAngle(meanAnomaly);
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < maxIterations; i++) {
    const delta = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= delta;
    if (Math.abs(delta) < tolerance) break;
  }
  return E;
}

/** Convert an eccentric anomaly to a true anomaly. */
export function trueAnomalyFromEccentric(E, eccentricity) {
  const e = clampEccentricity(eccentricity);
  return normalizeAngle(2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2)));
}

/** Mean anomaly → true anomaly (radians, [0, 2π)). */
export function solveKepler(meanAnomaly, eccentricity) {
  return trueAnomalyFromEccentric(solveEccentricAnomaly(meanAnomaly, eccentricity), eccentricity);
}

/** True anomaly → mean anomaly (inverse of {@link solveKepler}). */
export function meanAnomalyFromTrue(trueAnomaly, eccentricity) {
  const e = clampEccentricity(eccentricity);
  const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(trueAnomaly / 2), Math.sqrt(1 + e) * Math.cos(trueAnomaly / 2));
  return normalizeAngle(E - e * Math.sin(E));
}

/** Kepler's third law for a solar-mass primary: period in days for a semi-major axis in AU. */
export function periodFromSemiMajorAxis(au) {
  return Math.sqrt(Math.abs(au) ** 3) * DAYS_PER_YEAR;
}

/** Days elapsed since J2000 for a millisecond timestamp. */
export function daysSinceJ2000(timeMs) {
  return (timeMs - J2000_MS) / MS_PER_DAY;
}

/**
 * Mean anomaly of a body at a given time. Bodies without a positive period
 * (stars) are stationary and return their M0.
 * @param {{ period?: number, M0?: number }} body
 */
export function meanAnomalyAt(body, timeMs) {
  const M0 = Number.isFinite(body?.M0) ? body.M0 : 0;
  const period = body?.period;
  if (!(period > 0)) return normalizeAngle(M0);
  return normalizeAngle(M0 + (TWO_PI * daysSinceJ2000(timeMs)) / period);
}

/** True anomaly of a body at a given time. */
export function trueAnomalyAt(body, timeMs) {
  if (!(body?.period > 0)) return 0;
  return solveKepler(meanAnomalyAt(body, timeMs), body.eccentricity ?? 0);
}

/** Orbital radius for semi-major axis `a`, eccentricity `e` and true anomaly `nu`. */
export function orbitalRadius(a, eccentricity, nu) {
  const e = clampEccentricity(eccentricity);
  return (a * (1 - e * e)) / (1 + e * Math.cos(nu));
}

/**
 * Cartesian position in the scene frame (ecliptic = XZ plane, −Y = ecliptic
 * north) from the classical elements: the orbit is inclined by `i` about the
 * line of nodes at longitude Ω, and the perihelion lies ω = ϖ − Ω past the
 * ascending node.
 */
export function orbitalPosition(a, eccentricity, nu, inclinationDeg = 0, longitudeOfPerihelionDeg = 0, longitudeOfAscendingNodeDeg = 0) {
  const r = orbitalRadius(a, eccentricity, nu);
  const node = (longitudeOfAscendingNodeDeg || 0) * DEG;
  const u = nu + (longitudeOfPerihelionDeg || 0) * DEG - node; // argument of latitude ν + ω
  const inc = (inclinationDeg || 0) * DEG;
  const cosU = Math.cos(u), sinU = Math.sin(u);
  const cosO = Math.cos(node), sinO = Math.sin(node);
  const xEcl = r * (cosO * cosU - sinO * sinU * Math.cos(inc));
  const yEcl = r * (sinO * cosU + cosO * sinU * Math.cos(inc));
  const zEcl = r * sinU * Math.sin(inc);
  return { x: xEcl, y: -zEcl, z: yEcl };
}

/** Heliocentric ecliptic longitude (radians, [0, 2π)) for a true anomaly. */
export function eclipticLongitude(nu, longitudeOfPerihelionDeg = 0) {
  return normalizeAngle(nu + (longitudeOfPerihelionDeg || 0) * DEG);
}

/** Clamp a timestamp to the range representable by `Date`. */
export function clampDateMs(ms) {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(-MAX_DATE_MS, Math.min(MAX_DATE_MS, ms));
}

/**
 * Walk a star → planets/comets → moons hierarchy and compute the true anomaly
 * of every orbiting body (keyed by name) plus a rotation angle for every
 * named ring with a period or Keplerian rotation.
 */
export function computeTrueAnomalies(star, timeMs, defaultRingPeriodDays = 1680) {
  const angles = {};
  if (!star) return angles;
  const days = daysSinceJ2000(timeMs);

  const visit = (body) => {
    if (!body || typeof body !== 'object') return;
    if (body.name) angles[body.name] = trueAnomalyAt(body, timeMs);
    if (Array.isArray(body.rings)) {
      for (const ring of body.rings) {
        if (ring?.name && (ring.period > 0 || ring.keplerianRotation)) {
          const period = ring.period > 0 ? ring.period : defaultRingPeriodDays;
          angles[ring.name] = normalizeAngle((TWO_PI * days) / period);
        }
      }
    }
    for (const key of ['planets', 'moons', 'comets']) {
      if (Array.isArray(body[key])) body[key].forEach(visit);
    }
  };
  visit(star);
  return angles;
}
