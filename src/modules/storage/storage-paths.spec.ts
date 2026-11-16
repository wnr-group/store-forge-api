import {
  collectionFolder,
  isDirectChild,
  newObjectName,
  productFolder,
  storeFolder,
} from './storage-paths.js';

const T = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';

describe('storage paths', () => {
  it('builds the folder layout the Storage policies and CHECK constraints expect', () => {
    expect(productFolder(T, P)).toBe(`${T}/${P}`);
    expect(collectionFolder(T, P)).toBe(`${T}/collections/${P}`);
    expect(storeFolder(T)).toBe(`${T}/store`);
  });

  it('accepts only direct children of the expected folder', () => {
    const folder = productFolder(T, P);
    expect(isDirectChild(`${folder}/a1b2.png`, folder)).toBe(true);
    for (const bad of [
      `${folder}/`,
      `${folder}/sub/a.png`,
      `${folder}/../other/a.png`,
      `${folder}/..%2Fa.png`,
      `${folder}/a b.png`,
      `${T}/other-product/a.png`,
      `${folder}x/a.png`,
      `${folder}/${'x'.repeat(121)}`,
      'a.png',
    ])
      expect(isDirectChild(bad, folder), bad).toBe(false);
  });

  it("does not let one organization name another organization's folder", () => {
    const other = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    expect(isDirectChild(`${other}/store/a.png`, storeFolder(T))).toBe(false);
  });

  it('generates random object names only for allowed image types', () => {
    expect(newObjectName('image/png')).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(newObjectName('image/jpeg')).toMatch(/\.jpg$/);
    expect(newObjectName('image/webp')).toMatch(/\.webp$/);
    expect(newObjectName('video/mp4')).toMatch(/\.mp4$/);
    expect(newObjectName('video/webm')).toMatch(/\.webm$/);
    expect(newObjectName('image/gif')).toBeNull();
    expect(newObjectName('text/html')).toBeNull();
    expect(newObjectName('image/png')).not.toBe(newObjectName('image/png'));
  });
});
