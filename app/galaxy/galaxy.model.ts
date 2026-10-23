import * as THREE from 'three';

export interface GalaxyConfig {
  seed?: number;
  arms?: number;
  starsCount?: number;
  radius?: number;
  /** Logarithmic-spiral pitch parameter (smaller = tighter arms). */
  spiralTightness?: number;
  armSpread?: number;
  coreSize?: number;
  sunDistance?: number;
}

/** The spiral star-field backdrop: a single THREE.Points cloud plus the config it was built from. */
export class Galaxy {
  constructor(readonly config: GalaxyConfig, readonly points: THREE.Points) { }

  get starCount(): number {
    return this.points.geometry.getAttribute('position').count;
  }

  /** Position of the i-th star (allocates). */
  starAt(index: number, target = new THREE.Vector3()): THREE.Vector3 {
    return target.fromBufferAttribute(this.points.geometry.getAttribute('position') as THREE.BufferAttribute, index);
  }
}
