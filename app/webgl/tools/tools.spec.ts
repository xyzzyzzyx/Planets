import * as THREE from 'three';
import { Moon } from '../../galaxy/moon.model';
import { Planet } from '../../galaxy/planet.model';
import { Star } from '../../galaxy/star.model';
import { Grid } from './grid';
import { Spectrometer } from './spectrometer';

describe('Grid', () => {
  it('adds a hidden lattice to the scene and toggles visibility', () => {
    const scene = new THREE.Scene();
    const grid = new Grid(scene);
    expect(scene.children).toContain(grid.lines);
    expect(grid.lines.visible).toBe(false);
    grid.setVisible(true);
    expect(grid.lines.visible).toBe(true);
    grid.setVisible(false);
    expect(grid.lines.visible).toBe(false);
  });

  it('has (n+1)² lines per axis spanning the lattice', () => {
    const n = Grid.RESOLUTION + 1;
    const lines = Grid.buildLines();
    expect(lines.geometry.getAttribute('position').count).toBe(n * n * 3 * 2);
    lines.geometry.computeBoundingBox();
    expect(lines.geometry.boundingBox!.max.x).toBeCloseTo((Grid.RESOLUTION / 2) * Grid.STEP);
  });

  it('dispose() removes and frees the lines', () => {
    const scene = new THREE.Scene();
    const grid = new Grid(scene);
    const spy = vi.spyOn(grid.lines.geometry, 'dispose');
    grid.dispose();
    expect(scene.children).not.toContain(grid.lines);
    expect(spy).toHaveBeenCalled();
  });
});

describe('Spectrometer', () => {
  function system(planets: number, moonsEach: number): Star {
    const star = new Star({ name: 'Sun', type: 'star', diameter: 10 });
    for (let p = 0; p < planets; p++) {
      const planet = new Planet({ name: `P${p}`, type: 'planet', diameter: 1, au: p + 1, period: 100 });
      for (let m = 0; m < moonsEach; m++) planet.addSatellite(new Moon({ name: `P${p}M${m}`, type: 'moon', diameter: 0.1, semiMajorAxis: m + 2, period: 5 }));
      star.addSatellite(planet);
    }
    for (const b of star.descendants()) if ('setAngle' in b) (b as Planet).setAngle(0.5);
    star.group.updateMatrixWorld(true);
    return star;
  }

  it('draws star→planet, planet→moon and star→moon segments', () => {
    const spec = new Spectrometer(new THREE.Scene());
    spec.update(system(2, 3));
    expect(spec.segmentCount).toBe(2 * (1 + 3 * 2));
    const pos = spec.lines.geometry.getAttribute('position');
    expect(new THREE.Vector3().fromBufferAttribute(pos as THREE.BufferAttribute, 0).length()).toBe(0); // starts at the star
  });

  it('reuses its GPU buffer when the system does not grow', () => {
    const spec = new Spectrometer(new THREE.Scene());
    spec.update(system(3, 1));
    const attr = spec.lines.geometry.getAttribute('position');
    spec.update(system(2, 1));
    expect(spec.lines.geometry.getAttribute('position')).toBe(attr);
    spec.update(system(40, 10));
    expect(spec.lines.geometry.getAttribute('position')).not.toBe(attr);
  });

  it('ignores a missing star and toggles visibility', () => {
    const spec = new Spectrometer(new THREE.Scene());
    expect(() => spec.update(null)).not.toThrow();
    spec.setVisible(true);
    expect(spec.lines.visible).toBe(true);
    spec.dispose();
  });
});
