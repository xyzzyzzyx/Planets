import * as THREE from 'three';
import { J2000_MS, MS_PER_DAY } from '../../shared/orbital';

/**
 * Rotational elements from the IAU Working Group on Cartographic Coordinates
 * and Rotational Elements (Archinal et al. 2018, "WGCCRE 2015"): the north
 * pole's right ascension α0 and declination δ0 (ICRF, degrees) and the
 * prime-meridian angle W (degrees), as functions of d (days since J2000) and
 * T (Julian centuries since J2000). Negative dW/dt means retrograde rotation.
 */
export interface RotationElements {
  alpha0(d: number, T: number): number;
  delta0(d: number, T: number): number;
  W(d: number, T: number): number;
  /** Mean rotation rate, degrees per day (sign gives the sense of rotation). */
  readonly rate: number;
}

const DEG = Math.PI / 180;
const sinD = (deg: number) => Math.sin(deg * DEG);
const cosD = (deg: number) => Math.cos(deg * DEG);
const neptuneN = (T: number) => 357.85 + 52.316 * T;
const moonE1 = (d: number) => 125.045 - 0.0529921 * d;
const moonE2 = (d: number) => 250.089 - 0.1059842 * d;

const fixed = (alpha: number, delta: number, w0: number, rate: number): RotationElements => ({
  alpha0: () => alpha, delta0: () => delta, W: (d) => w0 + rate * d, rate,
});

/** IAU rotational elements by body name (home system). */
export const IAU_ROTATION: Readonly<Record<string, RotationElements>> = {
  Sun: fixed(286.13, 63.87, 84.176, 14.1844),
  Mercury: { alpha0: (_d, T) => 281.0103 - 0.0328 * T, delta0: (_d, T) => 61.4155 - 0.0049 * T, W: (d) => 329.5988 + 6.1385108 * d, rate: 6.1385108 },
  Venus: fixed(272.76, 67.16, 160.2, -1.4813688),
  Earth: { alpha0: (_d, T) => -0.641 * T, delta0: (_d, T) => 90 - 0.557 * T, W: (d) => 190.147 + 360.9856235 * d, rate: 360.9856235 },
  Mars: {
    alpha0: (_d, T) => 317.269202 - 0.10927547 * T, delta0: (_d, T) => 54.432516 - 0.05827105 * T,
    W: (d) => 176.049863 + 350.891982443297 * d, rate: 350.891982443297,
  },
  Jupiter: { alpha0: (_d, T) => 268.056595 - 0.006499 * T, delta0: (_d, T) => 64.495303 + 0.002413 * T, W: (d) => 284.95 + 870.536 * d, rate: 870.536 },
  Saturn: { alpha0: (_d, T) => 40.589 - 0.036 * T, delta0: (_d, T) => 83.537 - 0.004 * T, W: (d) => 38.9 + 810.7939024 * d, rate: 810.7939024 },
  Uranus: fixed(257.311, -15.175, 203.81, -501.1600928),
  Neptune: {
    alpha0: (_d, T) => 299.36 + 0.7 * sinD(neptuneN(T)), delta0: (_d, T) => 43.46 - 0.51 * cosD(neptuneN(T)),
    W: (d, T) => 249.978 + 541.1397757 * d - 0.48 * sinD(neptuneN(T)), rate: 541.1397757,
  },
  // The Moon's two largest periodic terms (the 18.6-year nodal cycle) are included; the rest are < 0.1°.
  Moon: {
    alpha0: (d, T) => 269.9949 + 0.0031 * T - 3.8787 * sinD(moonE1(d)) - 0.1204 * sinD(moonE2(d)),
    delta0: (d, T) => 66.5392 + 0.013 * T + 1.5419 * cosD(moonE1(d)) + 0.0239 * cosD(moonE2(d)),
    W: (d) => 38.3213 + 13.17635815 * d + 3.561 * sinD(moonE1(d)) + 0.1208 * sinD(moonE2(d)),
    rate: 13.17635815,
  },
};

/** Mean obliquity of the ecliptic at J2000. */
export const OBLIQUITY_J2000_DEG = 23.4392911;

/** ICRF (equatorial) → J2000 ecliptic → scene (−Y = ecliptic north; see shared/orbital.js). */
const ICRF_TO_SCENE = new THREE.Matrix4()
  .makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0)) // ecliptic → scene
  .multiply(new THREE.Matrix4().makeRotationX(-OBLIQUITY_J2000_DEG * DEG)); // equatorial → ecliptic

/**
 * Sphere mesh local frame → body-fixed frame. three.js SphereGeometry puts an
 * equirectangular map's prime meridian on local +X, 90° E on local −Z and the
 * north pole on local +Y; body-fixed axes are X = 0°, Y = 90° E, Z = north.
 */
const MESH_TO_BODY = new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0));

const _m = new THREE.Matrix4();
const _r = new THREE.Matrix4();

const daysSince = (timeMs: number) => (Number.isFinite(timeMs) ? (timeMs - J2000_MS) / MS_PER_DAY : 0);

/** Orientation (mesh local → scene) of a body at a simulated time, per its IAU elements. */
export function iauOrientation(el: RotationElements, timeMs: number, target = new THREE.Quaternion()): THREE.Quaternion {
  const d = daysSince(timeMs);
  const T = d / 36525;
  const w = ((el.W(d, T) % 360) + 360) % 360;
  _m.copy(ICRF_TO_SCENE)
    .multiply(_r.makeRotationZ((el.alpha0(d, T) + 90) * DEG))
    .multiply(_r.makeRotationX((90 - el.delta0(d, T)) * DEG))
    .multiply(_r.makeRotationZ(w * DEG))
    .multiply(MESH_TO_BODY);
  return target.setFromRotationMatrix(_m);
}

/** North pole direction (scene frame) of a body per its IAU elements. */
export function iauPole(el: RotationElements, timeMs: number = J2000_MS, target = new THREE.Vector3()): THREE.Vector3 {
  const d = daysSince(timeMs);
  const T = d / 36525;
  const a = el.alpha0(d, T) * DEG;
  const dec = el.delta0(d, T) * DEG;
  return target.set(Math.cos(dec) * Math.cos(a), Math.cos(dec) * Math.sin(a), Math.sin(dec)).applyMatrix4(ICRF_TO_SCENE).normalize();
}

/** Ecliptic north in the scene frame. */
export const ECLIPTIC_NORTH = Object.freeze(new THREE.Vector3(0, -1, 0));

/** Quaternion turning local +Y onto `pole` (orients an equatorial ring or a fallback spin axis). */
export function poleOrientation(pole: THREE.Vector3, target = new THREE.Quaternion()): THREE.Quaternion {
  return target.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pole.clone().normalize());
}

/** Unit vector (scene frame) for an ICRF right ascension/declination in degrees. */
export function icrfDirection(raDeg: number, decDeg: number, target = new THREE.Vector3()): THREE.Vector3 {
  const a = raDeg * DEG;
  const d = decDeg * DEG;
  return target.set(Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)).applyMatrix4(ICRF_TO_SCENE).normalize();
}

/** Celestial (Earth-equator) north pole in the scene frame. */
export const CELESTIAL_NORTH = Object.freeze(icrfDirection(0, 90));
