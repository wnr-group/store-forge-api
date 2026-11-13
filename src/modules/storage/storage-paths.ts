/**
 * Storage object paths (pure helpers, ported from lib/storage/paths.ts).
 * Layout inside the `products` bucket:
 *   {tenantId}/{productId}/{file}        product media
 *   {tenantId}/collections/{id}/{file}   collection images
 *   {tenantId}/store/{file}              store logo
 * The database CHECK constraints and the Storage policies enforce the same layout.
 */
export const PRODUCT_BUCKET = 'products';

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_PRODUCT = 10;

export const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const productFolder = (tenantId: string, productId: string) =>
  `${tenantId}/${productId}`;
export const collectionFolder = (tenantId: string, collectionId: string) =>
  `${tenantId}/collections/${collectionId}`;
export const storeFolder = (tenantId: string) => `${tenantId}/store`;

/** True when `path` is a direct child file of `folder` with no traversal tricks. */
export function isDirectChild(path: string, folder: string): boolean {
  if (!path.startsWith(`${folder}/`)) return false;
  const name = path.slice(folder.length + 1);
  return (
    name.length > 0 &&
    name.length <= 120 &&
    !name.includes('/') &&
    !name.includes('..') &&
    /^[A-Za-z0-9._-]+$/.test(name)
  );
}

export function newObjectName(mimeType: string): string | null {
  const ext = EXTENSIONS[mimeType];
  return ext ? `${crypto.randomUUID()}.${ext}` : null;
}
