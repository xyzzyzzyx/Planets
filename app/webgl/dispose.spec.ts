import * as THREE from 'three';
import { disposeMaterial, disposeObject3D, removeAndDispose } from './dispose';

describe('dispose helpers', () => {
  it('disposes every geometry, material and texture once', () => {
    const map = new THREE.Texture();
    const sharedGeo = new THREE.BoxGeometry();
    const sharedMat = new THREE.MeshBasicMaterial({ map });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(sharedGeo, sharedMat), new THREE.Mesh(sharedGeo, sharedMat));
    const spies = [vi.spyOn(sharedGeo, 'dispose'), vi.spyOn(sharedMat, 'dispose'), vi.spyOn(map, 'dispose')];
    expect(disposeObject3D(root)).toBe(3);
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('handles material arrays, shader uniforms and instanced meshes', () => {
    const tex = new THREE.Texture();
    const shader = new THREE.ShaderMaterial({ uniforms: { uTexture: { value: tex }, uTime: { value: 0 } } });
    const plain = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), [shader, plain]);
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 3);
    const instDispose = vi.spyOn(inst, 'dispose');
    const texDispose = vi.spyOn(tex, 'dispose');
    const root = new THREE.Group();
    root.add(mesh, inst);
    disposeObject3D(root);
    expect(texDispose).toHaveBeenCalled();
    expect(instDispose).toHaveBeenCalled();
  });

  it('disposes light shadow maps', () => {
    const light = new THREE.PointLight();
    const spy = vi.spyOn(light.shadow, 'dispose');
    disposeObject3D(light);
    expect(spy).toHaveBeenCalled();
  });

  it('removeAndDispose detaches from the parent', () => {
    const parent = new THREE.Group();
    const child = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    parent.add(child);
    removeAndDispose(child);
    expect(parent.children).toHaveLength(0);
  });

  it('tolerates null input', () => {
    expect(disposeObject3D(null)).toBe(0);
    expect(() => removeAndDispose(undefined)).not.toThrow();
    expect(() => disposeMaterial(null)).not.toThrow();
  });
});
