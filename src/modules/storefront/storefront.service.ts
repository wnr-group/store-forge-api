import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { rowsOf } from '../../infrastructure/database/user-context.js';
import {
  layoutPayloadSchema,
  publicCollectionPayloadSchema,
  publicCollectionsListSchema,
  publicProductPayloadSchema,
  storefrontSchema,
  type PublicCollection,
  type PublicCollectionsList,
  type PublicProduct,
  type PublicStorefront,
  type PublicTemplateLayout,
} from './storefront.schemas.js';

export type TemplateLayoutKind = 'index' | 'product' | 'collection';

@Injectable()
export class StorefrontService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Cutover gate helper (fail-closed, AC-D-04, E5).
   * Engine reads are allowed only when template_engine_cutover_complete() returns exactly true.
   * A missing function, database error, false, or non-boolean answer returns false.
   */
  async isEngineReadEnabled(): Promise<boolean> {
    try {
      return await this.db.withPublic(async (tx) => {
        const rows = rowsOf<{ ok: unknown }>(
          await tx.execute(
            sql`select public.template_engine_cutover_complete() as ok`,
          ),
        );
        return rows[0]?.ok === true;
      });
    } catch {
      return false;
    }
  }

  /**
   * Legacy storefront read (D-013, 0009/0011).
   * Ungated: predates the template engine cutover.
   * Returns parsed PublicStorefront or null if unknown, inactive, suspended, or malformed slug.
   */
  async getStorefront(slug: string): Promise<PublicStorefront | null> {
    const cleanSlug = slug?.trim().toLowerCase();
    if (!cleanSlug) return null;

    return this.db.withPublic(async (tx) => {
      const rows = rowsOf<{ s: unknown }>(
        await tx.execute(
          sql`select public.get_public_storefront(${cleanSlug}) as s`,
        ),
      );
      const raw = rows[0]?.s;
      if (raw === null || raw === undefined) {
        return null;
      }
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return storefrontSchema.parse(data);
    });
  }

  /**
   * Published template layout (D-013, 0014).
   * Gated: template-engine-era read (AC-D-04, PD-O1).
   * Returns null if gate is closed, or if store/resource is unknown/inactive/suspended.
   */
  async getTemplateLayout(
    slug: string,
    kind: TemplateLayoutKind,
    resourceSlug?: string,
  ): Promise<PublicTemplateLayout | null> {
    if (!(await this.isEngineReadEnabled())) {
      return null;
    }

    const cleanSlug = slug?.trim().toLowerCase();
    if (!cleanSlug) return null;

    return this.db.withPublic(async (tx) => {
      const rows = rowsOf<{ l: unknown }>(
        await tx.execute(
          sql`select public.get_public_template_layout(${cleanSlug}, ${kind}, ${resourceSlug ?? null}) as l`,
        ),
      );
      const raw = rows[0]?.l;
      if (raw === null || raw === undefined) {
        return null;
      }
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return layoutPayloadSchema.parse(data);
    });
  }

  /**
   * Active product detail read (D-013, 0014).
   * Gated: template-engine-era read (AC-D-04, PD-O1).
   * Returns null if gate is closed, or if store/product is unknown/inactive/suspended.
   */
  async getProduct(
    slug: string,
    productSlug: string,
  ): Promise<PublicProduct | null> {
    if (!(await this.isEngineReadEnabled())) {
      return null;
    }

    const cleanSlug = slug?.trim().toLowerCase();
    const cleanProductSlug = productSlug?.trim();
    if (!cleanSlug || !cleanProductSlug) return null;

    return this.db.withPublic(async (tx) => {
      const rows = rowsOf<{ p: unknown }>(
        await tx.execute(
          sql`select public.get_public_product(${cleanSlug}, ${cleanProductSlug}) as p`,
        ),
      );
      const raw = rows[0]?.p;
      if (raw === null || raw === undefined) {
        return null;
      }
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return publicProductPayloadSchema.parse(data);
    });
  }

  /**
   * Active collection detail read with products (D-013, 0014).
   * Gated: template-engine-era read (AC-D-04, PD-O1).
   * Returns null if gate is closed, or if store/collection is unknown/inactive/suspended.
   */
  async getCollection(
    slug: string,
    collectionSlug: string,
  ): Promise<PublicCollection | null> {
    if (!(await this.isEngineReadEnabled())) {
      return null;
    }

    const cleanSlug = slug?.trim().toLowerCase();
    const cleanCollectionSlug = collectionSlug?.trim();
    if (!cleanSlug || !cleanCollectionSlug) return null;

    return this.db.withPublic(async (tx) => {
      const rows = rowsOf<{ c: unknown }>(
        await tx.execute(
          sql`select public.get_public_collection(${cleanSlug}, ${cleanCollectionSlug}) as c`,
        ),
      );
      const raw = rows[0]?.c;
      if (raw === null || raw === undefined) {
        return null;
      }
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return publicCollectionPayloadSchema.parse(data);
    });
  }

  /**
   * Active collections list read (D-013, 0014).
   * Gated: template-engine-era read (AC-D-04, PD-O1).
   * Returns null if gate is closed or store is invalid/inactive/suspended. Returns [] if store has 0 collections.
   */
  async getCollections(slug: string): Promise<PublicCollectionsList | null> {
    if (!(await this.isEngineReadEnabled())) {
      return null;
    }

    const cleanSlug = slug?.trim().toLowerCase();
    if (!cleanSlug) return null;

    return this.db.withPublic(async (tx) => {
      const rows = rowsOf<{ cols: unknown }>(
        await tx.execute(
          sql`select public.get_public_collections(${cleanSlug}) as cols`,
        ),
      );
      const raw = rows[0]?.cols;
      if (raw === null || raw === undefined) {
        return null;
      }
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return publicCollectionsListSchema.parse(data);
    });
  }
}
