import * as THREE from 'three';
import { trueAnomalyAt } from '../../../shared/orbital';
import { CelestialBody, OrbitingBody } from '../../galaxy/celestial.model';
import { Moon } from '../../galaxy/moon.model';
import type { Star } from '../../galaxy/star.model';

/** Star position relative to the galactic core at a simulated time. */
export type GalacticPositionFn = (timeMs: number, target: THREE.Vector3) => THREE.Vector3;

/** Samples taken per revolution of a body around its parent. */
export const TRACER_SAMPLES_PER_ORBIT = 96;
/** Samples per galactic revolution: the spacing cap for slow or stationary bodies (and the star itself). */
export const TRACER_GALACTIC_SAMPLES = 720;
/** Length of each trail, in samples (≈ 6 orbits for planets and moons). */
export const TRACER_MAX_POINTS = 600;
/** Upper bound on new samples per body per update; larger gaps (very high speeds) are spread over this many. */
export const TRACER_MAX_SAMPLES_PER_UPDATE = 64;

interface Trail {
  readonly body: CelestialBody;
  readonly isMoon: boolean;
  /** Orbiting bodies from the star's first satellite down to `body` (positions add up along this chain). */
  readonly chain: readonly OrbitingBody[];
  readonly intervalMs: number;
  readonly line: THREE.Line;
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  readonly times: Float64Array;
  readonly color: THREE.Color;
  count: number;
  coloredCount: number;
}

/**
 * "Tracer": fading lines behind every celestial body showing the path it has
 * travelled through space. Trails live in the galactic frame (the parent group
 * is placed at the galactic core), so as the system circles the black hole the
 * star leaves an arc and the planets and moons leave helices around it.
 *
 * Positions are sampled analytically from the shared Kepler model at evenly
 * spaced simulated times, so trails stay smooth at any simulation speed and
 * can be back-filled instantly when first shown or after a time jump.
 */
export class Tracer {
  readonly group = new THREE.Group();
  private trails: Trail[] = [];
  private moonsIncluded = false;
  private readonly galacticPeriodMs: () => number;
  private readonly tmp = new THREE.Vector3();
  private readonly local = new THREE.Vector3();
  private readonly frame = new THREE.Quaternion();

  constructor(
    parent: THREE.Object3D,
    private readonly galacticPositionAt: GalacticPositionFn,
    galacticPeriodMs: number | (() => number),
  ) {
    this.galacticPeriodMs = typeof galacticPeriodMs === 'function' ? galacticPeriodMs : () => galacticPeriodMs;
    this.group.name = 'tracers';
    this.group.visible = false;
    parent.add(this.group);
  }

  get visible(): boolean {
    return this.group.visible;
  }

  /** Show or hide the trails. Hiding forgets the samples; showing back-fills them from the orbit model. */
  setVisible(visible: boolean): void {
    this.group.visible = visible;
    if (!visible) for (const trail of this.trails) trail.count = 0;
  }

  /** Whether moons get trails too (dozens of small loops around the giant planets; off by default). */
  get includeMoons(): boolean {
    return this.moonsIncluded;
  }

  setIncludeMoons(include: boolean): void {
    this.moonsIncluded = include;
    for (const trail of this.trails) {
      if (!trail.isMoon) continue;
      trail.line.visible = include;
      if (!include) trail.count = 0;
    }
  }

  get trailCount(): number {
    return this.trails.length;
  }

  /** Number of samples (excluding the live head vertex) currently in a body's trail. */
  sampleCount(name: string): number {
    return this.trails.find((t) => t.body.name === name)?.count ?? 0;
  }

  /** The trail line for a body, if any. */
  lineFor(name: string): THREE.Line | undefined {
    return this.trails.find((t) => t.body.name === name)?.line;
  }

  /** Create one trail for the star and each of its descendants. */
  attach(star: Star): void {
    this.detach();
    this.trails.push(this.createTrail(star, [], star.config.color || '#ffcc44', 1));
    const visit = (body: CelestialBody, chain: OrbitingBody[]): void => {
      if (!(body instanceof OrbitingBody)) return;
      const next = [...chain, body];
      this.trails.push(this.createTrail(body, next, body.config.color || '#aaaaff', body instanceof Moon ? 0.55 : 0.9));
      for (const sat of body.satellites) visit(sat, next);
    };
    for (const sat of star.satellites) visit(sat, []);
  }

  /** Remove every trail (the system was torn down). */
  detach(): void {
    for (const trail of this.trails) {
      trail.line.removeFromParent();
      trail.line.geometry.dispose();
      (trail.line.material as THREE.Material).dispose();
    }
    this.trails = [];
  }

  /** Extend every trail up to `timeMs` (no-op while hidden). */
  update(timeMs: number): void {
    if (!this.group.visible || !Number.isFinite(timeMs)) return;
    for (const trail of this.trails) if (!trail.isMoon || this.moonsIncluded) this.step(trail, timeMs);
  }

