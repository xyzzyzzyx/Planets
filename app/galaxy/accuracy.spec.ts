import * as THREE from 'three';
import { J2000_MS, trueAnomalyAt } from '../../shared/orbital';
import { MoonConfig, PlanetConfig } from './celestial.model';
import { Moon } from './moon.model';
import { Planet } from './planet.model';
import { ECLIPTIC_NORTH, IAU_ROTATION, iauOrientation, iauPole } from './rotation';

/**
 * Spot checks of orientation and motion against real-world events. Element
 * values are copied from resources/planets/earth.json (JPL) and the JPL
 * satellite mean elements.
 */
const EARTH: PlanetConfig = {
  name: 'Earth', type: 'planet', diameter: 1.2756, au: 1.00000261, period: 365.2564, eccentricity: 0.01671123,
  inclination: -0.00001531, longitudeOfPerihelion: 102.93768193, longitudeOfAscendingNode: 0, M0: 6.24002139, mass: 5.97, pow: 24,
};
const MOON: MoonConfig = {
  name: 'Moon', type: 'moon', diameter: 0.3474, semiMajorAxis: 3.844, eccentricity: 0.0554, argumentOfPeriapsis: 318.15,
  M0: (135.27 * Math.PI) / 180, inclination: 5.16, longitudeOfAscendingNode: 125.08, period: 27.5545436, apsidalPeriod: 5.997, nodalPeriod: 18.6,
  referencePlane: 'ecliptic',
};
const URANUS: PlanetConfig = { name: 'Uranus', type: 'planet', diameter: 5.1118, au: 19.19, period: 30687, eccentricity: 0.047 };
const deg = (rad: number) => (rad * 180) / Math.PI;

/** Longitude (east) and latitude, degrees, of a scene-frame direction in a body's mesh frame. */
function bodyFixedLonLat(dir: THREE.Vector3, orientation: THREE.Quaternion) {
  const v = dir.clone().normalize().applyQuaternion(orientation.clone().invert());
  return { lon: deg(Math.atan2(-v.z, v.x)), lat: deg(Math.asin(v.y)) };
}

function earthPosition(timeMs: number): THREE.Vector3 {
  const earth = new Planet(EARTH);
  return earth.calculatePositionAt(timeMs);
}

describe('accuracy: Earth', () => {
  it('axis is tilted 23.44° from ecliptic north', () => {
    expect(deg(iauPole(IAU_ROTATION['Earth']).angleTo(ECLIPTIC_NORTH))).toBeCloseTo(23.44, 1);
  });

  it('the Sun is over Greenwich at noon UT (J2000: subsolar point ≈ 0.8° E, 23.0° S)', () => {
    const t = J2000_MS; // 2000-01-01 12:00 UT
    const toSun = earthPosition(t).negate();
    const { lon, lat } = bodyFixedLonLat(toSun, iauOrientation(IAU_ROTATION['Earth'], t));
    expect(Math.abs(lon - 0.8)).toBeLessThan(1.5); // equation of time −3.3 min
    expect(lat).toBeCloseTo(-23.0, 0);
  });

  it('northern summer: the Sun is overhead at 23.44° N on the June solstice', () => {
    const t = Date.parse('2024-06-20T20:51:00Z');
    const { lat } = bodyFixedLonLat(earthPosition(t).negate(), iauOrientation(IAU_ROTATION['Earth'], t));
    expect(lat).toBeCloseTo(23.44, 0);
  });

  it('rotates once per sidereal day, eastward (prograde about the north pole)', () => {
    const t = Date.parse('2026-03-01T00:00:00Z');
    const q0 = iauOrientation(IAU_ROTATION['Earth'], t);
    const q1 = iauOrientation(IAU_ROTATION['Earth'], t + 0.99726958 * 86_400_000);
    expect(deg(q0.angleTo(q1))).toBeLessThan(0.01);
    // A quarter-day later, Greenwich has turned 90° east: the point that was at lon 0 now appears at lon −90.
    const greenwich = new THREE.Vector3(1, 0, 0).applyQuaternion(q0);
    const later = iauOrientation(IAU_ROTATION['Earth'], t + 0.25 * 0.99726958 * 86_400_000);
    expect(bodyFixedLonLat(greenwich, later).lon).toBeCloseTo(-90, 0);
  });
});

