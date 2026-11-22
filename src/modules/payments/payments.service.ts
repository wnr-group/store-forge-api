import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppException } from '../../common/app.exception.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import { listTeamRows } from '../team/team.service.js';
import { encryptSecret } from './credentials-crypto.js';
import { CredentialsKeyError } from './credentials-key.js';
import { maskKeyId, razorpayModeOf } from './key-id.js';
import type {
  RazorpayStatusDto,
  SaveRazorpayConfigDto,
} from './payments.dto.js';
import { PaymentsEventLogger } from './payments.logger.js';

/** Exact Owner-facing text for a missing or unusable encryption key. The frontend shows it unchanged. */
export const PAYMENTS_UNAVAILABLE_MESSAGE =
  'Payment settings are temporarily unavailable. Please contact support.';

/** The only columns the request role may read (column privileges); the secret columns are never selected. */
type StatusRow = {
  tenant_id: string;
  key_id: string;
  updated_at: string | Date;
  updated_by: string | null;
};

/**
 * Owner-only Razorpay credentials for one organization. Everything runs as the verified user inside one transaction, so
 * row level security and column privileges apply on top of the guards. The Key Secret is encrypted before it reaches the
 * database and is never read back, returned or logged.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly events: PaymentsEventLogger,
  ) {}

  get(org: OrgContext): Promise<RazorpayStatusDto> {
    return this.db.withUser(org.userId, (tx) => this.readStatus(tx, org));
  }

  async save(
    org: OrgContext,
    dto: SaveRazorpayConfigDto,
  ): Promise<RazorpayStatusDto> {
    // Encrypt first: a missing or unusable key fails here, before the database is touched, so nothing is written and an
    // existing configuration stays exactly as it was. The key is read lazily from the environment on every save.
    let encrypted: ReturnType<typeof encryptSecret>;
    try {
      encrypted = encryptSecret(dto.keySecret, org.tenantId);
    } catch (error) {
      if (error instanceof CredentialsKeyError) {
        this.events.keyFailure(error.category);
        throw new AppException('UNAVAILABLE', PAYMENTS_UNAVAILABLE_MESSAGE, {
          code: 'PAYMENTS_UNAVAILABLE',
        });
      }
      throw error;
    }

    const { status, replaced } = await this.db.withUser(
      org.userId,
      async (tx) => {
        // `replaced` comes from the write itself, not from an earlier read: DO NOTHING returns the row only when THIS statement
        // inserted it, so two concurrent first saves cannot both be recorded as a save. A conflict means a row already existed
        // (committed by another transaction), and the pair is then overwritten by the UPDATE. Bound parameters throughout, no
        // EXCLUDED, and RETURNING names only a granted column: nothing secret is read back. The status is a separate SELECT.
        const inserted = rowsOf(
          await tx.execute(sql`
            insert into public.tenant_razorpay_config
              (tenant_id, key_id, secret_ciphertext, iv, auth_tag, key_version, updated_at, updated_by)
            values (${org.tenantId}::uuid, ${dto.keyId}, ${encrypted.ciphertext}, ${encrypted.iv}, ${encrypted.authTag},
              ${encrypted.keyVersion}, now(), ${org.userId}::uuid)
            on conflict (tenant_id) do nothing
            returning tenant_id`),
        );
        if (inserted.length === 0) {
          await tx.execute(sql`
            update public.tenant_razorpay_config set
              key_id = ${dto.keyId}, secret_ciphertext = ${encrypted.ciphertext}, iv = ${encrypted.iv},
              auth_tag = ${encrypted.authTag}, key_version = ${encrypted.keyVersion}, updated_at = now(),
              updated_by = ${org.userId}::uuid
            where tenant_id = ${org.tenantId}::uuid`);
        }
        return {
          status: await this.readStatus(tx, org),
          replaced: inserted.length === 0,
        };
      },
    );
    this.events.record({
      actorUserId: org.userId,
      tenantId: org.tenantId,
      action: replaced ? 'replace' : 'save',
    });
    return status;
  }

  /** Hard delete. Idempotent, and it needs no encryption key. */
  async remove(org: OrgContext): Promise<RazorpayStatusDto> {
    const removed = await this.db.withUser(org.userId, async (tx) =>
      rowsOf(
        await tx.execute(
          sql`delete from public.tenant_razorpay_config where tenant_id = ${org.tenantId}::uuid returning tenant_id`,
        ),
      ),
    );
    // The row is gone, so this event is the only record of the removal. A repeated DELETE changes nothing and logs nothing.
    if (removed.length > 0)
      this.events.record({
        actorUserId: org.userId,
        tenantId: org.tenantId,
        action: 'remove',
      });
    return { configured: false };
  }

  private async readStatus(
    tx: DbTx,
    org: OrgContext,
  ): Promise<RazorpayStatusDto> {
    const rows = rowsOf<StatusRow>(
      await tx.execute(
        sql`select tenant_id, key_id, updated_at, updated_by from public.tenant_razorpay_config where tenant_id = ${org.tenantId}::uuid`,
      ),
    );
    const row = rows[0];
    if (!row) return { configured: false };
    // The person's name comes from the existing Owner-authorised team listing; a removed member has no entry (null).
    const team = row.updated_by ? await listTeamRows(tx, org.tenantId) : [];
    const updatedBy = team.find((m) => m.userId === row.updated_by);
    return {
      configured: true,
      keyIdMasked: maskKeyId(row.key_id),
      mode: razorpayModeOf(row.key_id),
      updatedAt: new Date(row.updated_at),
      updatedByName: updatedBy?.fullName ?? updatedBy?.email ?? null,
    };
  }
}
