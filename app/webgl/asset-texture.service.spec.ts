import { TestBed } from '@angular/core/testing';
import * as THREE from 'three';
import { fakeTextureLoader } from '../testing/fakes';
import { AssetTextureService, hasImage } from './asset-texture.service';

describe('AssetTextureService', () => {
  let service: AssetTextureService;
  let loader: ReturnType<typeof fakeTextureLoader>;

  beforeEach(() => {
    service = TestBed.inject(AssetTextureService);
    loader = fakeTextureLoader();
    service.loader = loader;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('loads textures as sRGB', async () => {
    const t = await service.load('/a.png');
    expect(t?.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(hasImage(t)).toBe(true);
  });

  it('de-duplicates concurrent and repeated loads of the same URL', async () => {
    const [a, b] = await Promise.all([service.load('/a.png'), service.load(' /a.png ')]);
    const c = await service.load('/a.png');
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(loader.loadAsync).toHaveBeenCalledTimes(1);
  });

  it('resolves null for empty paths and failed loads, and retries failures later', async () => {
    expect(await service.load('')).toBeNull();
    expect(await service.load(undefined)).toBeNull();
    expect(await service.load('/missing.png')).toBeNull();
    await service.load('/missing.png');
    expect(loader.loadAsync).toHaveBeenCalledTimes(2);
  });

  it('loadMultipleTextures keeps positions, using empty textures for gaps', async () => {
    const result = await service.loadMultipleTextures(['/a.png', null, '/missing.png', '/b.png']);
    expect(result).toHaveLength(4);
    expect(result.map(hasImage)).toEqual([true, false, false, true]);
  });

  it('clear() disposes cached textures', async () => {
    const t = (await service.load('/a.png'))!;
    const dispose = vi.spyOn(t, 'dispose');
    service.clear();
    await Promise.resolve();
    await Promise.resolve();
    expect(dispose).toHaveBeenCalled();
    await service.load('/a.png');
    expect(loader.loadAsync).toHaveBeenCalledTimes(2);
  });
});
