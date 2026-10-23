import { Injectable, inject } from '@angular/core';
import * as THREE from 'three';
import { AssetTextureService, hasImage } from '../webgl/asset-texture.service';
import { CelestialFactory } from './celestial.factory';
import { visualRadiusFor } from './celestial.model';
import { Moon, MoonConfig } from './moon.model';

export const MOON_MIN_VISUAL_RADIUS = 0.5;

/** Builds moon meshes (same structure as planets, smaller and without rings). */
@Injectable({ providedIn: 'root' })
export class MoonFactory extends CelestialFactory<MoonConfig, Moon> {
  private readonly textureService = inject(AssetTextureService);

  async build(config: MoonConfig): Promise<Moon> {
    const [map, bump, spec, cloud, alpha] = await this.textureService.loadMultipleTextures([
      config.map, config.bumpMap, config.specMap, config.cloudMap, config.alphaMap,
    ]);
    const moon = new Moon(config);
    const baseColor = new THREE.Color(config.color || 0xaaaaaa);

    const material = new THREE.MeshPhongMaterial({
      color: baseColor,
      bumpScale: 0.12,
      specular: new THREE.Color(0x222222),
      shininess: 6,
      emissive: hasImage(map) ? new THREE.Color(0x000000) : baseColor.clone().multiplyScalar(0.6),
      emissiveIntensity: 0.8,
      map: hasImage(map) ? map : null,
      bumpMap: hasImage(bump) ? bump : null,
      specularMap: hasImage(spec) ? spec : null,
    });

    const visualRadius = visualRadiusFor(config.diameter, MOON_MIN_VISUAL_RADIUS);
    const wSeg = config.widthSegments || 32;
    const hSeg = config.heightSegments || 32;
    moon.mesh = new THREE.Mesh(new THREE.SphereGeometry(visualRadius, wSeg, hSeg), material);
    moon.mesh.name = config.name || 'Moon';
    moon.highlight = this.createHighlight(visualRadius * 1.3, 0x44ffcc, 0.7, wSeg);

    if (config.cloudMap && hasImage(cloud)) {
      moon.clouds = new THREE.Mesh(
        new THREE.SphereGeometry(visualRadius + (config.atmosphere || 0.001), wSeg, hSeg),
        new THREE.MeshPhongMaterial({ map: cloud, alphaMap: hasImage(alpha) ? alpha : null, side: THREE.DoubleSide, opacity: 0.7, transparent: true, depthWrite: false }),
      );
      moon.clouds.name = `${config.name || 'Moon'}_clouds`;
    }

    moon.applyInitialTilt();
    moon.orbitalGroup.add(moon.mesh, moon.highlight);
    if (moon.clouds) moon.orbitalGroup.add(moon.clouds);
    moon.mass = (config.mass || 1) * 10 ** (config.pow || 0);

    moon.latLongGroup = this.createLatLongLines(visualRadius);
    moon.mesh.add(moon.latLongGroup);
    this.createMagneticField(moon, moon.orbitalGroup);

    return moon;
  }
}
