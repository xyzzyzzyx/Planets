import * as THREE from 'three';
import { orbitalPosition, trueAnomalyAt } from '../../shared/orbital';
import { disposeObject3D } from '../webgl/dispose';
import { ECLIPTIC_NORTH, IAU_ROTATION, RotationElements, iauOrientation, iauPole, poleOrientation } from './rotation';

export const SIMULATION_CONSTANTS = {
  VISUAL_SCALE: 4,
  SCALE_UNITS_PER_AU: 1496,
  /**
   * Satellite distances (moon semi-major axes, given in 100,000 km) are
   * enlarged by the same 40× as body sizes (VISUAL_SCALE × 10), so each planet
   * system is a true-proportion miniature: Metis skims 1.8 Jupiter radii out.
   */
  MOON_VISUAL_SCALE: 40,
  MOON_DEFAULT_RADIUS: 50,
  MOON_MIN_VISUAL_RADIUS: 1.5,
} as const;

export type BodyType = 'star' | 'planet' | 'moon' | 'comet';

export interface MagneticFieldConfig {
  strength: number;
  /** Field radius as a multiple of the body's visual radius. */
  radius: number;
  tilt?: number;
  polarity?: number;
}

export interface CelestialConfig {
  type: BodyType;
  name: string;
  diameter: number;
  mass?: number;
  pow?: number;
  color?: string;
  map?: string;
  bumpMap?: string;
  specMap?: string;
  cloudMap?: string;
  alphaMap?: string;
  widthSegments?: number;
  heightSegments?: number;
  atmosphere?: number;
  /** Axial tilt in degrees. */
  tilt?: number;
  /** Rotation per rendered frame, radians. */
  spin?: number;
  magneticField?: MagneticFieldConfig;
  resource?: string;
}

export interface OrbitalConfig {
  au?: number;
  relativeAu?: number;
  semiMajorAxis?: number;
  /** Orbital period in days. */
  period?: number;
  eccentricity?: number;
  /** Degrees. */
  inclination?: number;
  /** Degrees (ϖ = Ω + ω). */
  longitudeOfPerihelion?: number;
  /** Longitude of the ascending node Ω, degrees. */
  longitudeOfAscendingNode?: number;
  /** Mean anomaly at J2000, radians. */
  M0?: number;
}

export interface RingConfig {
  name?: string;
  inner?: number;
  outer?: number;
  thickness?: number;
  color?: string;
  texture?: string;
  particleCount?: number;
  period?: number;
  particleSize?: number;
  keplerianRotation?: boolean;
  rotationSpeed?: number;
  tilt?: number;
}

export interface PlanetConfig extends CelestialConfig, OrbitalConfig {
  rings?: RingConfig[];
  moons?: MoonConfig[];
}

/** Reference plane of a moon's inclination and node. */
export type MoonReferencePlane = 'laplace' | 'ecliptic' | 'equator';

export interface MoonConfig extends CelestialConfig, OrbitalConfig {
  /** Plane the inclination/node are measured from: the local Laplace plane (pole below), the J2000 ecliptic, or the planet's equator. */
  referencePlane?: MoonReferencePlane;
  /** Laplace-plane pole, ICRF degrees (node measured from the plane's ascending node on the ICRF equator). */
  laplacePole?: { ra: number; dec: number };
  /** Argument of periapsis ω, degrees. */
  argumentOfPeriapsis?: number;
  /** Period of the periapsis precession (ω), years; 0 = none. */
  apsidalPeriod?: number;
  /** Period of the nodal precession (Ω), years; 0 = none. */
  nodalPeriod?: number;
  elementsSource?: string;
}

export interface CometConfig extends CelestialConfig, OrbitalConfig {
  tailLength?: number;
  tailColor?: string;
  comaSize?: number;
}

export interface StarConfig extends CelestialConfig {
  stage?: string;
  composition?: string;
  heat?: number;
  energy?: number;
  radiance?: number;
  rings?: RingConfig[];
  comets?: CometConfig[];
  galaxyPosition?: { x: number; y: number; z: number };
}

/** Dipole field description used by CelestialFactory.createMagneticField. */
export class MagneticField {
  constructor(readonly magneticConfig: MagneticFieldConfig, readonly bodyRadius: number) { }

  getFieldRadius(): number {
    return this.bodyRadius * (this.magneticConfig.radius || 5);
  }
}

/** Visual radius (scene units) for a body diameter, never smaller than `minRadius`. */
export function visualRadiusFor(diameter: number | undefined, minRadius: number): number {
  const d = diameter && diameter > 0 ? diameter : 0;
  return Math.max(minRadius, (d * SIMULATION_CONSTANTS.VISUAL_SCALE) / 2);
}

