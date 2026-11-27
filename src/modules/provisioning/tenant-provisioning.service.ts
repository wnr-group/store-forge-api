import { Injectable } from '@nestjs/common';
import { conflict } from '../../common/app.exception.js';
import { errorChain } from '../../common/db-errors.js';
import { generatePublicId } from '../../common/utils/public-id.js';
import { slugCandidates } from '../../common/utils/store-slug.js';
import { mapProvisioningError } from '../platform-admin/platform-errors.js';

/** Attempts at a free public id before giving up (a collision among 36^6 values is already very unlikely). */
const PUBLIC_ID_ATTEMPTS = 5;

/**
 * The retry rules every way of creating a tenant shares. The records themselves are written by ONE SQL routine,
 * `provision_tenant_internal` (migration 0070), which `platform_provision_tenant` (Platform Admin) and `signup_provision` (a customer
 * who has paid) both call; this service wraps those calls so they behave the same:
 *
 *  - the public id is generated here (Node crypto), never taken from a request, and a collision is retried with a fresh one;
 *  - a store address derived from a store name is retried with a suffix when it is taken or not allowed;
 *  - SQL error codes become client-safe errors.
 *
 * Each `attempt` is a separate database transaction, so a failed attempt leaves nothing half-written behind.
 */
@Injectable()
export class TenantProvisioningService {
  /** Runs `attempt` with a fresh public id, again with another one if the id turns out to be taken. */
  async withPublicId<T>(attempt: (publicId: string) => Promise<T>): Promise<T> {
    for (let n = 1; ; n++) {
      try {
        return await attempt(generatePublicId());
      } catch (error) {
        if (
          errorChain(error).includes('public_id_taken') &&
          n < PUBLIC_ID_ATTEMPTS
        )
          continue;
        return mapProvisioningError(error);
      }
    }
  }

  /**
   * For a customer who only typed a store name: tries the addresses derived from it until one is free and allowed. A name that is
   * simply the same as another store's is fine, it only gets a different address.
   */
  async withStoreSlug<T>(
    storeName: string,
    attempt: (slug: string, publicId: string) => Promise<T>,
  ): Promise<T> {
    for (const slug of slugCandidates(storeName)) {
      try {
        return await this.withPublicId((publicId) => attempt(slug, publicId));
      } catch (error) {
        const codes = errorChain(error);
        const code = (error as { code?: unknown }).code;
        if (
          code === 'STORE_SLUG_TAKEN' ||
          code === 'STORE_SLUG_INVALID' ||
          codes.includes('slug_taken') ||
          codes.includes('invalid_slug')
        )
          continue;
        throw error;
      }
    }
    throw conflict(
      'We could not find a free address for that store name. Try a slightly different name.',
      { storeName: 'Try a different name' },
      'STORE_SLUG_TAKEN',
    );
  }
}
