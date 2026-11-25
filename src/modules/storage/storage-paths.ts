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
/** Videos are only allowed in the store folder (hero slides), never on products or collections. */
export const VIDEO_TYPES = ['video/mp4', 'video/webm'] as const;
export const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGES_PER_PRODUCT = 10;

export const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
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

/**
 * The platform logo lives in its own public bucket, `platform-assets`, as `logo/{file}`. Only super admins can write there
 * (Storage policies from migration 0068); anyone can read, like store images.
 */
export const PLATFORM_ASSETS_BUCKET = 'platform-assets';
export const LOGO_FOLDER = 'logo';
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

export const platformAssetUrl = (supabaseUrl: string, path: string) =>
  `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/${PLATFORM_ASSETS_BUCKET}/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
