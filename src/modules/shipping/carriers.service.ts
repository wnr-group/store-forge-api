import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  AppException,
  conflict,
  forbidden,
  notFound,
} from '../../common/app.exception.js';
import { Paginated } from '../../common/dto/api-response.dto.js';
import { offsetOf } from '../../common/dto/pagination-query.dto.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import type { CarrierEventAction } from '../../database/schema/shipping.js';
import { encryptSecret } from '../payments/credentials-crypto.js';
import { CredentialsKeyError } from '../payments/credentials-key.js';
import { listTeamRows } from '../team/team.service.js';
import type {
  CarrierCheckDto,
  CarrierConnectionDto,
  CarrierDto,
  CarrierEventDto,
  CarrierEventsQueryDto,
  SavePreferencesDto,
  SetCarrierDefaultDto,
  SetCarrierEnabledDto,
  ShippingPreferencesDto,
} from './carriers.dto.js';
import {
  loadCarrierConnections,
  mergeCredentials,
  toCredentials,
  type StoredCarrierConnection,
} from './carrier-credentials.js';
import { ShippingProviderRegistry } from './providers/provider-registry.js';
import {
  CarrierError,
  type ShippingProvider,
} from './providers/shipping-provider.js';

/** A Postgres text[] literal. The driver would spread a JavaScript array into a comma list, which is not one. */
const pgTextArray = (values: readonly string[]) =>
  `{${values.map((v) => `"${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`;

export const SHIPPING_UNAVAILABLE_MESSAGE =
  'Shipping settings are temporarily unavailable. Please contact support.';

interface Row {
  provider_code: string;
  settings: Record<string, string> | string;
  secret_keys: string[];
  enabled: boolean;
  is_default: boolean;
  verification_status: 'unverified' | 'verified' | 'failed';
  verified_at: string | Date | null;
  verification_error: string | null;
  updated_at: string | Date;
  updated_by: string | null;
}

const NOT_CONNECTED: CarrierConnectionDto = {
  connected: false,
  enabled: false,
  isDefault: false,
  verificationStatus: 'unverified',
  verifiedAt: null,
  verificationError: null,
  settings: {},
  secretFieldsSaved: [],
  updatedAt: null,
  updatedByName: null,
};

/**
 * An Owner's carrier accounts. Secrets are encrypted before they reach the database and are never returned. The guard has
 * already established that the caller is the Owner; every statement still runs as that user (row level security) or through a
 * database function that checks the Owner role again. Reading secrets back (to test or use them) happens only through the
 * tenant-pinned checkout role, in memory.
 */
@Injectable()
export class CarriersService {
  private readonly logger = new Logger(CarriersService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: ShippingProviderRegistry,
  ) {}

  // --- reading ---------------------------------------------------------------------------------------------------------

  async list(org: OrgContext): Promise<CarrierDto[]> {
    const connections = await this.db.withUser(org.userId, (tx) =>
      this.readConnections(tx, org),
    );
    return this.registry.describe().map((p) => ({
      code: p.code,
      name: p.name,
      capabilities: p.capabilities,
      integrationStatus: p.integrationStatus,
      integrationNotes: p.integrationNotes,
      credentialFields: p.credentialFields.map((f) => ({
        ...f,
        options: f.options ? [...f.options] : undefined,
      })),
      connection: connections.get(p.code) ?? NOT_CONNECTED,
    }));
  }

  async get(org: OrgContext, code: string): Promise<CarrierDto> {
    this.provider(code);
    return (await this.list(org)).find((c) => c.code === code)!;
  }

  async events(org: OrgContext, q: CarrierEventsQueryDto) {
    const where = sql`where tenant_id = ${org.tenantId}::uuid ${q.action ? sql`and action = ${q.action}` : sql``}`;
    return this.db.withUser(org.userId, async (tx) => {
      const rows = rowsOf<{
        id: string;
        provider_code: string;
        action: string;
        actor_id: string | null;
        note: string | null;
        created_at: string;
      }>(
        await tx.execute(sql`
          select id, provider_code, action, actor_id, note, created_at from public.carrier_connection_events ${where}
          order by created_at desc, id limit ${q.limit} offset ${offsetOf(q)}`),
      );
      const total = rowsOf<{ n: number }>(
        await tx.execute(
          sql`select count(*)::int as n from public.carrier_connection_events ${where}`,
        ),
      )[0].n;
      const team = await listTeamRows(tx, org.tenantId);
      const items: CarrierEventDto[] = rows.map((r) => {
        const person = team.find((m) => m.userId === r.actor_id);
        return {
          id: r.id,
          providerCode: r.provider_code,
          action: r.action,
          actorName: person?.fullName ?? person?.email ?? null,
          note: r.note,
          createdAt: new Date(r.created_at),
        };
      });
      return new Paginated(items, { page: q.page, limit: q.limit, total });
    });
  }

