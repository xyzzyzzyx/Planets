import * as THREE from 'three';
import { orbitalPosition, trueAnomalyAt } from '../../shared/orbital';
import { disposeObject3D } from '../webgl/dispose';

export const SIMULATION_CONSTANTS = {
  VISUAL_SCALE: 4,
  SCALE_UNITS_PER_AU: 1496,
  MOON_VISUAL_SCALE: 30,
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
  /** Degrees. */
  longitudeOfPerihelion?: number;
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

export interface MoonConfig extends CelestialConfig, OrbitalConfig { }

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

/**
 * Base class for every rendered body. Scene graph:
 *   group                      (positioned by the parent; holds satellites for stars)
 *     └─ mesh, highlight, …    (spun by rotate())
 * Orbiting bodies add an `orbitalGroup` that is moved along the orbit.
 */
export abstract class CelestialBody {
  readonly type: BodyType;
  readonly name: string;
  readonly config: CelestialConfig;
  mass = 0;
  axis: THREE.Vector3;
  spin: number;
  mesh!: THREE.Mesh;
  clouds?: THREE.Mesh;
  satellites: CelestialBody[] = [];
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
    const tiltRad = ((config.tilt ?? 0) * Math.PI) / 180;
    this.axis = new THREE.Vector3(Math.cos(tiltRad), Math.sin(tiltRad), 0).normalize();
    this.spin = config.spin ?? 0.01;

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
    this.group.add(satellite.group);
  }

  /**
   * Spin the body and its clouds by one frame about the body's own (tilted)
   * axis. Rings are deliberately not touched here: the ring group is not
   * tilted, so spinning it would make tilted rings (Saturn, Uranus) precess
   * around the ecliptic normal. Rings rotate about their own normals in
   * `WebGl.renderFrame` instead.
   */
  rotate(): void {
    this.mesh?.rotateY(-this.spin);
    this.clouds?.rotateY(-(this.spin + Math.random() / 250));
  }

  updateHierarchy(simTime: number): void {
    this.rotate();
    for (const sat of this.satellites) sat.updateHierarchy(simTime);
  }

  applyInitialTilt(): void {
    if (!this.mesh) return;
    this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), this.axis);
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
    this.orbitalGroup.add(satellite.group);
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
    const p = orbitalPosition(this.getSemiMajorAxis(), cfg.eccentricity ?? 0, nu, cfg.inclination ?? 0, cfg.longitudeOfPerihelion ?? 0);
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
