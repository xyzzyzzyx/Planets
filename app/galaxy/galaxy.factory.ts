import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { Galaxy, GalaxyConfig } from './galaxy.model';

/** Mulberry32 PRNG (same algorithm as the server's random-system generator). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Simplified black-body colour for a temperature in kelvin, with ±20% variation. */
export function temperatureToColor(kelvin: number, rng: () => number = () => 0.5): THREE.Color {
  const t = kelvin / 1000;
  let r: number, g: number, b: number;
  if (t <= 6.6) {
    r = 1;
    g = Math.max(0, Math.min(1, 0.5 * (t - 2)));
    b = Math.max(0, Math.min(1, 0.5 * (t - 4)));
  } else {
    r = Math.max(0, 1 - 0.5 * (t - 6.6));
    g = Math.max(0, 1 - 0.3 * (t - 6.6));
    b = 1;
  }
  return new THREE.Color(r * (0.8 + 0.4 * rng()), g * (0.8 + 0.4 * rng()), b * (0.8 + 0.4 * rng()));
}

export const GALAXY_SCALE = 5000;

/** Builds the logarithmic-spiral star field shown around the solar system. */
@Injectable({ providedIn: 'root' })
export class GalaxyFactory {
  build(config: GalaxyConfig = {}): Galaxy {
    const {
      seed = 42,
      arms = 4,
      starsCount = 200_000,
      radius = 20,
      coreSize = 3.0,
      armSpread = 0.25,
      sunDistance = 10.0,
      spiralTightness = 0.22,
    } = config;

    const rng = mulberry32(seed);
    const count = Math.max(0, Math.floor(starsCount));
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const safeArms = Math.max(1, Math.floor(arms));
    const sunOffsetX = sunDistance * GALAXY_SCALE;

    for (let i = 0; i < count; i++) {
      const armOffset = ((i % safeArms) / safeArms) * Math.PI * 2;

      let r: number;
      if (rng() < 0.25) {
        r = Math.pow(rng(), 1.5) * coreSize;
      } else {
        r = coreSize - Math.log(1 - rng() * 0.999) * 2.8;
        if (r > radius) r = coreSize + rng() * Math.max(0, radius - coreSize);
      }
      r = Math.max(r, 1e-3);

      // A floor on the spread keeps inner arms diffuse instead of razor-thin lines.
      const spread = (rng() - 0.5) * armSpread * (0.35 + r / radius) * 1.8;
      const theta = Math.log(r / coreSize) / spiralTightness + armOffset + spread;
      const warp = Math.sin(r * 0.6) * 0.3 * GALAXY_SCALE;
      const y = (rng() - 0.5) * 0.2 * GALAXY_SCALE * (0.3 + r / radius) + warp;

      positions[i * 3] = Math.cos(theta) * r * GALAXY_SCALE - sunOffsetX;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = Math.sin(theta) * r * GALAXY_SCALE;

      const color = temperatureToColor(3200 + rng() * 6800, rng);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();

    const points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({ size: 0.9, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    points.name = 'galaxy';
    return new Galaxy(config, points);
  }
}
