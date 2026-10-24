import * as THREE from 'three';
import { orbitalPosition, trueAnomalyAt } from '../../shared/orbital';
import { MagneticField, PlanetConfig, SIMULATION_CONSTANTS, validateBodyConfig, visualRadiusFor } from './celestial.model';
import { Moon } from './moon.model';
import { Planet } from './planet.model';
import { Star } from './star.model';

const planet = (over: Partial<PlanetConfig> = {}) => new Planet({ name: 'P', type: 'planet', diameter: 2, au: 1, period: 365.25, ...over });

describe('helpers', () => {
  it('visualRadiusFor scales diameter and enforces a minimum', () => {
    expect(visualRadiusFor(10, 1)).toBe(10 * SIMULATION_CONSTANTS.VISUAL_SCALE / 2);
    expect(visualRadiusFor(0.1, 1)).toBe(1);
    expect(visualRadiusFor(undefined, 3)).toBe(3);
    expect(visualRadiusFor(-5, 2)).toBe(2);
  });

  it('validateBodyConfig rejects unusable configs', () => {
    expect(() => validateBodyConfig({ name: 'ok', diameter: 1 })).not.toThrow();
    expect(() => validateBodyConfig(null)).toThrow(/name required/);
    expect(() => validateBodyConfig({ name: 'x', diameter: 0 })).toThrow(/invalid diameter/);
    expect(() => validateBodyConfig({ name: 'x', diameter: NaN })).toThrow(/invalid diameter/);
    expect(() => validateBodyConfig({ name: 3, diameter: 1 })).toThrow();
  });

  it('MagneticField radius is a multiple of the body radius (default 5)', () => {
    expect(new MagneticField({ strength: 1, radius: 3 }, 10).getFieldRadius()).toBe(30);
    expect(new MagneticField({ strength: 1, radius: 0 }, 10).getFieldRadius()).toBe(50);
  });
});

describe('CelestialBody', () => {
  it('derives the pole from tilt (ecliptic north is −Y) and defaults spin', () => {
    expect(planet().pole.toArray()).toEqual([0, -1, 0]);
    const p = planet({ tilt: 90 });
    expect(p.pole.y).toBeCloseTo(0);
    expect(Math.abs(p.pole.z)).toBeCloseTo(1);
    expect(planet({ tilt: 30, spin: -0.1 }).spinPole.dot(planet({ tilt: 30 }).pole)).toBeCloseTo(-1); // retrograde
    expect(planet().spin).toBe(0.01);
    expect(planet({ spin: 0.5 }).spin).toBe(0.5);
  });

  it('only creates a magnetic field when configured (previously crashed on undefined config)', () => {
    expect(planet().magneticField).toBeUndefined();
    expect(planet({ magneticField: { strength: 1, radius: 2 } }).magneticField?.getFieldRadius()).toBeCloseTo(2 * 2 * 2);
  });

  it('names groups and tags them with the owning body', () => {
    const p = planet();
    expect(p.group.name).toBe('P_group');
    expect(p.orbitalGroup.name).toBe('P_orbitalGroup');
    expect(p.group.userData['body']).toBe(p);
  });

  it('rotate() spins the mesh but leaves the ring group alone; tolerates missing parts', () => {
    const p = planet({ spin: 0.1 });
    expect(() => p.rotate()).not.toThrow();
    p.mesh = new THREE.Mesh();
    p.ringGroup = new THREE.Group();
    p.rotate();
    expect(p.mesh.rotation.y).toBeCloseTo(0.1); // positive about the (north) pole = prograde
    expect(p.ringGroup.rotation.y).toBe(0);
  });

  it('a tilted ring keeps its plane while the body spins (no precession)', () => {
    const p = planet({ spin: 0.3, tilt: 60 });
    p.mesh = new THREE.Mesh();
    p.applyInitialTilt();
    p.ringGroup = new THREE.Group();
    const ring = new THREE.Mesh();
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p.pole);
    p.ringGroup.add(ring);
    const normal = () => new THREE.Vector3(0, 1, 0).applyQuaternion(ring.getWorldQuaternion(new THREE.Quaternion()));
    const spinAxis = () => new THREE.Vector3(0, 1, 0).applyQuaternion(p.mesh.quaternion);
    const before = normal();
    for (let i = 0; i < 10; i++) p.rotate();
    expect(normal().angleTo(before)).toBeCloseTo(0, 6);
    expect(normal().angleTo(spinAxis())).toBeCloseTo(0, 6); // ring stays equatorial
  });

  it('applyInitialTilt puts the mesh north pole (+Y, the texture top) on the pole', () => {
    const p = planet({ tilt: 30 });
    p.mesh = new THREE.Mesh();
    p.applyInitialTilt();
    const y = new THREE.Vector3(0, 1, 0).applyQuaternion(p.mesh.quaternion);
    expect(y.distanceTo(p.pole)).toBeLessThan(1e-9);
  });

  it('iterates descendants depth-first and finds bodies by name', () => {
    const star = new Star({ name: 'Sun', type: 'star', diameter: 10 });
    const earth = planet({ name: 'Earth' });
    const moon = new Moon({ name: 'Moon', type: 'moon', diameter: 0.3, semiMajorAxis: 3, period: 27 });
    star.addSatellite(earth);
    earth.addSatellite(moon);
    expect([...star.descendants()].map((b) => b.name)).toEqual(['Sun', 'Earth', 'Moon']);
    expect(star.findBody('moon')).toBe(moon);
    expect(star.findBody('pluto')).toBeNull();
    expect(moon.group.parent).toBe(earth.orbitalGroup);
  });

  it('dispose() frees GPU resources and detaches the group', () => {
    const parent = new THREE.Group();
    const p = planet();
    p.mesh = new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshBasicMaterial());
    p.orbitalGroup.add(p.mesh);
    parent.add(p.group);
    const geo = vi.spyOn(p.mesh.geometry, 'dispose');
    const mat = vi.spyOn(p.mesh.material as THREE.Material, 'dispose');
    p.dispose();
    expect(geo).toHaveBeenCalled();
    expect(mat).toHaveBeenCalled();
    expect(p.group.parent).toBeNull();
  });
});

