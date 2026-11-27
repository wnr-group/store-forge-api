import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { AuthUser } from '../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import { StorageService, type VerifiedObject } from './storage.service.js';

type Executor = { execute: DbTx['execute'] };

const lockKey = (path: string) =>
  sql`hashtextextended(${'storage-path:' + path}, 0)`;

/**
 * Reference protection for uploaded files (port of services/storage-references.service.ts).
 *
 * A stored path can be referenced from the catalog columns (product images, collection image, catalog item image, store logo) AND
 * from template-customization data that this API does not manage: `store_template_settings.hero_image_path`,
 * `templates.draft` and every row of `template_versions.document`. Those tables are only READ here, through raw
 * SQL, so removing a file can never break a template (see docs/EXCLUDED_FEATURES.md).
 *
 * Document references are matched structurally with jsonpath (any object, at any depth, whose `path` member equals
 * the file path exactly) and deliberately over-protect: the cost of a wrong answer is an orphaned file, never a
 * broken page.
 *
 * Concurrency: writers that start referencing a path call `lockStoragePaths` inside their transaction; the remover
 * takes the same transaction-level advisory locks, checks, and deletes while holding them.
 */
@Injectable()
export class StorageReferencesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
  ) {}

  /** Takes a transaction-scoped lock per path, always in sorted order so two callers can never deadlock. */
  async lockStoragePaths(
    tx: Executor,
    paths: Array<string | null | undefined>,
  ): Promise<void> {
    const unique = [...new Set(paths.filter((p): p is string => !!p))].sort();
    for (const p of unique)
      await tx.execute(sql`select pg_advisory_xact_lock(${lockKey(p)})`);
  }

  /**
   * The writer half of the protocol: take the per-path locks FIRST, then confirm the objects exist, all inside the
   * caller's transaction. Keep the transaction open until the reference commits.
   */
  async verifyObjectsUnderLock(
    tx: DbTx,
    token: string,
    folder: string,
    paths: string[],
  ): Promise<VerifiedObject[]> {
    await this.lockStoragePaths(tx, paths);
    return this.storage.verifyObjects(token, folder, paths);
  }

  /** The subset of `paths` that something in this tenant still references. Tenant-filtered on every table. */
  async findReferencedPaths(
    tx: Executor,
    tenantId: string,
    paths: string[],
  ): Promise<Set<string>> {
    const unique = [...new Set(paths)];
    if (unique.length === 0) return new Set();
    const values = sql.join(
      unique.map((p) => sql`(${p}::text)`),
      sql`, `,
    );
    const rows = rowsOf<{ path: string }>(
      await tx.execute(sql`
        select p.path from (values ${values}) as p(path)
        where exists (select 1 from public.product_images x where x.tenant_id = ${tenantId} and x.storage_path = p.path)
           or exists (select 1 from public.collections x where x.tenant_id = ${tenantId} and x.image_path = p.path)
           or exists (select 1 from public.catalog_nodes x where x.tenant_id = ${tenantId} and x.image_path = p.path)
           or exists (select 1 from public.stores x where x.tenant_id = ${tenantId} and x.logo_url = p.path)
           or exists (select 1 from public.store_template_settings x where x.tenant_id = ${tenantId} and x.hero_image_path = p.path)
           or exists (select 1 from public.templates x where x.tenant_id = ${tenantId}
                      and jsonb_path_exists(x.draft, '$.** ? (@.path == $p)', jsonb_build_object('p', p.path)))
           or exists (select 1 from public.template_versions x where x.tenant_id = ${tenantId}
                      and jsonb_path_exists(x.document, '$.** ? (@.path == $p)', jsonb_build_object('p', p.path)))
      `),
    );
    return new Set(rows.map((r) => r.path));
  }

  /**
   * The only way application code removes uploaded files after a save or discard. Removes just the paths that sit
   * under `tenantId` and that nothing references, checking and deleting under the path locks. Never throws for
   * storage failures. Call it AFTER the transaction that unlinked the files has committed.
   */
  async removeUnreferencedObjects(
    user: AuthUser,
    tenantId: string,
    paths: string[],
  ): Promise<void> {
    const prefix = `${tenantId}/`;
    const candidates = [...new Set(paths)].filter(
      (p) => p.startsWith(prefix) && !p.includes('..'),
    );
    if (candidates.length === 0) return;
    await this.db.withUser(user.id, async (tx) => {
      await this.lockStoragePaths(tx, candidates);
      const referenced = await this.findReferencedPaths(
        tx,
        tenantId,
        candidates,
      );
      await this.storage.removeObjects(
        user.token,
        candidates.filter((p) => !referenced.has(p)),
      );
    });
  }
}
