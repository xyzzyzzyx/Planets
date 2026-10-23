import { Injectable } from '@angular/core';
import * as THREE from 'three';

export interface TextureLoaderLike {
  loadAsync(url: string): Promise<THREE.Texture>;
}

/** True when a texture actually has image data (failed/blank loads have none). */
export const hasImage = (t: THREE.Texture | null | undefined): t is THREE.Texture => !!t?.image;

/**
 * Loads textures with de-duplication: concurrent and repeated requests for the
 * same URL share one network request and one GPU texture.
 */
@Injectable({ providedIn: 'root' })
export class AssetTextureService {
  private readonly cache = new Map<string, Promise<THREE.Texture | null>>();

  /** Loader seam (overridable in tests). */
  loader: TextureLoaderLike = new THREE.TextureLoader();

  /** Load one texture; resolves to null for empty paths or failed loads. */
  load(file: string | null | undefined): Promise<THREE.Texture | null> {
    const url = file?.trim();
    if (!url) return Promise.resolve(null);
    let pending = this.cache.get(url);
    if (!pending) {
      pending = this.loader.loadAsync(url).then(
        (t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          t.needsUpdate = true;
          return t;
        },
        (err: unknown) => {
          console.warn(`[AssetTextureService] Failed to load texture ${url}`, err);
          this.cache.delete(url); // allow a later retry
          return null;
        },
      );
      this.cache.set(url, pending);
    }
    return pending;
  }

  /**
   * Load several textures in order. Missing/failed entries resolve to an empty
   * `THREE.Texture` (no image) so callers can index results positionally.
   */
  async loadMultipleTextures(files: readonly (string | null | undefined)[]): Promise<THREE.Texture[]> {
    const loaded = await Promise.all(files.map((f) => this.load(f)));
    return loaded.map((t) => t ?? new THREE.Texture());
  }

  clear(): void {
    for (const pending of this.cache.values()) void pending.then((t) => t?.dispose());
    this.cache.clear();
  }
}
