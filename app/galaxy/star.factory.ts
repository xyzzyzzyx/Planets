import { Injectable, inject } from '@angular/core';
import * as THREE from 'three';
import { J2000_MS } from '../../shared/orbital';
import { AssetTextureService, hasImage } from '../webgl/asset-texture.service';
import { CelestialFactory } from './celestial.factory';
import { CelestialBody, CometConfig, MoonConfig, PlanetConfig, RingConfig, SIMULATION_CONSTANTS, StarConfig, visualRadiusFor } from './celestial.model';
import { CometFactory } from './comet.factory';
import { MoonFactory } from './moon.factory';
import { PlanetFactory } from './planet.factory';
import { ECLIPTIC_NORTH, poleOrientation } from './rotation';
import { Star } from './star.model';

export const STAR_MIN_VISUAL_RADIUS = 10;

/** userData attached to every animated ring mesh. */
export interface RingUserData {
  rotate: boolean;
  angularSpeedRadPerMs: number;
  ringName: string;
  ownerName: string;
  /** Belt orbiting the star at its Keplerian rate; its angle is set from the simulation clock. */
  keplerian: boolean;
  /** Orientation before any rotation about the ring normal (used by Keplerian belts). */
  baseQuaternion: THREE.Quaternion;
}

export type RingMesh = (THREE.InstancedMesh | THREE.Mesh) & { userData: Partial<RingUserData> };

export type SatelliteConfig = (PlanetConfig | CometConfig) & { moons?: MoonConfig[] };

interface ParticleRingOptions {
  inner: number;
  outer: number;
  count: number;
  tiltDeg: number;
  /** Ring-plane normal; positive rotation about it is prograde. */
  pole: THREE.Vector3;
  thickness: number;
  color: string;
  textureUrl?: string;
  keplerian: boolean;
  parent: THREE.Object3D;
  angularSpeedRadPerMs?: number;
  particleSize?: number;
  name: string;
  ownerName: string;
}

/** Quaternion that lays a ring built in the XZ plane (normal +Y) into the plane whose normal is `pole`. */
function ringOrientation(pole: THREE.Vector3): THREE.Quaternion {
  return poleOrientation(pole);
}

/** Real kilometres per scene unit for bodies and their satellite systems (drawn 40× enlarged; 1 unit = 100,000 km at true scale). */
export const KM_PER_VISUAL_UNIT = 2500;
const G = 6.674e-11;

/** Keplerian rate (rad per simulated ms) of ring material at `radius` scene units around a planet of `massKg`. */
export function planetaryRingAngularSpeed(massKg: number, radius: number): number {
  const rMeters = radius * KM_PER_VISUAL_UNIT * 1000;
  return massKg > 0 && rMeters > 0 ? Math.sqrt((G * massKg) / rMeters ** 3) / 1000 : 0;
}

/** Rotation rate of a Keplerian belt at the given mean radius (scene units), rad per simulated ms. */
export function keplerianAngularSpeed(meanRadius: number): number {
  const au = meanRadius / SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
  const periodMs = Math.sqrt(au ** 3) * 365.25 * 86_400_000;
  return periodMs > 0 ? (2 * Math.PI) / periodMs : 0;
}

/**
 * Rotation (radians, [0, 2π)) of a Keplerian belt at a simulated time. Absolute
 * rather than incremental, so belts keep pace with the planets at any speed and
 * land in the right place after a date jump.
 */
export function keplerianRingAngle(angularSpeedRadPerMs: number, timeMs: number): number {
  if (!Number.isFinite(angularSpeedRadPerMs) || !Number.isFinite(timeMs)) return 0;
  const turns = (angularSpeedRadPerMs * (timeMs - J2000_MS)) / (2 * Math.PI);
  return (turns - Math.floor(turns)) * 2 * Math.PI;
}

/**
 * Planetary ring radii are authored in visual units. Values that would sit
 * inside the planet are replaced with a sensible default band.
 */
export function safePlanetRingRadii(inner: number | undefined, outer: number | undefined, visualDiameter: number): [number, number] {
  const minSafeRadius = visualDiameter * 0.55;
  const i = inner ?? 0;
  const o = outer ?? 0;
  if (i <= minSafeRadius || o <= i) return [visualDiameter * 1.15, visualDiameter * 2.2];
  return [i, o];
}

/**
 * Builds the star (mesh + lights) and assembles the rest of the system:
 * planets with moons, comets, star belts and planetary rings. Animated ring
 * meshes are tracked in {@link StarFactory.keplerianRings} for the render loop.
 */
