import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  AppException,
  forbidden,
  invalid,
} from '../../common/app.exception.js';
import type { AppConfig } from '../../config/configuration.js';
import {
  IMAGE_MAX_BYTES,
  IMAGE_TYPES,
  isDirectChild,
  newObjectName,
  PRODUCT_BUCKET,
} from './storage-paths.js';

export type UploadTarget = { path: string; token: string; signedUrl: string };
export type VerifiedObject = {
  path: string;
  mimeType: string;
  sizeBytes: number;
};
type FileMeta = { type: string; size: number };

/**
 * Supabase Storage on behalf of the CALLER. Every call forwards the caller's own access token, so the Storage
 * policies from migration drizzle/0006 (tenant membership by path) stay the authority; the service-role key is
 * never used here. Callers must ALSO have checked the tenant permission: this is defence in depth, not a replacement.
 */
if (typeof globalThis.WebSocket === 'undefined') {
  (globalThis as unknown as Record<string, unknown>).WebSocket =
    class {} as never;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  protected clientFor(token: string): SupabaseClient {
    const { url, anonKey } = this.config.get('supabase', { infer: true });
    return createClient(url, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
  }

  async createUploadTargets(
    token: string,
    folder: string,
    files: FileMeta[],
  ): Promise<UploadTarget[]> {
    for (const f of files) {
      if (!(IMAGE_TYPES as readonly string[]).includes(f.type))
        throw invalid('Only JPEG, PNG and WebP images are allowed.');
      if (f.size <= 0 || f.size > IMAGE_MAX_BYTES)
        throw invalid('Each image must be 5 MB or smaller.');
    }
    const bucket = this.clientFor(token).storage.from(PRODUCT_BUCKET);
    const targets: UploadTarget[] = [];
    for (const f of files) {
      const name = newObjectName(f.type);
      if (!name) throw invalid('Unsupported image type.');
      const path = `${folder}/${name}`;
      const { data, error } = await bucket.createSignedUploadUrl(path);
      if (error || !data) {
        this.logger.error(`createSignedUploadUrl failed: ${error?.message}`);
        throw forbidden('You are not allowed to upload here.');
      }
      targets.push({ path, token: data.token, signedUrl: data.signedUrl });
    }
    return targets;
  }

  /**
   * Confirms each path is a direct child of `folder` AND really exists in the bucket, taking type and size from
   * Storage (never from the client).
   */
  async verifyObjects(
    token: string,
    folder: string,
    paths: string[],
  ): Promise<VerifiedObject[]> {
    if (paths.length === 0) return [];
    for (const p of paths)
      if (!isDirectChild(p, folder))
        throw invalid('An uploaded image has an invalid path.');
    const { data, error } = await this.clientFor(token)
      .storage.from(PRODUCT_BUCKET)
      .list(folder, { limit: 1000 });
    if (error) {
      this.logger.error(`storage list failed: ${error.message}`);
      throw new AppException(
        'UNKNOWN',
        'Could not verify the uploaded images. Please try again.',
      );
    }
    const byName = new Map((data ?? []).map((o) => [o.name, o]));
    return paths.map((path) => {
      const obj = byName.get(path.slice(folder.length + 1));
      const meta = obj?.metadata as {
        mimetype?: string;
        size?: number;
      } | null;
      const mimeType = meta?.mimetype;
      const sizeBytes = meta?.size;
      if (!obj || !mimeType || !sizeBytes)
        throw invalid(
          'An image upload did not finish. Please upload it again.',
        );
      if (
        !(IMAGE_TYPES as readonly string[]).includes(mimeType) ||
        sizeBytes > IMAGE_MAX_BYTES
      )
        throw invalid('An uploaded image is not an allowed type or size.');
      return { path, mimeType, sizeBytes };
    });
  }

  /**
   * Returns any paths from `paths` that do not exist in the products bucket.
   */
  async findMissingObjects(token: string, paths: string[]): Promise<string[]> {
    if (paths.length === 0) return [];
    try {
      const bucket = this.clientFor(token).storage.from(PRODUCT_BUCKET);
      const missing: string[] = [];
      const folders = new Map<string, string[]>();
      for (const p of paths) {
        const lastSlash = p.lastIndexOf('/');
        const folder = lastSlash === -1 ? '' : p.slice(0, lastSlash);
        const name = lastSlash === -1 ? p : p.slice(lastSlash + 1);
        if (!folders.has(folder)) folders.set(folder, []);
        folders.get(folder)!.push(name);
      }
      for (const [folder, names] of folders.entries()) {
        const { data, error } = await bucket.list(folder, { limit: 1000 });
        if (error || !data) {
          missing.push(...names.map((n) => (folder ? `${folder}/${n}` : n)));
          continue;
        }
        const found = new Set(data.map((d) => d.name));
        for (const name of names) {
          if (!found.has(name)) {
            missing.push(folder ? `${folder}/${name}` : name);
          }
        }
      }
      return missing;
    } catch {
      return [];
    }
  }

  /**
   * Lists images under a storage folder prefix, scoped to tenant.
   */
  async listImages(
    token: string,
    prefix: string,
    page: number = 1,
    pageSize: number = 20,
  ): Promise<{
    items: Array<{
      path: string;
      name: string;
      size: number;
      mimeType: string;
      createdAt: string;
    }>;
    total: number;
  }> {
    try {
      const bucket = this.clientFor(token).storage.from(PRODUCT_BUCKET);
      const offset = (page - 1) * pageSize;
      const { data, error } = await bucket.list(prefix, {
        limit: pageSize,
        offset,
        sortBy: { column: 'created_at', order: 'desc' },
      });
      if (error || !data) {
        return { items: [], total: 0 };
      }
      const items = data
        .filter((entry) => Boolean(entry.id))
        .map((entry) => ({
          path: `${prefix}/${entry.name}`.replace(/\/+/g, '/'),
          name: entry.name,
          size: (entry.metadata as { size?: number })?.size ?? 0,
          mimeType:
            (entry.metadata as { mimetype?: string })?.mimetype ?? 'image/png',
          createdAt: entry.created_at ?? new Date().toISOString(),
        }));
      return { items, total: items.length };
    } catch {
      return { items: [], total: 0 };
    }
  }

  /** Best-effort removal; a failure leaves an unreferenced object, never a dangling DB reference. */
  async removeObjects(token: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    try {
      const { error } = await this.clientFor(token)
        .storage.from(PRODUCT_BUCKET)
        .remove(paths);
      if (error) this.logger.error(`storage remove failed: ${error.message}`);
    } catch (e) {
      this.logger.error(
        `storage remove threw: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }
  }

  /**
   * Removes EVERY object under `{tenantId}/` when an organization is deleted. Storage lists one folder level at a
   * time, so this walks the folders. Runs with the caller's own token: the Platform Admin storage policies allow it.
   * Best effort like removeObjects.
   */
  async removeTenantObjects(token: string, tenantId: string): Promise<void> {
    try {
      const bucket = this.clientFor(token).storage.from(PRODUCT_BUCKET);
      const files: string[] = [];
      const walk = async (prefix: string, depth: number): Promise<void> => {
        if (depth > 4) return;
        for (let offset = 0; ; offset += 1000) {
          const { data, error } = await bucket.list(prefix, {
            limit: 1000,
            offset,
          });
          if (error) throw error;
          for (const entry of data ?? []) {
            // Folders come back without an id; files have one.
            if (entry.id) files.push(`${prefix}/${entry.name}`);
            else await walk(`${prefix}/${entry.name}`, depth + 1);
          }
          if (!data || data.length < 1000) break;
        }
      };
      await walk(tenantId, 0);
      for (let i = 0; i < files.length; i += 100) {
        const { error } = await bucket.remove(files.slice(i, i + 100));
        if (error)
          this.logger.error(`remove tenant objects failed: ${error.message}`);
      }
    } catch (e) {
      this.logger.error(
        `remove tenant objects threw: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }
  }
}
