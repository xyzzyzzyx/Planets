import * as THREE from 'three';
import { CelestialBody, CelestialConfig } from './celestial.model';

/** Shared helpers for body factories. */
export abstract class CelestialFactory<T extends CelestialConfig, U extends CelestialBody> {
  abstract build(config: T): Promise<U>;

  /** Latitude/longitude graticule (hidden by default; toggled by "Coordinates Grid"). */
  createLatLongLines(radius: number): THREE.Group {
    const group = new THREE.Group();
    group.name = 'latLong';
    const lineRadius = radius * 1.001;
    const lineMat = new THREE.LineBasicMaterial({ color: 0x88ff88, transparent: true, opacity: 0.65, depthTest: false, depthWrite: false });

    for (let lat = -80; lat <= 80; lat += 20) {
      const latRad = (lat * Math.PI) / 180;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 64; i++) {
        const lng = (i * 2 * Math.PI) / 64;
        pts.push(new THREE.Vector3(lineRadius * Math.cos(latRad) * Math.cos(lng), lineRadius * Math.sin(latRad), lineRadius * Math.cos(latRad) * Math.sin(lng)));
      }
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
    }

    for (let lng = 0; lng < 360; lng += 30) {
      const lngRad = (lng * Math.PI) / 180;
      const pts: THREE.Vector3[] = [];
      // Meridians run pole to pole: latitude −π/2 … +π/2.
      for (let i = -16; i <= 16; i++) {
        const lat = (i * Math.PI) / 32;
        pts.push(new THREE.Vector3(lineRadius * Math.cos(lat) * Math.cos(lngRad), lineRadius * Math.sin(lat), lineRadius * Math.cos(lat) * Math.sin(lngRad)));
      }
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
    }

    group.renderOrder = 5;
    group.visible = false;
    return group;
  }

  /**
   * Dipole magnetic-field visualisation: a faint boundary sphere plus field
   * lines r = L·sin²θ. Hidden by default; toggled by "Fields".
   */
  createMagneticField(body: CelestialBody, parent: THREE.Object3D): THREE.Group | undefined {
    const field = body.magneticField;
    if (!field) return undefined;
    const radius = field.getFieldRadius();
    const cfg = field.magneticConfig;
    const group = new THREE.Group();
    group.name = `${body.name}_magneticField`;
    group.rotation.z = ((cfg.tilt ?? 0) * Math.PI) / 180;

    const color = (cfg.polarity ?? 1) >= 0 ? 0x66aaff : 0xff8866;
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 32, 16),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.06, depthWrite: false, side: THREE.BackSide }),
    );
    group.add(sphere);

    const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.45, depthWrite: false });
    const shells = [0.45, 0.7, 1];
    const meridians = 8;
    for (const shell of shells) {
      const L = radius * shell;
      for (let m = 0; m < meridians; m++) {
        const phi = (m / meridians) * Math.PI * 2;
        const pts: THREE.Vector3[] = [];
        for (let i = 1; i < 48; i++) {
          const theta = (i / 48) * Math.PI;
          const r = L * Math.sin(theta) ** 2;
          if (r < field.bodyRadius) continue;
          pts.push(new THREE.Vector3(r * Math.sin(theta) * Math.cos(phi), r * Math.cos(theta), r * Math.sin(theta) * Math.sin(phi)));
        }
        if (pts.length > 1) group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
      }
    }

    group.visible = false;
    parent.add(group);
    body.magneticFieldGroup = group;
    return group;
  }

  /** Back-side glow shell used to highlight selected bodies. */
  createHighlight(radius: number, color: number, opacity: number, segments = 32): THREE.Mesh {
    const highlight = new THREE.Mesh(
      new THREE.SphereGeometry(radius, segments, segments),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.BackSide, depthWrite: false }),
    );
    highlight.visible = false;
    return highlight;
  }
}