/**
 * Validate the minimal shape of a body config received from the server.
 * Throws a descriptive error for unusable data.
 */
export function validateBodyConfig(config: unknown): asserts config is CelestialConfig {
  const c = config as Partial<CelestialConfig> | null | undefined;
  if (!c?.name || typeof c.name !== 'string') {
    throw new Error(`CelestialBody: name required (got ${JSON.stringify(c?.name)})`);
  }
  if (typeof c.diameter !== 'number' || !(c.diameter > 0)) {
    throw new Error(`CelestialBody "${c.name}": invalid diameter ${c.diameter}`);
  }
}

const _q = new THREE.Quaternion();

/**
 * Base class for every rendered body. Scene graph:
 *   group                      (positioned by the parent; holds satellites for stars)
 *     └─ mesh, highlight, …    (oriented by updateOrientation())
 * Orbiting bodies add an `orbitalGroup` that is moved along the orbit.
 */
export abstract class CelestialBody {
  readonly type: BodyType;
  readonly name: string;
  readonly config: CelestialConfig;
  mass = 0;
  /** North pole (scene frame): IAU pole for known bodies, else ecliptic north tilted by `tilt` about +X. */
  readonly pole: THREE.Vector3;
  /** Rotation axis by the right-hand rule (equals `pole` unless the body rotates retrograde: Venus, Uranus). */
  readonly spinPole: THREE.Vector3;
  /** IAU rotational elements (home system); bodies without them spin `spin` radians per rendered frame. */
  readonly rotationElements?: RotationElements;
  spin: number;
  mesh!: THREE.Mesh;
  clouds?: THREE.Mesh;
  satellites: CelestialBody[] = [];
  /** The body this one orbits (set by addSatellite). */
  primary: CelestialBody | null = null;
  lights: THREE.Light[] = [];
  highlight!: THREE.Mesh;
  readonly group: THREE.Group;
  ringGroup?: THREE.Group;

  latLongGroup?: THREE.Group;

  magneticField?: MagneticField;
  magneticFieldGroup?: THREE.Group;

  protected constructor(config: CelestialConfig) {
    this.config = config;
    this.name = config.name;
    this.type = config.type;
    this.spin = config.spin ?? 0.01;
    const iau = config.type === 'comet' ? undefined : IAU_ROTATION[config.name];
    if (iau && (config.type !== 'moon' || config.name === 'Moon')) this.rotationElements = iau;
    if (this.rotationElements) {
      this.pole = iauPole(this.rotationElements);
      this.spinPole = this.pole.clone().multiplyScalar(Math.sign(this.rotationElements.rate) || 1);
    } else {
      const tiltRad = ((config.tilt ?? 0) * Math.PI) / 180;
      this.pole = ECLIPTIC_NORTH.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), tiltRad);
      this.spinPole = this.pole.clone().multiplyScalar(this.spin < 0 ? -1 : 1);
    }

    this.group = new THREE.Group();
    this.group.name = `${config.name}_group`;
    this.group.userData['body'] = this;

    if (config.magneticField) {
      const visualRadius = (config.diameter / 2) * SIMULATION_CONSTANTS.VISUAL_SCALE;
      this.magneticField = new MagneticField(config.magneticField, visualRadius);
    }
  }

  addSatellite(satellite: CelestialBody): void {
    this.satellites.push(satellite);
    satellite.primary = this;
    this.group.add(satellite.group);
  }

  /**
   * Orient the body for a simulated time. Bodies with IAU elements get their
   * exact pole and prime meridian (Greenwich faces the Sun at 12:00 UT, the
   * Moon keeps its near side to Earth); others spin `spin` radians per frame
   * about their pole. Clouds follow the surface. Rings are not touched: they
   * have their own orientation and rotate in `WebGl.renderFrame`.
   */
  updateOrientation(simTime: number): void {
    if (!this.mesh) return;
    if (this.rotationElements) {
      iauOrientation(this.rotationElements, simTime, this.mesh.quaternion);
      this.mesh.quaternion.premultiply(this.parentWorldQuaternion(_q).invert());
    } else {
      this.mesh.rotateY(this.spin);
    }
    this.clouds?.quaternion.copy(this.mesh.quaternion);
  }

  /** @deprecated frame-based spin; use {@link updateOrientation}. */
  rotate(): void {
    this.updateOrientation(Number.NaN);
  }

  updateHierarchy(simTime: number): void {
    this.updateOrientation(simTime);
    for (const sat of this.satellites) sat.updateHierarchy(simTime);
  }

  /** Set the starting orientation: north pole on `pole` (prime meridian per IAU where known). */
  applyInitialTilt(simTime: number = Number.NaN): void {
    if (!this.mesh) return;
    if (this.rotationElements) {
      this.updateOrientation(Number.isFinite(simTime) ? simTime : Date.now());
    } else {
      poleOrientation(this.pole, this.mesh.quaternion).premultiply(this.parentWorldQuaternion(_q).invert());
      this.clouds?.quaternion.copy(this.mesh.quaternion);
    }
  }

  /** Accumulated rotation of the groups above the mesh (non-identity only inside a moon's orbital frame). */
  protected parentWorldQuaternion(target: THREE.Quaternion): THREE.Quaternion {
    target.identity();
    for (let o = this.mesh?.parent ?? null; o; o = o.parent) target.premultiply(o.quaternion);
    return target;
  }

  /** Depth-first iteration over this body and every descendant. */
  *descendants(): Generator<CelestialBody> {
    yield this;
    for (const sat of this.satellites) yield* sat.descendants();
  }

  /** World-space position of the body's centre. */
  getWorldPosition(target = new THREE.Vector3()): THREE.Vector3 {
    return this.group.getWorldPosition(target);
  }

  /** Release every GPU resource owned by this body and its satellites. */
  dispose(): void {
    disposeObject3D(this.group);
    this.group.removeFromParent();
  }
}

