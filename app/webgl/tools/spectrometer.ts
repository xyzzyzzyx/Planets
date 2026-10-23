import * as THREE from 'three';
import type { Star } from '../../galaxy/star.model';

/**
 * "Spectroscopy" overlay: lines of sight star→planet, planet→moon and
 * star→moon. Reuses one GPU buffer, growing it only when needed.
 */
export class Spectrometer {
  readonly lines: THREE.LineSegments;
  private capacity = 0;
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();

  constructor(scene: THREE.Object3D) {
    this.lines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.45 }),
    );
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    scene.add(this.lines);
  }

  setVisible(visible: boolean): void {
    this.lines.visible = visible;
  }

  /** Number of line segments drawn by the last update. */
  get segmentCount(): number {
    return this.lines.geometry.drawRange.count / 2;
  }

  update(star: Star | null | undefined): void {
    if (!star) return;
    const segments = star.satellites.reduce((n, p) => n + 1 + p.satellites.length * 2, 0);
    this.ensureCapacity(segments * 2);
    const attr = this.lines.geometry.getAttribute('position') as THREE.BufferAttribute;
    const sun = star.getWorldPosition(new THREE.Vector3());
    let v = 0;
    const push = (a: THREE.Vector3, b: THREE.Vector3) => {
      attr.setXYZ(v++, a.x, a.y, a.z);
      attr.setXYZ(v++, b.x, b.y, b.z);
    };
    for (const planet of star.satellites) {
      const p = planet.getWorldPosition(this.tmpA);
      push(sun, p);
      for (const moon of planet.satellites) {
        const m = moon.getWorldPosition(this.tmpB);
        push(p, m);
        push(sun, m);
      }
    }
    attr.needsUpdate = true;
    this.lines.geometry.setDrawRange(0, v);
  }

  private ensureCapacity(vertices: number): void {
    if (vertices <= this.capacity && this.capacity > 0) return;
    this.capacity = Math.max(64, vertices * 2);
    this.lines.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3));
  }

  dispose(): void {
    this.lines.removeFromParent();
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
  }
}