  // --- connecting ------------------------------------------------------------------------------------------------------

  /** Connects a carrier, or updates its settings. Anything changed switches the carrier off until it is checked again. */
  async save(
    org: OrgContext,
    code: string,
    values: Record<string, unknown>,
  ): Promise<CarrierDto> {
    const provider = this.provider(code);
    const existing = await this.stored(org, code);
    const merged = mergeCredentials(
      provider.credentialFields,
      existing,
      values,
    );
    if (existing && merged.changed.length === 0) return this.get(org, code); // nothing to change: keep the verification

    let encrypted: ReturnType<typeof encryptSecret>;
    try {
      encrypted = encryptSecret(JSON.stringify(merged.secrets), org.tenantId);
    } catch (error) {
      if (error instanceof CredentialsKeyError)
        this.logger.error({
          event: 'carrier.key_failure',
          category: error.category,
        });
      throw this.unavailable();
    }
    const secretKeys = Object.keys(merged.secrets);
    await this.db.withUser(org.userId, async (tx) => {
      await tx.execute(sql`
        insert into public.tenant_carrier_connections
          (tenant_id, provider_code, settings, secret_keys, secrets_ciphertext, iv, auth_tag, key_version, created_by, updated_by, updated_at)
        values (${org.tenantId}::uuid, ${code}, ${JSON.stringify(merged.settings)}::jsonb, ${pgTextArray(secretKeys)}::text[], ${encrypted.ciphertext},
          ${encrypted.iv}, ${encrypted.authTag}, ${encrypted.keyVersion}, ${org.userId}::uuid, ${org.userId}::uuid, now())
        on conflict (tenant_id, provider_code) do update set
          settings = ${JSON.stringify(merged.settings)}::jsonb, secret_keys = ${pgTextArray(secretKeys)}::text[], secrets_ciphertext = ${encrypted.ciphertext},
          iv = ${encrypted.iv}, auth_tag = ${encrypted.authTag}, key_version = ${encrypted.keyVersion},
          updated_by = ${org.userId}::uuid, updated_at = now()`);
      await this.record(
        tx,
        org,
        code,
        existing ? 'update' : 'connect',
        existing
          ? `Changed: ${merged.changed.join(', ')}`
          : `Set: ${merged.changed.join(', ')}`,
      );
    });
    return this.get(org, code);
  }

  /** Tries settings against the carrier WITHOUT saving them, so the Owner can check before committing. */
  async test(
    org: OrgContext,
    code: string,
    values: Record<string, unknown>,
  ): Promise<CarrierCheckDto> {
    const provider = this.provider(code);
    const existing = await this.stored(org, code);
    const merged = mergeCredentials(
      provider.credentialFields,
      existing,
      values,
    );
    return this.check(provider, toCredentials(merged));
  }

  /** Checks the SAVED settings with the carrier and records the result. */
  async verify(org: OrgContext, code: string): Promise<CarrierDto> {
    const provider = this.provider(code);
    const existing = await this.stored(org, code);
    if (!existing)
      throw notFound('Connect this carrier first.', 'CARRIER_NOT_CONNECTED');
    const result = await this.check(provider, toCredentials(existing));
    await this.db.withUser(org.userId, async (tx) => {
      await tx.execute(
        sql`select public.record_carrier_verification(${org.tenantId}::uuid, ${code}, ${result.valid}, ${result.valid ? null : result.message})`,
      );
      await this.record(
        tx,
        org,
        code,
        result.valid ? 'verify' : 'verify_failed',
        result.valid ? null : result.message,
      );
    });
    return this.get(org, code);
  }

  async setEnabled(
    org: OrgContext,
    code: string,
    dto: SetCarrierEnabledDto,
  ): Promise<CarrierDto> {
    const provider = this.provider(code);
    // "Not connected" comes before any question about acknowledging: there is nothing to acknowledge yet.
    if (dto.enabled && !(await this.isConnected(org, code)))
      throw notFound('Connect this carrier first.', 'CARRIER_NOT_CONNECTED');
    if (
      dto.enabled &&
      provider.integrationStatus === 'unverified' &&
      dto.acknowledgeUnverifiedIntegration !== true
    )
      throw new AppException(
        'CONFLICT',
        `The ${provider.name} integration has not been checked against ${provider.name}'s real service yet. Confirm that you want to use it anyway.`,
        { code: 'INTEGRATION_UNVERIFIED' },
      );
    await this.change(
      org,
      code,
      'set_carrier_enabled',
      dto.enabled,
      dto.enabled ? 'enable' : 'disable',
    );
    return this.get(org, code);
  }

