import * as THREE from 'three';
import { DAYS_PER_YEAR, MS_PER_DAY } from '../../../shared/orbital';
import { CometConfig, MoonConfig, PlanetConfig, StarConfig } from '../../galaxy/celestial.model';
import { Moon } from '../../galaxy/moon.model';
import { Planet } from '../../galaxy/planet.model';
import { Star } from '../../galaxy/star.model';
import { TRACER_MAX_POINTS, TRACER_MAX_SAMPLES_PER_UPDATE, Tracer } from './tracer';

const T0 = Date.UTC(2026, 9, 24);
const GALACTIC_PERIOD = 100 * DAYS_PER_YEAR * MS_PER_DAY;
const VELOCITY = new THREE.Vector3(10, 0, 0); // scene units per day along +X

function system() {
  const star = new Star({ name: 'Sun', type: 'star', diameter: 10 } as StarConfig);
  star.mesh = new THREE.Mesh();
  const earth = new Planet({ name: 'Earth', type: 'planet', diameter: 1, au: 1, period: 365.25, eccentricity: 0 } as PlanetConfig);
  const moon = new Moon({ name: 'Moon', type: 'moon', diameter: 0.3, period: 27.3, semiMajorAxis: 3.8 } as MoonConfig);
  const fixed = new Planet({ name: 'Fixed', type: 'planet', diameter: 1, au: 2, period: 0 } as CometConfig as PlanetConfig);
  star.addSatellite(earth);
  earth.addSatellite(moon);
  star.addSatellite(fixed);
  return { star, earth, moon, fixed };
}

function place(bodies: ReturnType<typeof system>, t: number) {
  for (const b of [bodies.earth, bodies.moon]) b.orbitalGroup.position.copy(b.calculatePositionAt(t));
}

