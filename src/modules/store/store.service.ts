import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { conflict, invalid, notFound } from '../../common/app.exception.js';
import { mapErrors } from '../../common/db-errors.js';
import type {
  AuthUser,
  OrgContext,
} from '../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import {
  orders,
  products,
  stores,
  type Store,
} from '../../database/schema/index.js';
import { StorageReferencesService } from '../storage/storage-references.service.js';
import { storeFolder } from '../storage/storage-paths.js';
import type { StoreDto, UpdateStoreDto } from './store.dto.js';

export const toStoreDto = (s: Store, currencyLocked: boolean): StoreDto => ({
  id: s.id,
  name: s.name,
  slug: s.slug,
  description: s.description,
  logoPath: s.logoUrl,
  contactEmail: s.contactEmail,
  contactPhone: s.contactPhone,
  currency: s.currency,
  timezone: s.timezone,
  status: s.status,
  currencyLocked,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

/** Amounts are stored in the currency's minor units, so the currency is fixed once any exist. */
export async function hasMoneyData(
  tx: DbTx,
  tenantId: string,
): Promise<boolean> {
  const [p] = await tx
    .select({ id: products.id })
    .from(products)
    .where(eq(products.tenantId, tenantId))
    .limit(1);
  if (p) return true;
  const [o] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.tenantId, tenantId))
    .limit(1);
  return Boolean(o);
}

/** The organization's primary (oldest) store. */
export async function getPrimaryStoreInTx(
  tx: DbTx,
  tenantId: string,
): Promise<Store | null> {
  const [store] = await tx
    .select()
    .from(stores)
    .where(eq(stores.tenantId, tenantId))
    .orderBy(asc(stores.createdAt), asc(stores.id))
    .limit(1);
  return store ?? null;
}

@Injectable()
export class StoreService {
  constructor(
    private readonly db: DatabaseService,
    private readonly references: StorageReferencesService,
  ) {}

  async get(ctx: OrgContext): Promise<StoreDto> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const store = await getPrimaryStoreInTx(tx, ctx.tenantId);
      if (!store)
        throw notFound(
          'This workspace does not have a store.',
          'STORE_NOT_FOUND',
        );
      return toStoreDto(store, await hasMoneyData(tx, ctx.tenantId));
    });
  }

  /**
   * Updates the primary store. Same rules as the Next.js action: the store row is locked; the logo must be an
   * existing object directly under this organization's `store/` folder (verified under the path lock); the slug must
   * be available; the currency is locked once products or orders exist; the previous logo file is removed after the
   * update commits, if nothing else references it.
   */
  async update(
    ctx: OrgContext,
    user: AuthUser,
    dto: UpdateStoreDto,
  ): Promise<StoreDto> {
    const saved = await mapErrors(() =>
      this.db.withUser(ctx.userId, async (tx) => {
        const [store] = await tx
          .select()
          .from(stores)
          .where(eq(stores.tenantId, ctx.tenantId))
          .orderBy(asc(stores.createdAt), asc(stores.id))
          .limit(1)
          .for('update');
        if (!store)
          throw notFound(
            'This workspace does not have a store.',
            'STORE_NOT_FOUND',
          );

        const next = {
          name: dto.name ?? store.name,
          slug: dto.slug ?? store.slug,
          description:
            dto.description !== undefined ? dto.description : store.description,
          contactEmail:
            dto.contactEmail !== undefined
              ? dto.contactEmail
              : store.contactEmail,
          contactPhone:
            dto.contactPhone !== undefined
              ? dto.contactPhone
              : store.contactPhone,
          currency: dto.currency ?? store.currency,
          timezone: dto.timezone ?? store.timezone,
          logoPath: dto.logoPath !== undefined ? dto.logoPath : store.logoUrl,
        };

        // Lock the path, THEN check the object exists (see StorageReferencesService.verifyObjectsUnderLock).
        let logo: string | null = null;
        if (next.logoPath) {
          logo =
            next.logoPath === store.logoUrl
              ? store.logoUrl
              : (
                  await this.references.verifyObjectsUnderLock(
                    tx,
                    user.token,
                    storeFolder(ctx.tenantId),
                    [next.logoPath],
                  )
                )[0].path;
          // Locked so a path cannot be saved as both the logo and the template hero image at the same time.
          const clash = rowsOf<{ one: number }>(
            await tx.execute(
              sql`select 1 as one from public.store_template_settings where store_id = ${store.id} and hero_image_path = ${logo} limit 1`,
            ),
          );
          if (clash.length)
            throw invalid(
              'That image is already used as the template hero image. Upload a different image.',
              { logoPath: 'Already used as the hero image' },
              'LOGO_IN_USE_AS_HERO',
            );
        }

        if (next.slug !== store.slug) {
          const rows = rowsOf<{ ok: boolean }>(
            await tx.execute(
              sql`select public.is_store_slug_available(${next.slug}) as ok`,
            ),
          );
          if (!rows[0]?.ok)
            throw conflict(
              'That store address is not available.',
              { slug: 'This store address is not available.' },
              'STORE_SLUG_TAKEN',
            );
        }
        if (
          next.currency !== store.currency &&
          (await hasMoneyData(tx, ctx.tenantId))
        )
          throw invalid(
            'Currency cannot be changed once you have products or orders.',
            { currency: 'Locked: prices already exist' },
            'CURRENCY_LOCKED',
          );

        const [row] = await tx
          .update(stores)
          .set({
            name: next.name,
            slug: next.slug,
            description: next.description,
            contactEmail: next.contactEmail,
            contactPhone: next.contactPhone,
            currency: next.currency,
            timezone: next.timezone,
            logoUrl: logo,
          })
          .where(
            and(eq(stores.id, store.id), eq(stores.tenantId, ctx.tenantId)),
          )
          .returning();
        return {
          store: row,
          previousLogo: store.logoUrl,
          currencyLocked: await hasMoneyData(tx, ctx.tenantId),
        };
      }),
    );

    if (saved.previousLogo && saved.previousLogo !== saved.store.logoUrl)
      await this.references.removeUnreferencedObjects(user, ctx.tenantId, [
        saved.previousLogo,
      ]);
    return toStoreDto(saved.store, saved.currencyLocked);
  }
}
