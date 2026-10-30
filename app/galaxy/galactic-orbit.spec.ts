import * as THREE from 'three';
import { J2000_MS } from '../../shared/orbital';
import { BlackHole, BLACK_HOLE_RADIUS } from './black-hole';
import {
  GALACTIC_AXES, GALACTIC_COMPRESSION, GALACTIC_YEAR_MS, GALAXY_ORIENTATION, GalacticOrbit, REAL_GALACTIC_YEAR_MYR, SUN_ORBITAL_SPEED_KM_S, galacticAngleAt,
} from './galactic-orbit';
import { GALAXY_SCALE } from './galaxy.factory';

describe('galactic orbit', () => {
  const deg = (rad: number) => (rad * 180) / Math.PI;
  /** Ecliptic longitude/latitude (degrees) of a scene-frame direction (+Y = ecliptic north, −Z = λ 90°). */
  const eclipticLonLat = (v: THREE.Vector3) => {
    const n = v.clone().normalize();
    return { lon: (deg(Math.atan2(-n.z, n.x)) + 360) % 360, lat: deg(Math.asin(n.y)) };
  };

  it('galacticAngleAt is 0 at J2000 and wraps once per period', () => {
    expect(galacticAngleAt(J2000_MS)).toBe(0);
    expect(galacticAngleAt(J2000_MS + GALACTIC_YEAR_MS / 4)).toBeCloseTo(Math.PI / 2, 9);
    expect(galacticAngleAt(J2000_MS + GALACTIC_YEAR_MS * 3.5)).toBeCloseTo(Math.PI, 9);
    expect(galacticAngleAt(J2000_MS - GALACTIC_YEAR_MS / 4)).toBeCloseTo((3 * Math.PI) / 2, 9);
    expect(galacticAngleAt(Number.NaN)).toBe(0);
    expect(galacticAngleAt(J2000_MS + 1000, 0)).toBe(0);
  });

  it('orients the galaxy as seen from Earth: centre in Sagittarius, plane 60° to the ecliptic', () => {
    const gc = eclipticLonLat(GALACTIC_AXES.center);
    expect(gc.lon).toBeCloseTo(266.84, 1);
    expect(gc.lat).toBeCloseTo(-5.54, 1);
    const ngp = eclipticLonLat(GALACTIC_AXES.northPole);
    expect(ngp.lon).toBeCloseTo(180.02, 1);
    expect(ngp.lat).toBeCloseTo(29.81, 1);
    const eclipticNorth = new THREE.Vector3(0, 1, 0);
    expect(deg(GALACTIC_AXES.northPole.angleTo(eclipticNorth))).toBeCloseTo(60.19, 1);
    // The galaxy model's local axes map onto those directions.
    expect(new THREE.Vector3(-1, 0, 0).applyQuaternion(GALAXY_ORIENTATION).distanceTo(GALACTIC_AXES.center)).toBeLessThan(1e-9);
    expect(new THREE.Vector3(0, -1, 0).applyQuaternion(GALAXY_ORIENTATION).distanceTo(GALACTIC_AXES.northPole)).toBeLessThan(1e-9);
    expect(GALACTIC_AXES.northPole.clone().cross(GALACTIC_AXES.center).distanceTo(GALACTIC_AXES.rotation)).toBeLessThan(1e-6);
  });

  it('moves the Sun at its true speed toward Cygnus, clockwise seen from the north galactic pole', () => {
    const orbit = new GalacticOrbit();
    const p0 = orbit.starPositionAt(J2000_MS);
    const day = 86_400_000;
    const v = orbit.starPositionAt(J2000_MS + day).sub(p0); // units per day
    const kmPerS = (v.length() / 1496) * 149_597_870.7 / 86_400;
    expect(kmPerS).toBeGreaterThan(SUN_ORBITAL_SPEED_KM_S - 1);
    expect(kmPerS).toBeLessThan(SUN_ORBITAL_SPEED_KM_S + 1);
    const dir = eclipticLonLat(v);
    expect(Math.abs(dir.lon - 347.3)).toBeLessThan(2.5); // l ≈ 90°, b ≈ +1.7° (vertical motion)
    expect(Math.abs(dir.lat - 59.6)).toBeLessThan(2.5);
    // The core is toward Sagittarius from the Sun.
    expect(deg(p0.clone().negate().angleTo(GALACTIC_AXES.center))).toBeLessThan(0.2); // 20.8 pc above the plane → 0.15°
  });

  it('compresses the galaxy but keeps the real ratios of size and time', () => {
    expect(REAL_GALACTIC_YEAR_MYR).toBeGreaterThan(195);
    expect(REAL_GALACTIC_YEAR_MYR).toBeLessThan(210);
    expect(GALACTIC_YEAR_MS / (365.25 * 86_400_000)).toBeCloseTo(REAL_GALACTIC_YEAR_MYR * 1e6 * GALACTIC_COMPRESSION, 6);
  });

  it('bobs through the disk: 20.8 pc above the mid-plane now, rising', () => {
    const orbit = new GalacticOrbit();
    const h0 = orbit.heightAt(J2000_MS);
    expect(h0).toBeGreaterThan(0);
    expect(orbit.heightAt(J2000_MS + 86_400_000)).toBeGreaterThan(h0);
    const p = orbit.starPositionAt(J2000_MS);
    expect(p.dot(GALACTIC_AXES.northPole)).toBeCloseTo(h0, 6);
  });

  it('keeps every star on a circle around the core; random systems start from their galaxy position', () => {
    const orbit = new GalacticOrbit();
    orbit.setStart(10, { x: 1000, y: 0, z: 0 });
    const r = 10 * GALAXY_SCALE + 1000;
    expect(orbit.radius).toBeCloseTo(r, 6);
    for (const f of [0.1, 0.33, 0.8]) {
      const p = orbit.starPositionAt(J2000_MS + f * orbit.periodMs);
      const h = p.dot(GALACTIC_AXES.northPole);
      expect(p.clone().addScaledVector(GALACTIC_AXES.northPole, -h).length()).toBeCloseTo(r, 3);
    }
  });
});

describe('BlackHole', () => {
  it('builds horizon, accretion disk and a camera-facing photon ring', () => {
    const bh = new BlackHole();
    expect(bh.group.name).toBe('blackHole');
    expect((bh.horizon.geometry as THREE.SphereGeometry).parameters.radius).toBe(BLACK_HOLE_RADIUS);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 5000, 0);
    camera.updateMatrixWorld();
    bh.update(2, camera);
    expect((bh.disk.material as THREE.ShaderMaterial).uniforms['uTime'].value).toBe(2);
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(bh.billboard.quaternion);
    expect(normal.y).toBeCloseTo(1, 6);
    const parent = new THREE.Group();
    parent.add(bh.group);
    bh.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
