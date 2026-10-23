import * as THREE from 'three';
import { CometFactory, COMET_TAIL_PARTICLES } from './comet.factory';
import { Comet } from './comet.model';

describe('Comet', () => {
  let comet: Comet;
  beforeEach(async () => {
    comet = await new CometFactory().build({ name: 'Halley', type: 'comet', diameter: 0.00001, au: 17.8, period: 27563, eccentricity: 0.967 });
  });

  it('puts the tail in the comet group frame, not the moving orbital group', () => {
    expect(comet.tailParticles?.parent).toBe(comet.group);
    expect(comet.mesh.parent).toBe(comet.orbitalGroup);
  });

  it('records a trail of distinct head positions, capped at maxTrailPoints', () => {
    comet.maxTrailPoints = 5;
    for (let i = 0; i < 10; i++) {
      comet.setAngle(i * 0.1);
      comet.updateTail(new THREE.Vector3());
    }
    expect(comet.previousPositions).toHaveLength(5);
    expect(comet.previousPositions[0].equals(comet.orbitalGroup.position)).toBe(true);
  });

  it('does not duplicate the head when the comet has not moved', () => {
    comet.updateTail(new THREE.Vector3());
    comet.updateTail(new THREE.Vector3());
    expect(comet.previousPositions).toHaveLength(1);
  });

  it('draws only the active particles and hides the rest', () => {
    for (let i = 0; i < 20; i++) {
      comet.setAngle(i * 0.05);
      comet.updateTail(new THREE.Vector3());
    }
    const geo = comet.tailParticles!.geometry;
    expect(geo.drawRange.count).toBe(20);
    const size = geo.getAttribute('size') as THREE.BufferAttribute;
    expect(size.count).toBe(COMET_TAIL_PARTICLES);
    expect(size.getX(25)).toBe(0);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    // Particles hug the trail: within a few units of the recorded point.
    expect(new THREE.Vector3(pos.getX(0), pos.getY(0), pos.getZ(0)).distanceTo(comet.previousPositions[0])).toBeLessThan(5);
  });

  it('is a no-op without tail particles', () => {
    comet.tailParticles = null;
    expect(() => comet.updateTail(new THREE.Vector3())).not.toThrow();
  });
});
