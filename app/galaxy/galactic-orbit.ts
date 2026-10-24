import * as THREE from 'three';
import { J2000_MS, MS_PER_DAY } from '../../shared/orbital';
import { SIMULATION_CONSTANTS } from './celestial.model';
import { GALAXY_SCALE } from './galaxy.factory';

// ── Measured Milky Way parameters ───────────────────────────────────────────
/** Sun's distance from the galactic centre, parsecs (Reid et al. 2019: 8.15 kpc). */
export const SUN_GALACTOCENTRIC_DISTANCE_PC = 8150;
/** Sun's speed around the centre, km/s: circular speed Θ0 ≈ 236 plus the Sun's own lead V☉ ≈ 12 (Reid et al. 2019). */
export const SUN_ORBITAL_SPEED_KM_S = 247;
/** Sun's height above the galactic mid-plane, parsecs (Bennett & Bovy 2019). */
export const SUN_HEIGHT_PC = 20.8;
/** Sun's velocity toward the north galactic pole, km/s (Schönrich et al. 2010). */
export const SUN_VERTICAL_SPEED_KM_S = 7.25;
/** Period of the Sun's oscillation through the disk, million years (local mid-plane density ≈ 0.1 M☉/pc³). */
export const SUN_VERTICAL_PERIOD_MYR = 84;

const AU_KM = 149_597_870.7;
const PC_AU = 206_264.806;
const YEAR_MS = 365.25 * MS_PER_DAY;
const UNITS_PER_KM = SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU / AU_KM;
const UNITS_PER_PC = PC_AU * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;

/** Home star's distance from the core in the rendered galaxy, scene units (GalaxyConfig.sunDistance = 10). */
export const HOME_GALACTIC_RADIUS = 10 * GALAXY_SCALE;

/**
 * The rendered galaxy is ~50 million times smaller than the real one (the
 * Sun's 8.15 kpc becomes 33 AU). Distances *and times* of the galactic motion
 * are compressed by this same factor, so the Sun still moves at its true
 * 247 km/s — its path past the planets is drawn at true scale — while a
 * galactic year takes ~4 simulated years instead of ~200 million.
 */
export const GALACTIC_COMPRESSION = HOME_GALACTIC_RADIUS / (SUN_GALACTOCENTRIC_DISTANCE_PC * UNITS_PER_PC);

/** Sun's orbital speed in scene units per simulated ms (true scale). */
export const SUN_SPEED_UNITS_PER_MS = (SUN_ORBITAL_SPEED_KM_S * UNITS_PER_KM) / 1000;

/** Simulated duration of one revolution of the home system around the core. */
export const GALACTIC_YEAR_MS = (2 * Math.PI * HOME_GALACTIC_RADIUS) / SUN_SPEED_UNITS_PER_MS;
/** Real galactic year (million years) implied by the parameters above, ≈ 203 Myr. */
export const REAL_GALACTIC_YEAR_MYR = GALACTIC_YEAR_MS / GALACTIC_COMPRESSION / YEAR_MS / 1e6;

const VERTICAL_PERIOD_MS = SUN_VERTICAL_PERIOD_MYR * 1e6 * YEAR_MS * GALACTIC_COMPRESSION;
const VERTICAL_OMEGA = (2 * Math.PI) / VERTICAL_PERIOD_MS;
const SUN_HEIGHT_UNITS = SUN_HEIGHT_PC * UNITS_PER_PC * GALACTIC_COMPRESSION;
const SUN_VERTICAL_SPEED_UNITS_PER_MS = (SUN_VERTICAL_SPEED_KM_S * UNITS_PER_KM) / 1000;

// ── Orientation of the galaxy in the scene ──────────────────────────────────
// Galactic axes in J2000 ecliptic coordinates (IAU equatorial→galactic matrix
// rotated by the obliquity 23.4393°): the centre lies toward Sagittarius at
// λ 266.84°, β −5.54°; the direction of galactic rotation (l = 90°, Cygnus) at
// λ 347.34°, β +59.57°; the north galactic pole at λ 180.02°, β +29.81°. The
// ecliptic is therefore tilted 60.19° to the galactic plane.
const ECL_GC: [number, number, number] = [-0.0548755604, -0.993821379, -0.0964766263];
const ECL_L90: [number, number, number] = [0.4941094279, -0.1109907336, 0.8622858751];
const ECL_NGP: [number, number, number] = [-0.867666149, -0.00035159, 0.4971471917];