  async setDefault(
    org: OrgContext,
    code: string,
    dto: SetCarrierDefaultDto,
  ): Promise<CarrierDto> {
    this.provider(code);
    await this.change(
      org,
      code,
      'set_carrier_default',
      dto.isDefault,
      dto.isDefault ? 'set_default' : 'unset_default',
    );
    return this.get(org, code);
  }

  private async isConnected(org: OrgContext, code: string): Promise<boolean> {
    return this.db.withUser(
      org.userId,
      async (tx) =>
        rowsOf(
          await tx.execute(
            sql`select 1 from public.tenant_carrier_connections where tenant_id = ${org.tenantId}::uuid and provider_code = ${code}`,
          ),
        ).length > 0,
    );
  }

  /** Removes the connection and its credentials for good. */
  async disconnect(org: OrgContext, code: string): Promise<void> {
    this.provider(code);
    await this.db.withUser(org.userId, async (tx) => {
      const removed = rowsOf<{ id: string }>(
        await tx.execute(
          sql`delete from public.tenant_carrier_connections where tenant_id = ${org.tenantId}::uuid and provider_code = ${code} returning id`,
        ),
      );
      if (removed.length === 0)
        throw notFound(
          'This carrier is not connected.',
          'CARRIER_NOT_CONNECTED',
        );
      await this.record(tx, org, code, 'disconnect', null);
    });
  }

  // --- preferences -----------------------------------------------------------------------------------------------------

  async preferences(org: OrgContext): Promise<ShippingPreferencesDto> {
    return this.db.withUser(org.userId, async (tx) =>
      this.readPreferences(tx, org),
    );
  }

  async savePreferences(
    org: OrgContext,
    dto: SavePreferencesDto,
  ): Promise<ShippingPreferencesDto> {
    return this.db.withUser(org.userId, async (tx) => {
      await tx.execute(sql`
        insert into public.tenant_shipping_preferences (tenant_id, selection_mode, strategy, updated_at, updated_by)
        values (${org.tenantId}::uuid, ${dto.selectionMode}, ${dto.strategy}, now(), ${org.userId}::uuid)
        on conflict (tenant_id) do update set selection_mode = ${dto.selectionMode}, strategy = ${dto.strategy},
          updated_at = now(), updated_by = ${org.userId}::uuid`);
      return this.readPreferences(tx, org);
    });
  }

  // --- internals -------------------------------------------------------------------------------------------------------

  private provider(code: string): ShippingProvider {
    if (!this.registry.has(code))
      throw notFound(
        'That shipping carrier is not supported.',
        'CARRIER_NOT_SUPPORTED',
      );
    return this.registry.get(code);
  }

  private unavailable() {
    return new AppException('UNAVAILABLE', SHIPPING_UNAVAILABLE_MESSAGE, {
      code: 'SHIPPING_UNAVAILABLE',
    });
  }

  /** The decrypted saved connection, read as the tenant-pinned role. Failure to decrypt is a generic 503. */
  private async stored(
    org: OrgContext,
    code: string,
  ): Promise<StoredCarrierConnection | null> {
    try {
      return (
        (
          await this.db.withCheckout(org.tenantId, (tx) =>
            loadCarrierConnections(tx, org.tenantId, code),
          )
        )[0] ?? null
      );
    } catch (error) {
      this.logger.error({
        event: 'carrier.credentials_unreadable',
        tenantId: org.tenantId,
        name: (error as Error).name,
      });
      throw this.unavailable();
    }
  }

  /** Asks the carrier. A refusal is an answer ("not valid"); an outage is an error and changes nothing. */
  private async check(
    provider: ShippingProvider,
    creds: Record<string, string>,
  ): Promise<CarrierCheckDto> {
    try {
      return await provider.validateCredentials(creds);
    } catch (error) {
      if (!(error instanceof CarrierError)) throw error;
      if (error.kind === 'unavailable')
        throw new AppException(
          'UNAVAILABLE',
          `${provider.name} could not be reached. Please try again in a moment.`,
          {
            code: 'CARRIER_UNAVAILABLE',
          },
        );
      this.logger.warn({
        event: 'carrier.check_failed',
        provider: provider.code,
        kind: error.kind,
      });
      return {
        valid: false,
        message:
          error.kind === 'invalid_input'
            ? error.message
            : error.kind === 'unsupported'
              ? `${provider.name} cannot be checked automatically.`
              : `${provider.name} did not accept these settings.`,
      };
    }
  }