describe('accuracy: the Moon', () => {
  const earth = new Planet(EARTH);
  const moon = new Moon(MOON);
  earth.addSatellite(moon);

  const geocentric = (t: number) => moon.positionForAngle(trueAnomalyAt(MOON, t)).applyQuaternion(moon.orbitFrameAt(t));

  it('orbits 5.16° to the ecliptic, prograde', () => {
    const t = Date.parse('2026-10-24T00:00:00Z');
    const p0 = geocentric(t);
    const p1 = geocentric(t + 3_600_000);
    const normal = p0.clone().cross(p1).normalize(); // angular momentum
    expect(deg(normal.angleTo(ECLIPTIC_NORTH))).toBeCloseTo(5.16, 1);
  });

  it('keeps its near side toward Earth (within the ±8° librations)', () => {
    for (const iso of ['2024-01-01T00:00:00Z', '2025-07-15T06:00:00Z', '2026-10-24T12:00:00Z']) {
      const t = Date.parse(iso);
      const toEarth = geocentric(t).negate();
      const { lon, lat } = bodyFixedLonLat(toEarth, iauOrientation(IAU_ROTATION['Moon'], t));
      expect(Math.abs(lon), iso).toBeLessThan(9);
      expect(Math.abs(lat), iso).toBeLessThan(8);
    }
  });

  it('is full when opposite the Sun: full moon of 2026-10-26 04:12 UT', () => {
    const t = Date.parse('2026-10-26T04:12:00Z');
    const sunDir = earthPosition(t).negate().normalize();
    const moonDir = geocentric(t).normalize();
    // Elongation measured in the ecliptic plane (phase depends on longitude difference).
    const lon = (v: THREE.Vector3) => Math.atan2(v.z, v.x);
    let diff = Math.abs(deg(lon(moonDir) - lon(sunDir))) % 360;
    if (diff > 180) diff = 360 - diff;
    expect(diff).toBeGreaterThan(170);
  });
});

describe('accuracy: Uranus system', () => {
  it('moons orbit in Uranus\'s 98°-tilted equator, in the direction Uranus spins', () => {
    const uranus = new Planet(URANUS);
    const ariel = new Moon({
      name: 'Ariel', type: 'moon', diameter: 0.1158, semiMajorAxis: 1.909, eccentricity: 0.0012, inclination: 0.04, period: 2.520379,
      referencePlane: 'equator',
    });
    uranus.addSatellite(ariel);
    // IAU "north" is the pole on the north side of the invariable plane; Uranus spins backwards about it,
    // so its spin axis (right-hand rule) is tilted 97.8° from ecliptic north.
    expect(deg(uranus.pole.angleTo(ECLIPTIC_NORTH))).toBeCloseTo(82.2, 0);
    expect(deg(uranus.spinPole.angleTo(ECLIPTIC_NORTH))).toBeCloseTo(97.8, 0);
    const t = Date.parse('2026-01-01T00:00:00Z');
    const pos = (time: number) => ariel.positionForAngle(trueAnomalyAt(ariel.config, time)).applyQuaternion(ariel.orbitFrameAt(time));
    const normal = pos(t).cross(pos(t + 3_600_000)).normalize();
    expect(deg(normal.angleTo(uranus.spinPole))).toBeLessThan(0.1);
  });
});

describe('accuracy: Jupiter system', () => {
  it('Io orbits in Jupiter\'s equatorial plane (its Laplace plane)', () => {
    const jupiter = new Planet({ name: 'Jupiter', type: 'planet', diameter: 14.2984, au: 5.2, period: 4332.8 });
    const io = new Moon({
      name: 'Io', type: 'moon', diameter: 0.364, semiMajorAxis: 4.218, eccentricity: 0.004, argumentOfPeriapsis: 49.1, M0: 5.775,
      inclination: 0, longitudeOfAscendingNode: 0, period: 1.762732, referencePlane: 'laplace', laplacePole: { ra: 268.1, dec: 64.5 },
    });
    jupiter.addSatellite(io);
    const t = Date.parse('2026-01-01T00:00:00Z');
    const pos = (time: number) => io.positionForAngle(trueAnomalyAt(io.config, time)).applyQuaternion(io.orbitFrameAt(time));
    const normal = pos(t).cross(pos(t + 600_000)).normalize();
    expect(deg(normal.angleTo(jupiter.spinPole))).toBeLessThan(0.2);
    expect(deg(jupiter.spinPole.angleTo(ECLIPTIC_NORTH))).toBeCloseTo(2.2, 0); // Jupiter's 3.1° obliquity is to its own orbit
  });
});

