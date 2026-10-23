import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { CelestialFactory } from './celestial.factory';
import { CometConfig, visualRadiusFor } from './celestial.model';
import { Comet } from './comet.model';

export const COMET_MIN_VISUAL_RADIUS = 0.25;
export const COMET_TAIL_PARTICLES = 1800;

/** Builds a comet: emissive nucleus, highlight and a pre-allocated particle tail buffer. */
@Injectable({ providedIn: 'root' })
export class CometFactory extends CelestialFactory<CometConfig, Comet> {
  async build(config: CometConfig): Promise<Comet> {
    const comet = new Comet(config);
    const visualRadius = visualRadiusFor(config.diameter, COMET_MIN_VISUAL_RADIUS);

    comet.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(visualRadius, 24, 24),
      new THREE.MeshPhongMaterial({ color: config.color || 0xd4c9a8, emissive: new THREE.Color(0xffeecc), emissiveIntensity: 1.2, shininess: 10 }),
    );
    comet.mesh.castShadow = true;
    comet.mesh.receiveShadow = true;
    comet.mesh.name = config.name || 'Comet';
    comet.orbitalGroup.add(comet.mesh);

    comet.highlight = this.createHighlight(visualRadius * 1.3, 0x44ffcc, 0.7, 24);
    comet.orbitalGroup.add(comet.highlight);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COMET_TAIL_PARTICLES * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(COMET_TAIL_PARTICLES * 3), 3));
    // Note: PointsMaterial ignores a per-vertex `size` attribute (it only reads `size` below);
    // it is kept so a custom point shader can use it. The draw range hides unused points.
    geo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(COMET_TAIL_PARTICLES), 1));
    geo.setDrawRange(0, 0);

    comet.tailParticles = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: visualRadius * 1.2,
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      }),
    );
    comet.tailParticles.name = `${comet.name}_tail`;
    comet.tailParticles.frustumCulled = false;
    // Trail points are expressed in the comet group's frame (the orbital
    // group's parent); adding the tail to the moving orbital group would
    // offset every particle by the comet's position a second time.
    comet.group.add(comet.tailParticles);

    comet.latLongGroup = this.createLatLongLines(visualRadius);
    comet.mesh.add(comet.latLongGroup);
    this.createMagneticField(comet, comet.orbitalGroup);

    return comet;
  }
}
