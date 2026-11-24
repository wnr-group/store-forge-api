import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppException, notFound } from '../../common/app.exception.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import type { AbandonedCartItem } from '../../database/schema/marketing.js';
import { loadCatalog } from '../orders/catalog-loader.js';
import type {
  CartConversion,
  CheckoutCartTracker,
} from '../orders/checkout-hooks.js';
import { NO_TENANT } from '../orders/checkout.service.js';
import { priceLines, type RequestedLine } from '../orders/checkout-pricing.js';
import { heldQuantities } from '../orders/stock-reservations.js';
import { CredentialsKeyError } from '../payments/credentials-key.js';
import type {
  CartCheckpointDto,
  CartCheckpointResultDto,
  CartRecoveryDto,
} from './abandoned-carts.dto.js';
import {
  cartKeyHash,
  looksLikeRecoveryToken,
  recoveryTokenFor,
  recoveryTokenHash,
} from './recovery-token.js';

/** An item as saved: the slug is what lets the cart be rebuilt later; prices are only a snapshot. */
type SavedItem = AbandonedCartItem & { productSlug: string };

const notAvailable = () =>
  notFound('This link no longer works.', 'RECOVERY_LINK_INVALID');

/**
 * The storefront side of abandoned carts. Everything here runs as the tenant-pinned checkout role and writes only through the
 * SECURITY DEFINER functions of migration 0055. The browser says WHICH products and how many; names and prices are always the
 * server's own. Nothing here ever contacts a shopper.
 */
@Injectable()
export class CartRecoveryService implements CheckoutCartTracker {
  private readonly logger = new Logger(CartRecoveryService.name);

  constructor(private readonly db: DatabaseService) {}

  /** Saves (or refreshes) the cart of a shopper who gave an email. */
  async checkpoint(
    store: { tenantId: string; currency: string },
    dto: CartCheckpointDto,
  ): Promise<CartCheckpointResultDto> {
    const requested: RequestedLine[] = dto.lines.map((l) => ({
      productSlug: l.productSlug,
      variantId: l.variantId ?? null,
      quantity: l.quantity,
    }));
    const cartId = randomUUID();
    let tokenHash: string;
    try {
      tokenHash = recoveryTokenHash(recoveryTokenFor(store.tenantId, cartId));
    } catch (error) {
      // No usable master key on the server: the feature is unavailable, the storefront is not.
      if (error instanceof CredentialsKeyError)
        throw new AppException(
          'UNAVAILABLE',
          'Cart recovery is not available right now.',
          { code: 'CART_RECOVERY_UNAVAILABLE' },
        );
      throw error;
    }

    return this.db.withCheckout(store.tenantId, async (tx) => {
      const { products, variants } = await loadCatalog(
        tx,
        store.tenantId,
        requested,
        false,
      );
      // Stock is not this step's business: keep every line that is a real, active product.
      const priced = priceLines(requested, products, variants, new Map());
      if (priced.lines.length === 0) return { saved: false };
      const slugOf = new Map(products.map((p) => [p.id, p.slug]));
      const items: SavedItem[] = priced.lines.map((l) => ({
        productId: l.productId,
        productSlug: slugOf.get(l.productId) ?? '',
        variantId: l.variantId,
        name: l.name,
        quantity: l.quantity,
        unitPriceMinor: l.unitPriceMinor,
      }));
      await tx.execute(sql`
        select public.checkpoint_abandoned_cart(${store.tenantId}::uuid, ${cartId}::uuid, ${cartKeyHash(dto.cartKey)},
          ${tokenHash}, ${dto.customer.email}, ${dto.customer.phone ?? null}, ${dto.customer.fullName ?? null},
          ${dto.marketingConsent ?? false}, ${JSON.stringify(items)}::jsonb, ${items.length}, ${priced.subtotalMinor},
          ${store.currency})`);
      return { saved: true };
    });
  }

  /** Opens a recovery link: what the cart held, priced now. The same answer for a wrong, spent and expired link. */
  async open(
    store: { tenantId: string },
    token: string,
  ): Promise<CartRecoveryDto> {
    if (!looksLikeRecoveryToken(token)) throw notAvailable();
    return this.db.withCheckout(store.tenantId, async (tx) => {
      const row = rowsOf<{
        items: SavedItem[] | string;
        email: string | null;
        customer_name: string | null;
      }>(
        await tx.execute(sql`
          select items, email, customer_name from public.open_cart_recovery(${store.tenantId}::uuid, ${recoveryTokenHash(token)})`),
      )[0];
      if (!row) throw notAvailable();
      const saved: SavedItem[] =
        typeof row.items === 'string'
          ? (JSON.parse(row.items) as SavedItem[])
          : row.items;
      const requested: RequestedLine[] = saved
        .filter((i) => i.productSlug)
        .map((i) => ({
          productSlug: i.productSlug,
          variantId: i.variantId,
          quantity: i.quantity,
        }));
      const { products, variants } = await loadCatalog(
        tx,
        store.tenantId,
        requested,
        false,
      );
      const held = await heldQuantities(
        tx,
        store.tenantId,
        products.map((p) => p.id),
      );
      const priced = priceLines(requested, products, variants, held);
      const slugOf = new Map(products.map((p) => [p.id, p.slug]));
      const wasPrice = new Map(
        saved.map((i) => [`${i.productId}:${i.variantId ?? '-'}`, i]),
      );
      return {
        email: row.email,
        customerName: row.customer_name,
        lines: priced.lines.map((l) => ({
          productSlug: slugOf.get(l.productId) ?? '',
          variantId: l.variantId,
          quantity: l.quantity,
          name: l.name,
          unitPriceMinor: l.unitPriceMinor,
          priceChanged:
            wasPrice.get(`${l.productId}:${l.variantId ?? '-'}`)
              ?.unitPriceMinor !== l.unitPriceMinor,
        })),
        issues: priced.issues,
      };
    });
  }

  /**
   * Deletes saved carts that have outlived their purpose (see migration 0058), a batch at a time, until none are left or `maxBatches`
   * is reached. Run by the scheduler; a failed batch stops the run and is reported, never thrown at the scheduler.
   */
  async purgeStale(
    batch = 2000,
    maxBatches = 20,
  ): Promise<{ deleted: number; complete: boolean }> {
    let deleted = 0;
    for (let i = 0; i < maxBatches; i += 1) {
      const n = await this.db.withCheckout(
        NO_TENANT,
        async (tx) =>
          rowsOf<{ n: number }>(
            await tx.execute(
              sql`select public.purge_stale_abandoned_carts(${batch}) as n`,
            ),
          )[0].n,
      );
      deleted += n;
      if (n < batch) return { deleted, complete: true };
    }
    return { deleted, complete: false };
  }

  /**
   * An order was placed: a cart that was only waiting is cleared, one that had been abandoned is marked recovered. This runs
   * after the order is saved and never fails it: tracking is not allowed to cost a sale.
   */
  async converted(conversion: CartConversion): Promise<void> {
    try {
      await this.db.withCheckout(conversion.tenantId, (tx: DbTx) =>
        tx.execute(sql`
          select public.mark_cart_converted(${conversion.tenantId}::uuid, ${conversion.orderNumber},
            ${conversion.cartKey ? cartKeyHash(conversion.cartKey) : null}, ${conversion.email})`),
      );
    } catch (error) {
      this.logger.warn(
        `cart conversion not recorded: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
  }
}