/**
 * A body that follows a Keplerian orbit around its parent. `group` stays at the
 * parent's centre; `orbitalGroup` (mesh, clouds, rings, moons) is moved to the
 * orbital position by {@link OrbitingBody.setAngle}.
 */
export abstract class OrbitingBody extends CelestialBody {
  declare readonly config: CelestialConfig & OrbitalConfig;
  readonly orbitalGroup: THREE.Group;
  currentAngle = 0;

  protected constructor(config: CelestialConfig & OrbitalConfig) {
    super(config);
    this.orbitalGroup = new THREE.Group();
    this.orbitalGroup.name = `${config.name}_orbitalGroup`;
    this.group.add(this.orbitalGroup);
  }

  override addSatellite(satellite: CelestialBody): void {
    this.satellites.push(satellite);
    satellite.primary = this;
    this.orbitalGroup.add(satellite.group);
    if (satellite instanceof OrbitingBody) satellite.updateOrbitFrame(Date.now());
  }

  /**
   * Orientation of the orbit's local frame (the `group`) at a time: identity
   * for planets and comets, whose elements are ecliptic. Moons override this.
   */
  orbitFrameAt(_timeMs: number, target = new THREE.Quaternion()): THREE.Quaternion {
    return target.copy(this.group.quaternion);
  }

  /** Apply {@link orbitFrameAt} to the group (precessing orbits change it over time). */
  updateOrbitFrame(timeMs: number): void {
    this.orbitFrameAt(timeMs, this.group.quaternion);
  }

  override updateHierarchy(simTime: number): void {
    if (Number.isFinite(simTime)) this.updateOrbitFrame(simTime);
    super.updateHierarchy(simTime);
  }

  override getWorldPosition(target = new THREE.Vector3()): THREE.Vector3 {
    return this.orbitalGroup.getWorldPosition(target);
  }

  getSemiMajorAxis(): number {
    const cfg = this.config;
    if (cfg.au !== undefined && cfg.au > 0) return cfg.au * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
    if (cfg.semiMajorAxis !== undefined && cfg.semiMajorAxis > 0) return cfg.semiMajorAxis * SIMULATION_CONSTANTS.MOON_VISUAL_SCALE;
    if (cfg.relativeAu !== undefined && cfg.relativeAu > 0) {
      return cfg.relativeAu * SIMULATION_CONSTANTS.MOON_VISUAL_SCALE * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
    }
    return SIMULATION_CONSTANTS.MOON_DEFAULT_RADIUS;
  }

  /** Local orbital position for a true anomaly (radians). */
  positionForAngle(nu: number, target = new THREE.Vector3()): THREE.Vector3 {
    const cfg = this.config;
    const p = orbitalPosition(this.getSemiMajorAxis(), cfg.eccentricity ?? 0, nu, cfg.inclination ?? 0, cfg.longitudeOfPerihelion ?? 0, cfg.longitudeOfAscendingNode ?? 0);
    return target.set(p.x, p.y, p.z);
  }

  /** Predicted local position at a timestamp, using the same Kepler model as the server. */
  calculatePositionAt(targetMs: number): THREE.Vector3 {
    return this.positionForAngle(trueAnomalyAt({ ...this.config, period: this.config.period || 365.25 }, targetMs));
  }

  /** Place the body at true anomaly `rad` (radians, normalised to [0, 2π)). */
  setAngle(rad: number): void {
    this.currentAngle = ((rad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    this.positionForAngle(this.currentAngle, this.orbitalGroup.position);
  }
}
