import * as THREE from 'three';
import { orbitalPosition } from '../../shared/orbital';
import { MoonConfig, OrbitingBody } from './celestial.model';
import { CELESTIAL_NORTH, ECLIPTIC_NORTH, icrfDirection } from './rotation';

export type { MoonConfig } from './celestial.model';

export enum LunarPhase {
  NEW_MOON = 'New Moon',
  WAXING_CRESCENT = 'Waxing Crescent',
  FIRST_QUARTER = 'First Quarter',
  WAXING_GIBBOUS = 'Waxing Gibbous',
  FULL_MOON = 'Full Moon',
  WANING_GIBBOUS = 'Waning Gibbous',
  LAST_QUARTER = 'Last Quarter',
  WANING_CRESCENT = 'Waning Crescent',
}

/** Classify a Sun–Moon elongation angle (radians) into one of the eight named phases. */
export function lunarPhaseFromAngle(phaseAngleRad: number): LunarPhase {
  const a = ((phaseAngleRad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const deg = (a * 180) / Math.PI;
  if (deg < 22.5 || deg >= 337.5) return LunarPhase.NEW_MOON;
  if (deg < 67.5) return LunarPhase.WAXING_CRESCENT;
  if (deg < 112.5) return LunarPhase.FIRST_QUARTER;
  if (deg < 157.5) return LunarPhase.WAXING_GIBBOUS;
  if (deg < 202.5) return LunarPhase.FULL_MOON;
  if (deg < 247.5) return LunarPhase.WANING_GIBBOUS;
  if (deg < 292.5) return LunarPhase.LAST_QUARTER;
  return LunarPhase.WANING_CRESCENT;
}

const DEG = Math.PI / 180;
const YEAR_MS = 365.25 * 86_400_000;
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
/**
 * The group's local frame (orbits lie in XZ, run X → Z, angular momentum −Y)
 * expressed in the orbit-plane frame (periapsis P = x, Q = H × P = y, angular momentum H = z).
 */
const LOCAL_TO_PLANE = new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0));
const _basis = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();

/**
 * A moon orbiting a planet. Moons with a `referencePlane` carry their full
 * orbit orientation (reference plane, Ω, i, ω, with nodal and apsidal
 * precession) in the group's quaternion; their positions are computed in the
 * orbit plane. Moons without IAU rotational elements rotate synchronously,
 * keeping their prime meridian toward the planet.
 */
export class Moon extends OrbitingBody {
  declare readonly config: MoonConfig;
  readonly resource?: string;

  constructor(config: MoonConfig) {
    super(config);
    this.resource = config.resource;
  }

  get hasOrbitFrame(): boolean {
    return !!this.config.referencePlane;
  }

  override positionForAngle(nu: number, target = new THREE.Vector3()): THREE.Vector3 {
    if (!this.hasOrbitFrame) return super.positionForAngle(nu, target);
    const p = orbitalPosition(this.getSemiMajorAxis(), this.config.eccentricity ?? 0, nu);
    return target.set(p.x, p.y, p.z);
  }

  /** Node Ω and argument of periapsis ω (degrees) at a time, with secular precession. */
  elementsAt(timeMs: number): { node: number; argPeriapsis: number; inclination: number } {
    const cfg = this.config;
    const i = cfg.inclination ?? 0;
    const years = Number.isFinite(timeMs) ? (timeMs - J2000_MS) / YEAR_MS : 0;
    // Prograde orbits: the node regresses and the periapsis advances (the data's `period` is the
    // matching anomalistic period). Precession of retrograde orbits is not modelled.
    const prograde = i < 90;
    const node = (cfg.longitudeOfAscendingNode ?? 0) - (prograde && cfg.nodalPeriod ? (360 * years) / cfg.nodalPeriod : 0);
    const argPeriapsis = (cfg.argumentOfPeriapsis ?? 0) + (prograde && cfg.apsidalPeriod ? (360 * years) / cfg.apsidalPeriod : 0);
    return { node, argPeriapsis, inclination: i };
  }

  /** Normal (z) and node direction (x) of the reference plane, scene frame. */
  private referenceAxes(z: THREE.Vector3, x: THREE.Vector3): void {
    const cfg = this.config;
    if (cfg.referencePlane === 'laplace' && cfg.laplacePole) icrfDirection(cfg.laplacePole.ra, cfg.laplacePole.dec, z);
    else if (cfg.referencePlane === 'equator' && this.primary) z.copy(this.primary.spinPole);
    else z.copy(ECLIPTIC_NORTH);
    if (cfg.referencePlane === 'ecliptic' || !cfg.referencePlane) {
      x.copy(X_AXIS); // vernal equinox
      return;
    }
    // Node measured from the plane's ascending node on the ICRF equator.
    x.crossVectors(CELESTIAL_NORTH, z);
    if (x.lengthSq() < 1e-12) x.copy(X_AXIS);
    x.normalize();
  }

  override orbitFrameAt(timeMs: number, target = new THREE.Quaternion()): THREE.Quaternion {
    if (!this.hasOrbitFrame) return target.identity();
    this.referenceAxes(_z, _x);
    _y.crossVectors(_z, _x);
    const { node, argPeriapsis, inclination } = this.elementsAt(timeMs);
    _basis.makeBasis(_x, _y, _z)
      .multiply(_r.makeRotationZ(node * DEG))
      .multiply(_r.makeRotationX(inclination * DEG))
      .multiply(_r.makeRotationZ(argPeriapsis * DEG))
      .multiply(LOCAL_TO_PLANE);
    return target.setFromRotationMatrix(_basis);
  }

  override updateOrientation(simTime: number): void {
    if (this.rotationElements || !this.mesh) {
      super.updateOrientation(simTime);
      return;
    }
    // Synchronous rotation: prime meridian (+X) toward the planet, north (+Y) along the orbital angular momentum (−Y locally).
    const p = this.orbitalGroup.position;
    if (p.lengthSq() === 0) return;
    _x.copy(p).negate().normalize();
    _y.set(0, -1, 0);
    _z.crossVectors(_x, _y).normalize();
    _y.crossVectors(_z, _x);
    this.mesh.quaternion.setFromRotationMatrix(_basis.makeBasis(_x, _y, _z));
    this.clouds?.quaternion.copy(this.mesh.quaternion);
  }

  /**
   * Phase as seen from the parent planet: the angle between the directions
   * planet→star and planet→moon (0 = new moon, π = full moon).
   */
  getLunarPhase(starWorldPosition: THREE.Vector3 = new THREE.Vector3()): LunarPhase {
    const moonWorld = this.getWorldPosition();
    const planetWorld = new THREE.Vector3();
    (this.group.parent ?? this.group).getWorldPosition(planetWorld);
    const toStar = starWorldPosition.clone().sub(planetWorld);
    const toMoon = moonWorld.sub(planetWorld);
    toStar.y = 0;
    toMoon.y = 0;
    if (toStar.lengthSq() === 0 || toMoon.lengthSq() === 0) return LunarPhase.NEW_MOON;
    const angle = Math.atan2(toStar.x * toMoon.z - toStar.z * toMoon.x, toStar.dot(toMoon));
    return lunarPhaseFromAngle(angle);
  }
}
