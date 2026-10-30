import { TestBed } from '@angular/core/testing';
import * as THREE from 'three';
import { EARTH, HALLEY, SATURN, SUN, fakeTextureLoader } from '../testing/fakes';
import { AssetTextureService } from '../webgl/asset-texture.service';
import { PlanetConfig, StarConfig } from './celestial.model';
import { Comet } from './comet.model';
import { MOON_MIN_VISUAL_RADIUS, MoonFactory } from './moon.factory';
import { PLANET_MIN_VISUAL_RADIUS, PlanetFactory } from './planet.factory';
import { RingMesh, STAR_MIN_VISUAL_RADIUS, SatelliteConfig, StarFactory, keplerianAngularSpeed, safePlanetRingRadii } from './star.factory';
import { Planet } from './planet.model';

const cfg = <T>(body: object) => structuredClone(body) as T;
const radiusOf = (mesh: THREE.Mesh) => (mesh.geometry as THREE.SphereGeometry).parameters.radius;

describe('body factories', () => {
  let textures: AssetTextureService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    textures = TestBed.inject(AssetTextureService);
    textures.loader = fakeTextureLoader();
  });

  describe('PlanetFactory', () => {
    it('builds mesh, highlight, clouds and lat/long grid', async () => {
      const planet = await TestBed.inject(PlanetFactory).build({
        ...cfg<PlanetConfig>(EARTH), map: '/a.png', cloudMap: '/c.png', alphaMap: '/missing.png', atmosphere: 0.0075,
      });
      expect(planet.mesh.name).toBe('Earth');
      expect((planet.mesh.material as THREE.MeshPhongMaterial).map).toBeTruthy();
      expect(planet.highlight.visible).toBe(false);
      expect(planet.clouds).toBeDefined();
      expect((planet.clouds!.material as THREE.MeshPhongMaterial).alphaMap).toBeNull();
      expect(radiusOf(planet.clouds!)).toBeGreaterThan(radiusOf(planet.mesh));
      expect(planet.latLongGroup?.visible).toBe(false);
      expect(planet.mass).toBeCloseTo(5.97e24, -20);
      expect(planet.orbitalGroup.children).toContain(planet.mesh);
    });

    it('enforces a minimum visual radius and falls back to an emissive colour without textures', async () => {
      const planet = await TestBed.inject(PlanetFactory).build({ name: 'Tiny', type: 'planet', diameter: 0.01, color: '#ff0000' });
      expect(radiusOf(planet.mesh)).toBe(PLANET_MIN_VISUAL_RADIUS);
      const mat = planet.mesh.material as THREE.MeshPhongMaterial;
      expect(mat.map).toBeNull();
      expect(mat.emissive.r).toBeGreaterThan(0);
      expect(planet.clouds).toBeUndefined();
    });

    it('creates a (hidden) magnetic field only when configured', async () => {
      const factory = TestBed.inject(PlanetFactory);
      const withField = await factory.build({ ...cfg<PlanetConfig>(EARTH), magneticField: { strength: 1, radius: 8, polarity: -1 } });
      expect(withField.magneticFieldGroup?.visible).toBe(false);
      expect(withField.magneticFieldGroup?.children.length).toBeGreaterThan(1);
      const without = await factory.build(cfg<PlanetConfig>(EARTH));
      expect(without.magneticFieldGroup).toBeUndefined();
    });
  });

  it('MoonFactory applies its own minimum radius', async () => {
    const moon = await TestBed.inject(MoonFactory).build({ name: 'Pebble', type: 'moon', diameter: 0.001, semiMajorAxis: 2, period: 1 });
    expect(radiusOf(moon.mesh)).toBe(MOON_MIN_VISUAL_RADIUS);
    expect(moon.mass).toBe(1);
  });

  describe('StarFactory', () => {
    let factory: StarFactory;
    beforeEach(() => { factory = TestBed.inject(StarFactory); });

    it('builds a lit star with highlight and minimum radius', async () => {
      const star = await factory.build({ name: 'Dwarf', type: 'star', diameter: 0.5 });
      expect(radiusOf(star.mesh)).toBe(STAR_MIN_VISUAL_RADIUS);
      expect(star.lights.some((l) => l instanceof THREE.PointLight)).toBe(true);
      expect(star.group.children).toContain(star.highlight);
    });

    it('attaches planets with moons and recognises comets by type (not by name)', async () => {
      const star = await factory.build(cfg<StarConfig>(SUN));
      const strangeComet = { ...HALLEY, name: 'NotHalley' };
      await factory.attachSatellites(star, [
        cfg<SatelliteConfig>(EARTH), cfg<SatelliteConfig>(strangeComet), cfg<SatelliteConfig>(SUN), { name: '' } as SatelliteConfig,
      ]);
      expect(star.satellites.map((s) => s.name)).toEqual(['Earth', 'NotHalley']);
      expect(star.satellites[1]).toBeInstanceOf(Comet);
      expect(star.satellites[0].satellites.map((m) => m.name)).toEqual(['Moon']);
    });

    it('skips a satellite whose build fails instead of aborting the system', async () => {
      const star = await factory.build(cfg<StarConfig>(SUN));
      vi.spyOn(TestBed.inject(PlanetFactory), 'build').mockRejectedValueOnce(new Error('boom'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await factory.attachSatellites(star, [cfg<SatelliteConfig>(EARTH), cfg<SatelliteConfig>(SATURN)]);
      expect(star.satellites.map((s) => s.name)).toEqual(['Saturn']);
      expect(warn).toHaveBeenCalled();
    });

    it('builds belts and planetary rings (awaited) and tracks them for animation', async () => {
      const star = await factory.build(cfg<StarConfig>(SUN));
      await factory.attachSatellites(star, [cfg<SatelliteConfig>(SATURN)]);
      await factory.attachRings(star, cfg<StarConfig>(SUN).rings!);

      const names: string[] = [];
      star.group.traverse((o) => { if (o.name.startsWith('ring_')) names.push(o.name); });
      expect(names).toEqual(expect.arrayContaining(['ring_AsteroidBelt_zone1', 'ring_AsteroidBelt_zone2', 'ring_AsteroidBelt_zone3', 'ring_SaturnMain']));
      expect(factory.keplerianRings.size).toBe(4);

      const saturn = star.satellites[0] as Planet;
      const saturnRing = saturn.ringGroup!.children[0] as RingMesh;
      expect(saturnRing.userData.ownerName).toBe('Saturn');
      expect(saturnRing.userData.angularSpeedRadPerMs).toBeCloseTo(0.02 / 1000);
      // Rings lie in the planet's own equator (IAU pole), not the star's.
      const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(saturnRing.quaternion);
      expect(normal.distanceTo(saturn.spinPole)).toBeLessThan(1e-9);
      expect(normal.distanceTo(star.pole)).toBeGreaterThan(0.1);

      const belt = star.ringGroup!.children[0] as RingMesh;
      expect(belt.userData.angularSpeedRadPerMs).toBeGreaterThan(0);
      // Belts lie in the ecliptic (normal = ecliptic north, +Y), not the Sun's tilted equator.
      expect(new THREE.Vector3(0, 1, 0).applyQuaternion(belt.quaternion).y).toBeCloseTo(1, 9);
      expect((belt.material as THREE.ShaderMaterial).vertexShader).not.toMatch(/attribute vec2 uv/);

      factory.clearRings();
      expect(factory.keplerianRings.size).toBe(0);
    });

    it('spins rings of a massive planet at the Keplerian rate, inner zones faster, in the sense of the planet\'s rotation', async () => {
      const star = await factory.build(cfg<StarConfig>(SUN));
      await factory.attachSatellites(star, [cfg<SatelliteConfig>({ ...SATURN, mass: 568, pow: 24 })]);
      await factory.attachRings(star, []);
      const saturn = star.satellites[0] as Planet;
      const zones = saturn.ringGroup!.children as RingMesh[];
      expect(zones.map((z) => z.name)).toEqual(['ring_SaturnMain_zone1', 'ring_SaturnMain_zone2', 'ring_SaturnMain_zone3']);
      const speeds = zones.map((z) => z.userData.angularSpeedRadPerMs!);
      expect(speeds[0]).toBeGreaterThan(speeds[2]);
      // Kepler: n = sqrt(GM / r³) at the zone's true radius (2,500 km per scene unit).
      const r = ((72.3 + (120.5 - 72.3) / 6) * 2500) * 1000;
      expect(speeds[0]).toBeCloseTo(Math.sqrt((6.674e-11 * 568e24) / r ** 3) / 1000, 12);
      expect(zones[0].userData.keplerian).toBe(true);
    });

    it('builds washer rings flat in the equatorial plane when particleCount is 0', async () => {
      const star = await factory.build(cfg<StarConfig>(SUN));
      await factory.attachRings(star, [{ name: 'Disk', inner: 100, outer: 200 }]);
      const washer = star.ringGroup!.children[0] as THREE.Mesh;
      expect(washer.name).toBe('ring_Disk_washer');
      washer.geometry.computeBoundingBox();
      const box = washer.geometry.boundingBox!;
      expect(box.max.y - box.min.y).toBeLessThan(1e-6); // flat in XZ (RingGeometry is built in XY)
      expect(box.max.x).toBeCloseTo(200);
    });

    it('ignores unnamed rings', async () => {
      const star = await factory.build(cfg<StarConfig>(SUN));
      await factory.attachRings(star, [{ inner: 1, outer: 2, particleCount: 5 }]);
      expect(star.ringGroup!.children).toHaveLength(0);
    });
  });
});

describe('ring helpers', () => {
  it('keplerianAngularSpeed follows Kepler\'s third law', () => {
    const oneAu = keplerianAngularSpeed(1496);
    expect(oneAu).toBeCloseTo((2 * Math.PI) / (365.25 * 86_400_000), 20);
    expect(keplerianAngularSpeed(4 * 1496)).toBeCloseTo(oneAu / 8, 20);
    expect(keplerianAngularSpeed(0)).toBe(0);
  });

  it('safePlanetRingRadii keeps valid radii and replaces ones inside the planet', () => {
    expect(safePlanetRingRadii(72.3, 120.5, 48.2)).toEqual([72.3, 120.5]);
    expect(safePlanetRingRadii(10, 20, 48.2)).toEqual([48.2 * 1.15, 48.2 * 2.2]);
    expect(safePlanetRingRadii(80, 70, 48.2)).toEqual([48.2 * 1.15, 48.2 * 2.2]);
    expect(safePlanetRingRadii(undefined, undefined, 10)).toEqual([11.5, 22]);
  });
});
