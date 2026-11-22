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
  VIDEO_MAX_BYTES,
  VIDEO_TYPES,
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
    /** True only for the store folder: hero slides may be MP4 or WebM videos there. */
    allowVideo = false,
  ): Promise<UploadTarget[]> {
    for (const f of files) {
      const isVideo = (VIDEO_TYPES as readonly string[]).includes(f.type);
      if (isVideo) {
        if (!allowVideo)
          throw invalid('Videos can only be uploaded for the store itself.');
        if (f.size <= 0 || f.size > VIDEO_MAX_BYTES)
          throw invalid('Each video must be 50 MB or smaller.');
        continue;
      }
      if (!(IMAGE_TYPES as readonly string[]).includes(f.type))
        throw invalid(
          allowVideo
            ? 'Only JPEG, PNG and WebP images or MP4 and WebM videos are allowed.'
            : 'Only JPEG, PNG and WebP images are allowed.',
        );
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

  /** One signed upload link for an exact, already validated object path (Studio media chooses its own file name). */
  async createUploadTargetAt(
    token: string,
    path: string,
  ): Promise<UploadTarget> {
    const { data, error } = await this.clientFor(token)
      .storage.from(PRODUCT_BUCKET)
      .createSignedUploadUrl(path);
    if (error || !data) {
      this.logger.error(`createSignedUploadUrl failed: ${error?.message}`);
      throw forbidden('You are not allowed to upload here.');
    }
    return { path, token: data.token, signedUrl: data.signedUrl };
  }

  /**
   * Like verifyObjects for ONE file, but asks Storage for that name only: a tenant folder can hold more than the
   * 1000 entries a plain listing returns (every product has its own sub-folder there).
   */
  async verifyChildObject(
    token: string,
    folder: string,
    path: string,
  ): Promise<VerifiedObject> {
    if (!isDirectChild(path, folder))
      throw invalid('An uploaded image has an invalid path.');
    const name = path.slice(folder.length + 1);
    const { data, error } = await this.clientFor(token)
      .storage.from(PRODUCT_BUCKET)
      .list(folder, { limit: 100, search: name });
    if (error) {
      this.logger.error(`storage list failed: ${error.message}`);
      throw new AppException(
        'UNKNOWN',
        'Could not verify the uploaded image. Please try again.',
      );
    }
    const obj = (data ?? []).find((o) => o.name === name);
    const meta = obj?.metadata as { mimetype?: string; size?: number } | null;
    if (!obj || !meta?.mimetype || !meta.size)
      throw invalid('The image upload did not finish. Please upload it again.');
    if (
      !(IMAGE_TYPES as readonly string[]).includes(meta.mimetype) ||
      meta.size > IMAGE_MAX_BYTES
    )
      throw invalid('The uploaded image is not an allowed type or size.');
    return { path, mimeType: meta.mimetype, sizeBytes: meta.size };
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