  private async change(
    org: OrgContext,
    code: string,
    fn: 'set_carrier_enabled' | 'set_carrier_default',
    value: boolean,
    action: CarrierEventAction,
  ) {
    await this.db.withUser(org.userId, async (tx) => {
      const result = rowsOf<{ r: string }>(
        await tx.execute(
          fn === 'set_carrier_enabled'
            ? sql`select public.set_carrier_enabled(${org.tenantId}::uuid, ${code}, ${value}) as r`
            : sql`select public.set_carrier_default(${org.tenantId}::uuid, ${code}, ${value}) as r`,
        ),
      )[0]?.r;
      if (result === 'forbidden') throw forbidden();
      if (result === 'not_connected')
        throw notFound('Connect this carrier first.', 'CARRIER_NOT_CONNECTED');
      if (result === 'not_verified')
        throw conflict(
          'Check the connection to this carrier successfully before turning it on.',
          undefined,
          'CARRIER_NOT_VERIFIED',
        );
      if (result === 'not_enabled')
        throw conflict(
          'Turn this carrier on before making it the default.',
          undefined,
          'CARRIER_NOT_ENABLED',
        );
      await this.record(tx, org, code, action, null);
    });
  }

  private async record(
    tx: DbTx,
    org: OrgContext,
    code: string,
    action: CarrierEventAction,
    note: string | null,
  ) {
    await tx.execute(sql`
      insert into public.carrier_connection_events (tenant_id, provider_code, action, actor_id, note)
      values (${org.tenantId}::uuid, ${code}, ${action}, ${org.userId}::uuid, ${note?.slice(0, 300) ?? null})`);
    this.logger.log({
      event: 'carrier.changed',
      tenantId: org.tenantId,
      provider: code,
      action,
    });
  }

  private async readConnections(
    tx: DbTx,
    org: OrgContext,
  ): Promise<Map<string, CarrierConnectionDto>> {
    const rows = rowsOf<Row>(
      await tx.execute(sql`
        select provider_code, settings, secret_keys, enabled, is_default, verification_status, verified_at, verification_error, updated_at, updated_by
        from public.tenant_carrier_connections where tenant_id = ${org.tenantId}::uuid`),
    );
    const team = rows.length ? await listTeamRows(tx, org.tenantId) : [];
    return new Map(
      rows.map((r) => {
        const person = team.find((m) => m.userId === r.updated_by);
        return [
          r.provider_code,
          {
            connected: true,
            enabled: r.enabled,
            isDefault: r.is_default,
            verificationStatus: r.verification_status,
            verifiedAt: r.verified_at ? new Date(r.verified_at) : null,
            verificationError: r.verification_error,
            settings:
              typeof r.settings === 'string'
                ? (JSON.parse(r.settings) as Record<string, string>)
                : r.settings,
            secretFieldsSaved: [...r.secret_keys],
            updatedAt: new Date(r.updated_at),
            updatedByName: person?.fullName ?? person?.email ?? null,
          },
        ] as const;
      }),
    );
  }

  private async readPreferences(
    tx: DbTx,
    org: OrgContext,
  ): Promise<ShippingPreferencesDto> {
    const prefs = rowsOf<{
      selection_mode: string;
      strategy: string;
      updated_at: string;
    }>(
      await tx.execute(sql`
        select selection_mode, strategy, updated_at from public.tenant_shipping_preferences where tenant_id = ${org.tenantId}::uuid`),
    )[0];
    const carriers = rowsOf<{ provider_code: string; is_default: boolean }>(
      await tx.execute(sql`
        select provider_code, is_default from public.tenant_carrier_connections where tenant_id = ${org.tenantId}::uuid and enabled`),
    );
    return {
      selectionMode: prefs?.selection_mode ?? 'manual',
      strategy: prefs?.strategy ?? 'lowest_cost',
      activeCarrierCount: carriers.length,
      defaultCarrier: carriers.find((c) => c.is_default)?.provider_code ?? null,
      updatedAt: prefs ? new Date(prefs.updated_at) : null,
    };
  }
}