describe('OrbitingBody', () => {
  it('getSemiMajorAxis prefers au, then semiMajorAxis, then relativeAu, then a default', () => {
    expect(planet({ au: 2 }).getSemiMajorAxis()).toBe(2 * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU);
    expect(planet({ au: 0, semiMajorAxis: 3 }).getSemiMajorAxis()).toBe(3 * SIMULATION_CONSTANTS.MOON_VISUAL_SCALE);
    expect(planet({ au: 0, relativeAu: 0.01 }).getSemiMajorAxis()).toBeCloseTo(0.01 * SIMULATION_CONSTANTS.MOON_VISUAL_SCALE * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU);
    expect(planet({ au: 0 }).getSemiMajorAxis()).toBe(SIMULATION_CONSTANTS.MOON_DEFAULT_RADIUS);
  });

  it('setAngle places the orbital group on the (inclined, rotated) ellipse', () => {
    const p = planet({ au: 1, eccentricity: 0.2, inclination: 10, longitudeOfPerihelion: 45 });
    p.setAngle(1.3);
    const a = SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
    const expected = orbitalPosition(a, 0.2, 1.3, 10, 45);
    expect(p.orbitalGroup.position.x).toBeCloseTo(expected.x, 6);
    expect(p.orbitalGroup.position.y).toBeCloseTo(expected.y, 6);
    expect(p.orbitalGroup.position.z).toBeCloseTo(expected.z, 6);
  });

  it('setAngle normalises negative and large angles', () => {
    const p = planet();
    p.setAngle(-Math.PI / 2);
    expect(p.currentAngle).toBeCloseTo(1.5 * Math.PI);
    p.setAngle(5 * Math.PI);
    expect(p.currentAngle).toBeCloseTo(Math.PI);
  });

  it('calculatePositionAt agrees with setAngle(trueAnomalyAt) — same model as the server', () => {
    const cfg = { au: 1.52, period: 687, eccentricity: 0.0934, M0: 0.338, inclination: 1.85, longitudeOfPerihelion: 336 };
    const p = planet(cfg);
    const t = Date.UTC(2031, 4, 6);
    p.setAngle(trueAnomalyAt(cfg, t));
    expect(p.calculatePositionAt(t).distanceTo(p.orbitalGroup.position)).toBeLessThan(1e-6);
  });

  it('getWorldPosition follows the orbital group', () => {
    const p = planet({ au: 1 });
    p.setAngle(0);
    p.group.updateMatrixWorld(true);
    expect(p.getWorldPosition().x).toBeCloseTo(SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU * (1 - 0));
  });
});
