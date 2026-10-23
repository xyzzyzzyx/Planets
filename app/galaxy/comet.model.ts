import * as THREE from 'three';
import { CometConfig, OrbitingBody, SIMULATION_CONSTANTS } from './celestial.model';

const UP = new THREE.Vector3(0, 1, 0);

/**
 * A comet on an eccentric orbit. Its particle tail is rebuilt every frame from
 * the recent trail of head positions (see {@link Comet.updateTail}).
 */
export class Comet extends OrbitingBody {
  declare readonly config: CometConfig;
  tailParticles: THREE.Points | null = null;
  /** Recent head positions in the comet group's frame, newest first. */
  previousPositions: THREE.Vector3[] = [];
  maxTrailPoints = 250;

  constructor(config: CometConfig) {
    super(config);
  }

  /** Rebuild the particle tail from the recent trail of head positions. */
  updateTail(sunPos: THREE.Vector3): void {
    if (!this.tailParticles) return;

    const headPos = this.orbitalGroup.position.clone();
    const last = this.previousPositions[0];
    if (!last || !last.equals(headPos)) {
      this.previousPositions.unshift(headPos);
      if (this.previousPositions.length > this.maxTrailPoints) this.previousPositions.length = this.maxTrailPoints;
    }

    const distAU = headPos.distanceTo(sunPos) / SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;
    const targetLength = Math.max(80, 280 * (distAU / 12));
    const density = Math.max(0.3, Math.min(1, distAU / 15));

    const geometry = this.tailParticles.geometry;
    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const colorAttr = geometry.getAttribute('color') as THREE.BufferAttribute;
    const sizeAttr = geometry.getAttribute('size') as THREE.BufferAttribute;

    const active = Math.min(this.previousPositions.length, Math.floor(targetLength), posAttr.count);
    const dir = new THREE.Vector3();
    const perp = new THREE.Vector3();

    for (let i = 0; i < active; i++) {
      const p = this.previousPositions[i];
      if (i < active - 1) dir.subVectors(this.previousPositions[i + 1], p).normalize();
      else dir.set(0, 0, 1);

      perp.crossVectors(dir, UP);
      if (perp.lengthSq() < 0.01) perp.set(1, 0, 0);
      perp.normalize();

      const t = i / active;
      const spread = t * 12 * density;
      perp.multiplyScalar(Math.sin(i * 0.3) * spread + (Math.random() - 0.5) * 2);
      posAttr.setXYZ(i, p.x + perp.x, p.y + perp.y, p.z + perp.z);

      const fade = (1 - t) * density;
      colorAttr.setXYZ(i, 0.7 * fade, 0.85 * fade, fade);
      sizeAttr.setX(i, 0.6 + Math.random() * 1.8 * (1 - t));
    }
    for (let i = active; i < posAttr.count; i++) sizeAttr.setX(i, 0);

    geometry.setDrawRange(0, active);
    posAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
  }
}