@Injectable({ providedIn: 'root' })
export class StarFactory extends CelestialFactory<StarConfig, Star> {
  private readonly textureService = inject(AssetTextureService);
  private readonly planetFactory = inject(PlanetFactory);
  private readonly cometFactory = inject(CometFactory);
  private readonly moonFactory = inject(MoonFactory);

  private readonly _animatedRings = new Set<RingMesh>();

  /** Ring meshes that rotate or animate each frame. */
  get keplerianRings(): ReadonlySet<RingMesh> {
    return this._animatedRings;
  }

  /** Forget all rings (call when a solar system is torn down). */
  clearRings(): void {
    this._animatedRings.clear();
  }

  async build(config: StarConfig): Promise<Star> {
    const [map] = await this.textureService.loadMultipleTextures([config.map]);
    const star = new Star(config);

    const visualRadius = visualRadiusFor(config.diameter || 10, STAR_MIN_VISUAL_RADIUS);
    star.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(visualRadius, config.widthSegments || 128, config.heightSegments || 128),
      new THREE.MeshPhongMaterial({
        color: new THREE.Color(hasImage(map) ? 0xffeecc : config.color || 0xffeecc),
        map: hasImage(map) ? map : null,
        emissive: new THREE.Color(config.color || 0xffaa00),
        emissiveIntensity: 0.9,
        shininess: 0,
      }),
    );
    star.mesh.name = config.name || 'Sun';
    star.group.add(star.mesh);

    star.highlight = this.createHighlight(visualRadius * 1.18, 0xffdd44, 0.55, 48);
    star.group.add(star.highlight);

    const sunLight = new THREE.PointLight(0xffffff, 4.0, 0, 2);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    star.group.add(sunLight);
    star.lights.push(sunLight);

    const ambient = new THREE.AmbientLight(0xaaaaaa, 0.6);
    star.group.add(ambient);
    star.lights.push(ambient);

    star.applyInitialTilt();

    star.latLongGroup = this.createLatLongLines(visualRadius);
    star.mesh.add(star.latLongGroup);
    this.createMagneticField(star, star.group);