describe('Tracer', () => {
  let parent: THREE.Group;
  let tracer: Tracer;
  const linear = (t: number, target: THREE.Vector3) => target.copy(VELOCITY).multiplyScalar((t - T0) / MS_PER_DAY);

  beforeEach(() => {
    parent = new THREE.Group();
    tracer = new Tracer(parent, linear, GALACTIC_PERIOD);
  });

  it('is hidden until shown and does nothing while hidden', () => {
    const s = system();
    tracer.attach(s.star);
    expect(tracer.visible).toBe(false);
    expect(tracer.trailCount).toBe(4); // star, Earth, Moon, Fixed
    tracer.update(T0);
    expect(tracer.sampleCount('Earth')).toBe(0);
  });

  it('back-fills full trails when shown, ending at the live body position', () => {
    const s = system();
    tracer.attach(s.star);
    tracer.setVisible(true);
    tracer.setIncludeMoons(true);
    place(s, T0);
    tracer.update(T0);
    for (const name of ['Sun', 'Earth', 'Moon', 'Fixed']) expect(tracer.sampleCount(name)).toBe(TRACER_MAX_POINTS);

    const line = tracer.lineFor('Moon')!;
    expect(line.geometry.drawRange.count).toBe(TRACER_MAX_POINTS + 1);
    const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    const head = new THREE.Vector3().fromBufferAttribute(pos, TRACER_MAX_POINTS);
    const expected = s.earth.orbitalGroup.position.clone().add(s.moon.orbitalGroup.position); // galactic offset is 0 at T0
    expect(head.distanceTo(expected)).toBeLessThan(1e-3);
    // The newest sample is at T0 too.
    expect(new THREE.Vector3().fromBufferAttribute(pos, TRACER_MAX_POINTS - 1).distanceTo(expected)).toBeLessThan(1e-3);
  });

  it("the star's trail follows its galactic motion and fades from tail to head", () => {
    const s = system();
    tracer.attach(s.star);
    tracer.setVisible(true);
    tracer.update(T0);
    const line = tracer.lineFor('Sun')!;
    const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    const intervalDays = GALACTIC_PERIOD / 720 / MS_PER_DAY;
    expect(pos.getX(0)).toBeCloseTo(-(TRACER_MAX_POINTS - 1) * intervalDays * 10, 0);
    expect(pos.getX(TRACER_MAX_POINTS)).toBeCloseTo(0, 6);
    const colors = line.geometry.getAttribute('color') as THREE.BufferAttribute;
    expect(colors.getX(0)).toBe(0);
    expect(colors.getX(TRACER_MAX_POINTS)).toBeGreaterThan(colors.getX(TRACER_MAX_POINTS / 2));
  });

  it('appends evenly spaced samples as time advances, keeping a fixed length', () => {
    const s = system();
    tracer.attach(s.star);
    tracer.setVisible(true);
    place(s, T0);
    tracer.update(T0);
    const pos = tracer.lineFor('Earth')!.geometry.getAttribute('position') as THREE.BufferAttribute;
    const before = new THREE.Vector3().fromBufferAttribute(pos, TRACER_MAX_POINTS - 1);
    const t1 = T0 + 10 * MS_PER_DAY; // Earth interval ≈ 3.8 days → 2 new samples
    place(s, t1);
    tracer.update(t1);
    expect(tracer.sampleCount('Earth')).toBe(TRACER_MAX_POINTS);
    expect(new THREE.Vector3().fromBufferAttribute(pos, TRACER_MAX_POINTS - 3).distanceTo(before)).toBeLessThan(1e-3);
  });

  it('caps the work per update at very high speeds', () => {
    const s = system();
    tracer.attach(s.star);
    tracer.setVisible(true);
    tracer.setIncludeMoons(true);
    tracer.update(T0);
    const t1 = T0 + 50 * DAYS_PER_YEAR * MS_PER_DAY;
    place(s, t1);
    tracer.update(t1);
    expect(tracer.sampleCount('Moon')).toBe(TRACER_MAX_POINTS);
    const pos = tracer.lineFor('Moon')!.geometry.getAttribute('position') as THREE.BufferAttribute;
    // The last capped sample lands exactly on t1.
    const expected = linear(t1, new THREE.Vector3()).add(s.earth.orbitalGroup.position).add(s.moon.orbitalGroup.position);
    expect(new THREE.Vector3().fromBufferAttribute(pos, TRACER_MAX_POINTS - 1).distanceTo(expected)).toBeLessThan(0.05);
    expect(TRACER_MAX_SAMPLES_PER_UPDATE).toBeLessThan(TRACER_MAX_POINTS);
  });

  it('leaves moons out unless included', () => {
    const s = system();
    tracer.attach(s.star);
    tracer.setVisible(true);
    tracer.update(T0);
    expect(tracer.includeMoons).toBe(false);
    expect(tracer.lineFor('Moon')!.visible).toBe(false);
    expect(tracer.sampleCount('Moon')).toBe(0);
    expect(tracer.sampleCount('Earth')).toBe(TRACER_MAX_POINTS);
    tracer.setIncludeMoons(true);
    tracer.update(T0);
    expect(tracer.lineFor('Moon')!.visible).toBe(true);
    expect(tracer.sampleCount('Moon')).toBe(TRACER_MAX_POINTS);
    tracer.setIncludeMoons(false);
    expect(tracer.sampleCount('Moon')).toBe(0);
  });

  it('rewinds when time runs backwards and back-fills when emptied', () => {
    const s = system();
    tracer.attach(s.star);
    tracer.setVisible(true);
    tracer.update(T0);
    tracer.update(T0 - 20 * MS_PER_DAY);
    expect(tracer.sampleCount('Earth')).toBe(TRACER_MAX_POINTS - Math.ceil(20 / (365.25 / 96)));
    tracer.update(T0 - 10 * DAYS_PER_YEAR * MS_PER_DAY); // beyond the whole trail
    expect(tracer.sampleCount('Earth')).toBe(TRACER_MAX_POINTS);
  });

  it('hiding forgets samples; detach and dispose release the lines', () => {
    const s = system();
    tracer.attach(s.star);
    tracer.setVisible(true);
    tracer.update(T0);
    tracer.setVisible(false);
    expect(tracer.sampleCount('Earth')).toBe(0);
    const line = tracer.lineFor('Earth')!;
    const spy = vi.spyOn(line.geometry, 'dispose');
    tracer.detach();
    expect(spy).toHaveBeenCalled();
    expect(tracer.trailCount).toBe(0);
    tracer.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
