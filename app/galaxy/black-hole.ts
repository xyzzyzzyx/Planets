import * as THREE from 'three';
import { disposeObject3D } from '../webgl/dispose';

/** Event-horizon radius (scene units). */
export const BLACK_HOLE_RADIUS = 900;

const DISK_VERTEX = /* glsl */ `
  varying vec2 vPos;
  void main() {
    vPos = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DISK_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uInner;
  uniform float uOuter;
  varying vec2 vPos;
  void main() {
    float r = length(vPos);
    float t = clamp((r - uInner) / (uOuter - uInner), 0.0, 1.0);
    // Differential (Keplerian-looking) rotation: inner gas laps the outer gas.
    float a = atan(vPos.y, vPos.x) + uTime * 0.6 * pow(uInner / r, 1.5);
    float streaks = 0.65 + 0.35 * sin(a * 9.0 + log(r) * 14.0) * sin(a * 4.0 - log(r) * 6.0);
    vec3 hot = vec3(1.0, 0.95, 0.85);
    vec3 warm = vec3(1.0, 0.55, 0.15);
    vec3 cool = vec3(0.55, 0.12, 0.05);
    vec3 color = t < 0.35 ? mix(hot, warm, t / 0.35) : mix(warm, cool, (t - 0.35) / 0.65);
    float edge = smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.75, 1.0, t));
    float intensity = pow(1.0 - t, 1.4) * streaks * edge;
    gl_FragColor = vec4(color * intensity, intensity);
  }
`;

const HALO_FRAGMENT = /* glsl */ `
  uniform float uInner;
  uniform float uOuter;
  varying vec2 vPos;
  void main() {
    float t = clamp((length(vPos) - uInner) / (uOuter - uInner), 0.0, 1.0);
    float intensity = pow(1.0 - t, 3.0) * 0.55;
    gl_FragColor = vec4(vec3(1.0, 0.7, 0.35) * intensity, intensity);
  }
`;

function diskMaterial(fragmentShader: string, inner: number, outer: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: DISK_VERTEX,
    fragmentShader,
    uniforms: { uTime: { value: 0 }, uInner: { value: inner }, uOuter: { value: outer } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

/**
 * The supermassive black hole at the centre of the galactic spiral: a black
 * event horizon (it occludes the core stars behind it), a camera-facing photon
 * ring and glow, and a swirling accretion disk in the galactic plane.
 */
export class BlackHole {
  readonly group = new THREE.Group();
  readonly horizon: THREE.Mesh;
  readonly disk: THREE.Mesh;
  /** Camera-facing parts (photon ring + halo). */
  readonly billboard = new THREE.Group();

  private readonly diskMaterial: THREE.ShaderMaterial;
  private readonly tmp = new THREE.Vector3();

  constructor(readonly radius = BLACK_HOLE_RADIUS) {
    this.group.name = 'blackHole';

    this.horizon = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    this.horizon.name = 'blackHole_horizon';
    this.horizon.renderOrder = -1;
    this.group.add(this.horizon);

    const diskInner = radius * 1.6;
    const diskOuter = radius * 8;
    this.diskMaterial = diskMaterial(DISK_FRAGMENT, diskInner, diskOuter);
    this.disk = new THREE.Mesh(new THREE.RingGeometry(diskInner, diskOuter, 192, 8), this.diskMaterial);
    this.disk.name = 'blackHole_accretionDisk';
    // RingGeometry lies in XY; lay it in the galactic (XZ) plane with a slight tilt.
    this.disk.rotation.set(-Math.PI / 2 + THREE.MathUtils.degToRad(12), 0, 0);
    this.group.add(this.disk);

    const photonRing = new THREE.Mesh(
      new THREE.RingGeometry(radius * 1.0, radius * 1.12, 128),
      new THREE.MeshBasicMaterial({ color: 0xfff1d6, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    photonRing.name = 'blackHole_photonRing';
    const halo = new THREE.Mesh(new THREE.RingGeometry(radius * 1.12, radius * 4, 96, 4), diskMaterial(HALO_FRAGMENT, radius * 1.12, radius * 4));
    halo.name = 'blackHole_halo';
    this.billboard.name = 'blackHole_billboard';
    this.billboard.add(photonRing, halo);
    this.group.add(this.billboard);
  }

  /** Animate the disk and turn the photon ring/halo toward the camera. */
  update(timeSec: number, camera?: THREE.Camera): void {
    this.diskMaterial.uniforms['uTime'].value = timeSec;
    if (camera) {
      this.group.updateWorldMatrix(true, false);
      this.billboard.lookAt(camera.getWorldPosition(this.tmp));
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    disposeObject3D(this.group);
  }
}
