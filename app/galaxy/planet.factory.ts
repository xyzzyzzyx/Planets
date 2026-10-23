import { Injectable, inject } from '@angular/core';
import * as THREE from 'three';
import { AssetTextureService, hasImage } from '../webgl/asset-texture.service';
import { CelestialFactory } from './celestial.factory';
import { PlanetConfig, SIMULATION_CONSTANTS, visualRadiusFor } from './celestial.model';
import { Planet } from './planet.model';

export const PLANET_MIN_VISUAL_RADIUS = 1;

/** Builds planet meshes: textured Phong sphere, optional cloud shell, highlight, graticule and field. */
@Injectable({ providedIn: 'root' })
export class PlanetFactory extends CelestialFactory<PlanetConfig, Planet> {
  private readonly textureService = inject(AssetTextureService);

  async build(config: PlanetConfig): Promise<Planet> {
    const [map, bump, spec, cloud, alpha] = await this.textureService.loadMultipleTextures([
      config.map, config.bumpMap, config.specMap, config.cloudMap, config.alphaMap,
    ]);
    const planet = new Planet(config);
    const baseColor = new THREE.Color(config.color || 0xaaaaaa);

    const material = new THREE.MeshPhongMaterial({
      color: baseColor,
      bumpScale: 0.25,
      specular: new THREE.Color(0x555555),
      shininess: 10,
      emissive: hasImage(map) ? new THREE.Color(0x000000) : baseColor.clone().multiplyScalar(0.3),
      emissiveIntensity: 0.8,
      map: hasImage(map) ? map : null,
      bumpMap: hasImage(bump) ? bump : null,
      specularMap: hasImage(spec) ? spec : null,
    });

    const visualRadius = visualRadiusFor(config.diameter, PLANET_MIN_VISUAL_RADIUS);
    planet.mesh = new THREE.Mesh(new THREE.SphereGeometry(visualRadius, config.widthSegments || 64, config.heightSegments || 64), material);
    planet.mesh.castShadow = true;
    planet.mesh.receiveShadow = true;
    planet.mesh.name = config.name || 'Planet';

    planet.highlight = this.createHighlight(visualRadius * 1.22, 0x44aaff, 0.65, 48);

    if (config.cloudMap && hasImage(cloud)) {
      const cloudRadius = visualRadius + ((config.atmosphere || 0) * SIMULATION_CONSTANTS.VISUAL_SCALE) / 2 + visualRadius * 0.01;
      planet.clouds = new THREE.Mesh(
        new THREE.SphereGeometry(cloudRadius, 64, 64),
        new THREE.MeshPhongMaterial({
          map: cloud,
          alphaMap: hasImage(alpha) ? alpha : null,
          side: THREE.DoubleSide,
          opacity: 0.85,
          transparent: true,
          depthWrite: false,
        }),
      );
      planet.clouds.name = `${config.name || 'Planet'}_clouds`;
    }

    planet.applyInitialTilt();
    planet.orbitalGroup.add(planet.mesh, planet.highlight);
    if (planet.clouds) planet.orbitalGroup.add(planet.clouds);
    planet.mass = (config.mass ?? 1) * 10 ** (config.pow || 0);

    planet.latLongGroup = this.createLatLongLines(visualRadius);
    planet.mesh.add(planet.latLongGroup);
    this.createMagneticField(planet, planet.orbitalGroup);

    return planet;
  }
}
