import * as THREE from 'three';
import { SIMULATION_CONSTANTS } from '../../galaxy/celestial.model';

/** 3-D reference lattice (10 AU spacing) toggled by "Graph" mode. */
export class Grid {
  static readonly RESOLUTION = 32;
  static readonly STEP = 10 * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;

  readonly lines: THREE.LineSegments;

  constructor(scene: THREE.Object3D) {
    this.lines = Grid.buildLines();
    this.lines.visible = false;
    scene.add(this.lines);
  }

  setVisible(visible: boolean): void {
    this.lines.visible = visible;
  }

  dispose(): void {
    this.lines.removeFromParent();
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
  }

  static buildLines(): THREE.LineSegments {
    const step = Grid.STEP;
    const n = Grid.RESOLUTION;
    const half = Math.floor(n / 2) * step;
    const positions: number[] = [];
    for (let a = 0; a <= n; a++) {
      for (let b = 0; b <= n; b++) {
        const u = -half + a * step;
        const v = -half + b * step;
        positions.push(-half, u, v, half, u, v); // along X
        positions.push(u, -half, v, u, half, v); // along Y
        positions.push(u, v, -half, u, v, half); // along Z
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.09 }));
  }
}