  dispose(): void {
    this.detach();
    this.group.removeFromParent();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private createTrail(body: CelestialBody, chain: OrbitingBody[], color: string, intensity: number): Trail {
    const galacticInterval = this.galacticPeriodMs() / TRACER_GALACTIC_SAMPLES;
    const periodMs = (body instanceof OrbitingBody ? body.config.period ?? 0 : 0) * 86_400_000;
    const intervalMs = periodMs > 0 ? Math.min(periodMs / TRACER_SAMPLES_PER_ORBIT, galacticInterval) : galacticInterval;

    const positions = new Float32Array((TRACER_MAX_POINTS + 1) * 3);
    const colors = new Float32Array((TRACER_MAX_POINTS + 1) * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setDrawRange(0, 0);
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    line.name = `${body.name}_tracer`;
    line.frustumCulled = false;
    const isMoon = body instanceof Moon;
    line.visible = !isMoon || this.moonsIncluded;
    this.group.add(line);

    return {
      body, isMoon, chain, intervalMs, line, positions, colors,
      times: new Float64Array(TRACER_MAX_POINTS),
      color: new THREE.Color(color).multiplyScalar(intensity),
      count: 0, coloredCount: -1,
    };
  }

  /** Galactic-frame position of a trail's body at `timeMs`, from the Kepler model. */
  private positionAt(trail: Trail, timeMs: number, target: THREE.Vector3): THREE.Vector3 {
    this.galacticPositionAt(timeMs, target);
    for (const body of trail.chain) {
      if ((body.config.period ?? 0) > 0) body.positionForAngle(trueAnomalyAt(body.config, timeMs), this.local);
      else this.local.copy(body.orbitalGroup.position);
      target.add(this.local.applyQuaternion(body.orbitFrameAt(timeMs, this.frame)));
    }
    return target;
  }

  /** Galactic-frame position of the body as currently drawn (the trail's live head). */
  private headPosition(trail: Trail, timeMs: number, target: THREE.Vector3): THREE.Vector3 {
    this.galacticPositionAt(timeMs, target);
    for (const body of trail.chain) target.add(this.local.copy(body.orbitalGroup.position).applyQuaternion(body.group.quaternion));
    return target;
  }

  private writeSample(trail: Trail, timeMs: number): void {
    const i = trail.count;
    const p = this.positionAt(trail, timeMs, this.tmp);
    trail.positions[i * 3] = p.x;
    trail.positions[i * 3 + 1] = p.y;
    trail.positions[i * 3 + 2] = p.z;
    trail.times[i] = timeMs;
    trail.count++;
  }

  private backfill(trail: Trail, timeMs: number): void {
    trail.count = 0;
    for (let i = TRACER_MAX_POINTS - 1; i >= 0; i--) this.writeSample(trail, timeMs - i * trail.intervalMs);
  }

  private step(trail: Trail, timeMs: number): void {
    // Time ran backwards: rewind the trail.
    while (trail.count > 0 && trail.times[trail.count - 1] > timeMs) trail.count--;

    if (trail.count === 0) {
      this.backfill(trail, timeMs);
    } else {
      const last = trail.times[trail.count - 1];
      const gap = timeMs - last;
      let n = Math.floor(gap / trail.intervalMs);
      if (n > 0) {
        let dt = trail.intervalMs;
        if (n > TRACER_MAX_SAMPLES_PER_UPDATE) {
          n = TRACER_MAX_SAMPLES_PER_UPDATE;
          dt = gap / n;
        }
        const overflow = trail.count + n - TRACER_MAX_POINTS;
        if (overflow > 0) {
          trail.positions.copyWithin(0, overflow * 3, trail.count * 3);
          trail.times.copyWithin(0, overflow, trail.count);
          trail.count -= overflow;
        }
        for (let j = 1; j <= n; j++) this.writeSample(trail, last + j * dt);
      }
    }

    // Live head: exactly where the body is drawn now.
    const head = this.headPosition(trail, timeMs, this.tmp);
    const h = trail.count * 3;
    trail.positions[h] = head.x;
    trail.positions[h + 1] = head.y;
    trail.positions[h + 2] = head.z;

    if (trail.coloredCount !== trail.count) this.colorize(trail);
    const geometry = trail.line.geometry;
    geometry.setDrawRange(0, trail.count + 1);
    (geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Fade from black (tail) to the body's colour (head); additive blending turns black into transparent. */
  private colorize(trail: Trail): void {
    const n = trail.count + 1;
    const { r, g, b } = trail.color;
    for (let i = 0; i < n; i++) {
      const f = n > 1 ? i / (n - 1) : 1;
      const a = f * f;
      trail.colors[i * 3] = r * a;
      trail.colors[i * 3 + 1] = g * a;
      trail.colors[i * 3 + 2] = b * a;
    }
    trail.coloredCount = trail.count;
    (trail.line.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }
}
