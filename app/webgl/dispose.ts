import * as THREE from 'three';

type Disposable = { dispose(): void };

const isDisposable = (value: unknown): value is Disposable =>
  !!value && typeof (value as Disposable).dispose === 'function';

/** Dispose a material and every texture it references. */
export function disposeMaterial(material: THREE.Material | THREE.Material[] | null | undefined, seen = new Set<unknown>()): void {
  if (!material) return;
  for (const mat of Array.isArray(material) ? material : [material]) {
    if (seen.has(mat)) continue;
    seen.add(mat);
    for (const value of Object.values(mat)) {
      if (value instanceof THREE.Texture && !seen.has(value)) {
        seen.add(value);
        value.dispose();
      }
    }
    // ShaderMaterial uniforms can hold textures too.
    const uniforms = (mat as THREE.ShaderMaterial).uniforms;
    if (uniforms) {
      for (const uniform of Object.values(uniforms)) {
        const v = uniform?.value;
        if (v instanceof THREE.Texture && !seen.has(v)) {
          seen.add(v);
          v.dispose();
        }
      }
    }
    mat.dispose();
  }
}

/**
 * Recursively dispose geometries, materials and textures under `root`.
 * Shared resources are disposed once. Returns the number of objects visited.
 */
export function disposeObject3D(root: THREE.Object3D | null | undefined): number {
  if (!root) return 0;
  const seen = new Set<unknown>();
  let visited = 0;
  root.traverse((obj) => {
    visited++;
    const withGeometry = obj as THREE.Object3D & { geometry?: unknown; material?: THREE.Material | THREE.Material[] };
    if (isDisposable(withGeometry.geometry) && !seen.has(withGeometry.geometry)) {
      seen.add(withGeometry.geometry);
      withGeometry.geometry.dispose();
    }
    disposeMaterial(withGeometry.material, seen);
    if (obj instanceof THREE.InstancedMesh) obj.dispose();
    if (obj instanceof THREE.Light && isDisposable((obj as THREE.Light & { shadow?: unknown }).shadow)) {
      ((obj as THREE.Light & { shadow: Disposable }).shadow).dispose();
    }
  });
  return visited;
}

/** Remove an object from its parent and dispose its resources. */
export function removeAndDispose(obj: THREE.Object3D | null | undefined): void {
  if (!obj) return;
  obj.removeFromParent();
  disposeObject3D(obj);
}