/** Ecliptic (X equinox, Y λ=90°, Z north) → scene (−Y is ecliptic north, see shared/orbital.js). */
export function eclipticToScene([x, y, z]: readonly [number, number, number], target = new THREE.Vector3()): THREE.Vector3 {
  return target.set(x, -z, y);
}

/** Unit vectors (scene frame) toward the galactic centre, the direction of rotation, and the north galactic pole. */
export const GALACTIC_AXES = Object.freeze({
  center: eclipticToScene(ECL_GC).normalize(),
  rotation: eclipticToScene(ECL_L90).normalize(),
  northPole: eclipticToScene(ECL_NGP).normalize(),
});

/**
 * Rotation from the galaxy model's local frame (disk in XZ, home star on +X
 * of the core, rotating positively about +Y; see GalaxyFactory) to the scene.
 */
export const GALAXY_ORIENTATION = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().makeBasis(
    GALACTIC_AXES.center.clone().negate(),
    GALACTIC_AXES.northPole.clone().negate(),
    GALACTIC_AXES.rotation.clone().negate(),
  ),
);

/** Angle (radians, [0, 2π)) swept around the core since J2000 for a revolution period. */
export function galacticAngleAt(timeMs: number, periodMs: number = GALACTIC_YEAR_MS): number {
  if (!Number.isFinite(timeMs) || !(periodMs > 0)) return 0;
  const turns = (timeMs - J2000_MS) / periodMs;
  return (turns - Math.floor(turns)) * 2 * Math.PI;
}

/**
 * Orbit of the active star around the galactic core (the black hole at the
 * centre of the spiral), in scene coordinates relative to the core: a circle
 * in the galactic plane, clockwise seen from the north galactic pole, at the
 * Sun's true speed (flat rotation curve, so the same speed for every star),
 * plus the Sun's oscillation through the disk. The Sun's 11 km/s radial
 * motion (epicycle) is omitted.
 */
export class GalacticOrbit {
  /** Position relative to the core at J2000 (scene units). */
  readonly epochOffset = new THREE.Vector3();
  private readonly inPlane = new THREE.Vector3();
  private height0 = 0;
  private readonly spinAxis = GALACTIC_AXES.northPole.clone().negate();

  constructor() {
    this.setStart(10);
  }

  /**
   * @param sunDistance home star's distance from the core, galaxy units (GalaxyConfig.sunDistance)
   * @param galaxyPosition active star's offset from the home star in the galaxy model's frame (random systems)
   */
  setStart(sunDistance: number, galaxyPosition?: { x: number; y: number; z: number } | null): void {
    const offset = new THREE.Vector3(galaxyPosition?.x ?? 0, galaxyPosition?.y ?? 0, galaxyPosition?.z ?? 0).applyQuaternion(GALAXY_ORIENTATION);
    this.epochOffset.copy(GALACTIC_AXES.center).multiplyScalar(-sunDistance * GALAXY_SCALE).add(offset);
    this.height0 = this.epochOffset.dot(GALACTIC_AXES.northPole);
    this.inPlane.copy(this.epochOffset).addScaledVector(GALACTIC_AXES.northPole, -this.height0);
    this.epochOffset.addScaledVector(GALACTIC_AXES.northPole, SUN_HEIGHT_UNITS);
  }

  /** Orbital radius in the galactic plane (scene units). */
  get radius(): number {
    return this.inPlane.length();
  }

  /** Simulated duration of one revolution at the Sun's speed. */
  get periodMs(): number {
    return this.radius > 0 ? (2 * Math.PI * this.radius) / SUN_SPEED_UNITS_PER_MS : GALACTIC_YEAR_MS;
  }

  /** Height above the galactic mid-plane at `timeMs` (scene units, toward the north galactic pole). */
  heightAt(timeMs: number): number {
    const t = Number.isFinite(timeMs) ? timeMs - J2000_MS : 0;
    const phase = VERTICAL_OMEGA * t;
    return (this.height0 + SUN_HEIGHT_UNITS) * Math.cos(phase) + (SUN_VERTICAL_SPEED_UNITS_PER_MS / VERTICAL_OMEGA) * Math.sin(phase);
  }

  /** Star position relative to the galactic core at `timeMs`. */
  starPositionAt(timeMs: number, target = new THREE.Vector3()): THREE.Vector3 {
    return target
      .copy(this.inPlane)
      .applyAxisAngle(this.spinAxis, galacticAngleAt(timeMs, this.periodMs))
      .addScaledVector(GALACTIC_AXES.northPole, this.heightAt(timeMs));
  }
}