    return star;
  }

  /** Build planets (with their moons) and comets and attach them to the star. */
  async attachSatellites(star: Star, satelliteConfigs: readonly SatelliteConfig[]): Promise<void> {
    for (const config of satelliteConfigs) {
      if (!config?.name || (config.type as string) === 'star') continue;
      try {
        if (config.type === 'comet') {
          star.addSatellite(await this.cometFactory.build(config));
          continue;
        }
        const planet = await this.planetFactory.build(config as PlanetConfig);
        star.addSatellite(planet);
        for (const moonConfig of Array.isArray(config.moons) ? config.moons : []) {
          planet.addSatellite(await this.moonFactory.build(moonConfig));
        }
      } catch (err) {
        console.warn(`[StarFactory] Skipping "${config.name}":`, err);
      }
    }
  }

  /** Build the star's belts and every planet's rings. */
  async attachRings(star: Star, ringConfigs: readonly RingConfig[]): Promise<void> {
    if (!star.ringGroup) {
      star.ringGroup = new THREE.Group();
      star.ringGroup.name = `${star.name}_rings`;
      star.group.add(star.ringGroup);
    }

    for (const ring of ringConfigs) {
      if (!ring?.name) continue;
      const inner = Math.max(0.1, ring.inner ?? 0);
      const outer = Math.max(inner + 1, ring.outer ?? inner + 100);
      const keplerian = ring.keplerianRotation === true;

      if ((ring.particleCount ?? 0) > 0) {
        const zones = keplerian ? 3 : 1;
        const zoneCount = Math.ceil(ring.particleCount! / zones);
        const width = (outer - inner) / zones;
        for (let z = 0; z < zones; z++) {
          await this.buildParticleRing({
            inner: inner + z * width,
            outer: inner + (z + 1) * width,
            count: zoneCount,
            tiltDeg: ring.tilt ?? 0,
            pole: ECLIPTIC_NORTH, // belts lie in the planets' plane (not the Sun's 7.25°-tilted equator)
            thickness: ring.thickness ?? 0.4,
            color: ring.color ?? '#b0a090',
            textureUrl: ring.texture,
            keplerian,
            parent: star.ringGroup,
            particleSize: ring.particleSize,
            name: zones > 1 ? `ring_${ring.name}_zone${z + 1}` : `ring_${ring.name}`,
            ownerName: star.name,
          });
        }
      } else {
        const mesh = this.buildWasher(inner, outer, ECLIPTIC_NORTH, ring.color ?? '#b0a090', ring.texture);
        mesh.name = `ring_${ring.name}_washer`;
        mesh.userData = { ...mesh.userData, ringName: ring.name, ownerName: star.name };
        star.ringGroup.add(mesh);
      }
    }

    for (const body of star.satellites) await this.attachPlanetRings(body);
  }

  private async attachPlanetRings(planet: CelestialBody): Promise<void> {
    const cfg = planet.config as PlanetConfig;
    const rings = Array.isArray(cfg.rings) ? cfg.rings : [];
    if (rings.length === 0 || !('orbitalGroup' in planet)) return;

    const orbitalGroup = (planet as CelestialBody & { orbitalGroup: THREE.Group }).orbitalGroup;
    if (!planet.ringGroup) {
      planet.ringGroup = new THREE.Group();
      planet.ringGroup.name = `${planet.name}_rings`;
      orbitalGroup.add(planet.ringGroup);
    }
    const visualDiameter = (cfg.diameter ?? 2) * SIMULATION_CONSTANTS.VISUAL_SCALE;

    for (const ring of rings) {
      if (!ring?.name) continue;
      const [inner, outer] = safePlanetRingRadii(ring.inner, ring.outer, visualDiameter);
      // Ring material orbits at the Keplerian rate for the planet's mass (in the
      // direction the planet spins); without a mass, fall back to the authored visual spin.
      const keplerian = planet.mass > 1e20; // a real planetary mass (kg)
      const angularSpeed = keplerian ? planetaryRingAngularSpeed(planet.mass, (inner + outer) / 2) : (ring.rotationSpeed ?? 0.005) / 1000;
      // Rings lie in the planet's equatorial plane.
      if ((ring.particleCount ?? 0) > 0) {
        const zones = keplerian ? 3 : 1;
        const width = (outer - inner) / zones;
        for (let z = 0; z < zones; z++) {
          const zi = inner + z * width;
          const zo = zi + width;
          await this.buildParticleRing({
            inner: zi, outer: zo, count: Math.ceil(ring.particleCount! / zones), tiltDeg: ring.tilt ?? 0, pole: planet.spinPole,
            thickness: ring.thickness ?? 0.02, color: ring.color ?? '#e8d8b0', textureUrl: ring.texture,
            keplerian, parent: planet.ringGroup,
            angularSpeedRadPerMs: keplerian ? planetaryRingAngularSpeed(planet.mass, (zi + zo) / 2) : angularSpeed,
            particleSize: ring.particleSize,
            name: zones > 1 ? `ring_${ring.name}_zone${z + 1}` : `ring_${ring.name}`, ownerName: planet.name,
          });
        }
      } else {
        const washer = this.buildWasher(inner, outer, planet.spinPole, ring.color ?? '#e8d8b0', ring.texture, angularSpeed);
        washer.name = `ring_${ring.name}_washer`;
        washer.userData = { ...washer.userData, ringName: ring.name, ownerName: planet.name };
        planet.ringGroup.add(washer);
      }
    }
  }

  private async buildParticleRing(o: ParticleRingOptions): Promise<RingMesh | null> {
    const texture = o.textureUrl ? await this.textureService.load(o.textureUrl) : null;
    const hasTexture = hasImage(texture);

    // ShaderMaterial already declares position/normal/uv/instanceMatrix.
    const vertexShader = /* glsl */ `
      uniform float uTime;
      uniform float uVibrationTime;
      uniform float uVibrationStrength;
      uniform float uOuterRadius;
      ${hasTexture ? 'varying vec2 vUv;' : ''}

      float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      vec3 randomVector(vec3 p) {
        return vec3(hash(p), hash(p + vec3(1.0, 0.0, 0.0)), hash(p + vec3(2.0, 0.0, 0.0))) * 2.0 - 1.0;
      }

      void main() {
        vec3 pos = position;
        vec3 noisePos = pos * 0.5;
        float t = uTime * 1.5;
        vec3 offset = randomVector(floor(noisePos * 10.0)) * 0.4;
        offset += sin(noisePos * 5.0 + t) * 0.1;
        offset += cos(noisePos.yzx * 3.0 - t * 1.3) * 0.1;
        pos += offset;

        vec3 instancePos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float ringRadius = length(instancePos);
        float angle = atan(instancePos.z, instancePos.x);

        pos += normal * (sin(angle * 8.0 + uTime * 25.0) * 0.15 * (ringRadius / uOuterRadius));
        float undulation = sin(angle * 3.0 + uTime * 8.0) * 0.3 * (1.0 - ringRadius / uOuterRadius);
        pos.x += undulation * cos(angle);
        pos.z += undulation * sin(angle);
        pos += normal * (sin(angle * 12.0 + uVibrationTime * 35.0) * uVibrationStrength * (ringRadius / uOuterRadius) * 0.6);

        ${hasTexture ? 'vUv = uv;' : ''}
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(pos, 1.0);
      }
    `;
    const fragmentShader = /* glsl */ `
      uniform vec3 uColor;
      ${hasTexture ? 'uniform sampler2D uTexture; varying vec2 vUv;' : ''}
      void main() {
        ${hasTexture ? 'gl_FragColor = texture2D(uTexture, vUv) * vec4(uColor, 0.9);' : 'gl_FragColor = vec4(uColor, 0.9);'}
      }
    `;

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(o.color) },
        uVibrationTime: { value: 0 },
        uVibrationStrength: { value: 0 },
        uOuterRadius: { value: o.outer },
        ...(hasTexture ? { uTexture: { value: texture } } : {}),
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const tiltRad = (o.tiltDeg * Math.PI) / 180;
    const cosT = Math.cos(tiltRad);
    const sinT = Math.sin(tiltRad);
    const span = o.outer - o.inner;

    const count = Math.max(0, Math.floor(o.count));
    if (count === 0) return null;

    let particleRadius = o.particleSize || (o.keplerian ? Math.min(12, span * 0.008) : Math.min(4, span * 0.004));
    particleRadius = Math.max(0.2, particleRadius);

    const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(particleRadius, 5, 5), material, count);
    mesh.name = o.name;
    mesh.quaternion.copy(ringOrientation(o.pole));
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;

    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * 2 * Math.PI;
      const r = o.inner + Math.sqrt(Math.random()) * span;
      const rj = r + (Math.random() - 0.5) * span * 0.04;
      const y = o.keplerian
        ? (Math.random() + Math.random() - 1) * o.thickness * rj * 0.3
        : Math.sin(angle * 6) * o.thickness * rj * 0.12;
      const x = rj * Math.cos(angle);
      const z = rj * Math.sin(angle);
      dummy.position.set(x, y * cosT - z * sinT, y * sinT + z * cosT);
      dummy.scale.setScalar(0.4 + Math.random() * 1.8);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;

    const speed = o.angularSpeedRadPerMs ?? (o.keplerian ? keplerianAngularSpeed((o.inner + o.outer) / 2) : 0);
    mesh.userData = {
      rotate: speed > 0, angularSpeedRadPerMs: speed, ringName: o.name.replace(/^ring_/, ''), ownerName: o.ownerName,
      ...(o.keplerian ? { keplerian: true, baseQuaternion: mesh.quaternion.clone() } : {}),
    };
    const ringMesh = mesh as RingMesh;
    this._animatedRings.add(ringMesh); // always tracked so shader time uniforms advance

    o.parent.add(mesh);
    return ringMesh;
  }

  private buildWasher(inner: number, outer: number, pole: THREE.Vector3, color: string, texture?: string, angularSpeedRadPerMs?: number): RingMesh {
    const safeInner = Math.max(0.1, inner);
    const safeOuter = Math.max(safeInner + 0.1, outer);

    const geom = new THREE.RingGeometry(safeInner, safeOuter, 128);
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    const uv = geom.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      uv.setXY(i, (Math.hypot(x, y) - safeInner) / (safeOuter - safeInner), (Math.atan2(y, x) / (2 * Math.PI) + 1) % 1);
    }
    uv.needsUpdate = true;
    // RingGeometry is built in the XY plane; lay it flat in the equatorial XZ plane.
    geom.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color), side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false });
    if (texture?.trim()) {
      void this.textureService.load(texture).then((t) => {
        if (hasImage(t)) { mat.map = t; mat.needsUpdate = true; }
      });
    }

    const mesh = new THREE.Mesh(geom, mat) as RingMesh;
    mesh.quaternion.copy(ringOrientation(pole));
    mesh.renderOrder = 5;
    if (angularSpeedRadPerMs && angularSpeedRadPerMs > 0) {
      mesh.userData = { rotate: true, angularSpeedRadPerMs };
      this._animatedRings.add(mesh);
    }
    return mesh;
  }
}
