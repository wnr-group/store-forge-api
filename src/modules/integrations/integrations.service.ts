import { Injectable } from '@nestjs/common';
import { PROVIDER_FEATURE } from '../../common/constants/plan-catalog.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { sql } from 'drizzle-orm';
import {
  conflict,
  forbidden,
  invalid,
  notFound,
} from '../../common/app.exception.js';
import { mapErrors } from '../../common/db-errors.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import type { IntegrationEventAction } from '../../database/schema/marketing.js';
import type {
  IntegrationDetailDto,
  IntegrationDto,
  IntegrationTestResultDto,
  TrackingConfigDto,
} from './integrations.dto.js';
import type { IntegrationProvider } from './providers/integration-provider.js';
import { findProvider, listProviders } from './providers/provider-registry.js';

/**
 * Only these columns are ever read back: the encrypted-secret columns of the table are not granted to the request role at all,
 * and nothing in this file selects or returns one. Config holds public identifiers only.
 */
interface Row {
  provider_code: string;
  config: Record<string, string> | string;
  enabled: boolean;
  validation_status: 'unverified' | 'valid' | 'invalid';
  validation_error: string | null;
  validated_at: string | Date | null;
  updated_at: string | Date;
  updated_by: string | null;
}

const COLUMNS = sql`provider_code, config, enabled, validation_status, validation_error, validated_at, updated_at, updated_by`;

const configOf = (r: Row): Record<string, string> =>
  typeof r.config === 'string'
    ? (JSON.parse(r.config) as Record<string, string>)
    : r.config;

const toDto = (
  p: IntegrationProvider,
  r: Row | undefined,
  userId: string,
): IntegrationDto => ({
  provider: p.code,
  name: p.name,
  description: p.description,
  fields: p.fields.map((f) => ({ ...f })),
  configured: !!r,
  enabled: r?.enabled ?? false,
  status: !r ? 'not_configured' : r.enabled ? 'enabled' : 'disabled',
  validationStatus: r?.validation_status ?? null,
  validationError: r?.validation_error ?? null,
  validatedAt: r?.validated_at ? new Date(r.validated_at) : null,
  config: r ? configOf(r) : {},
  updatedAt: r ? new Date(r.updated_at) : null,
  updatedByYou: !!r && r.updated_by === userId,
});

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** Connecting, validating and switching ON need the plan to include the provider; switching off and removing never do. */
  private requireProviderFeature(ctx: OrgContext, code: string) {
    const feature = PROVIDER_FEATURE[code];
    return feature
      ? this.entitlements.assertFeatureAs(ctx.userId, ctx.tenantId, feature)
      : Promise.resolve();
  }

  private provider(code: string): IntegrationProvider {
    const p = findProvider(code);
    if (!p)
      throw notFound(
        'That integration does not exist.',
        'INTEGRATION_NOT_FOUND',
      );
    return p;
  }

  private async row(
    tx: DbTx,
    tenantId: string,
    code: string,
  ): Promise<Row | undefined> {
    return rowsOf<Row>(
      await tx.execute(sql`
        select ${COLUMNS} from public.marketing_integrations
        where tenant_id = ${tenantId}::uuid and provider_code = ${code}`),
    )[0];
  }

  /** One row per integration the application supports, saved or not, so the page can show them all. */
  async list(ctx: OrgContext): Promise<IntegrationDto[]> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const rows = rowsOf<Row>(
        await tx.execute(sql`
          select ${COLUMNS} from public.marketing_integrations where tenant_id = ${ctx.tenantId}::uuid`),
      );
      return listProviders().map((p) =>
        toDto(
          p,
          rows.find((r) => r.provider_code === p.code),
          ctx.userId,
        ),
      );
    });
  }

  async get(ctx: OrgContext, code: string): Promise<IntegrationDetailDto> {
    const p = this.provider(code);
    return this.db.withUser(ctx.userId, (tx) => this.detail(tx, ctx, p));
  }

  private async detail(
    tx: DbTx,
    ctx: OrgContext,
    p: IntegrationProvider,
  ): Promise<IntegrationDetailDto> {
    const [row, events] = await Promise.all([
      this.row(tx, ctx.tenantId, p.code),
      tx.execute(sql`
        select action, note, actor_id, created_at from public.marketing_integration_events
        where tenant_id = ${ctx.tenantId}::uuid and provider_code = ${p.code}
        order by created_at desc, id desc limit 20`),
    ]);
    return Object.assign(toDto(p, row, ctx.userId), {
      history: rowsOf<{
        action: string;
        note: string | null;
        actor_id: string | null;
        created_at: string | Date;
      }>(events).map((e) => ({
        action: e.action,
        note: e.note,
        byYou: e.actor_id === ctx.userId,
        createdAt: new Date(e.created_at),
      })),
    });
  }

  private async audit(
    tx: DbTx,
    ctx: OrgContext,
    code: string,
    action: IntegrationEventAction,
    note: string | null = null,
  ) {
    await tx.execute(sql`
      insert into public.marketing_integration_events (tenant_id, provider_code, action, actor_id, note, created_at)
      values (${ctx.tenantId}::uuid, ${code}, ${action}, ${ctx.userId}::uuid, ${note}, clock_timestamp())`);
  }

  /**
   * Saves the configuration and validates it (the provider's own rules). A changed identifier switches the integration off until it
   * is enabled again; saving what is already saved changes nothing and writes no audit entry.
   */
  async save(
    ctx: OrgContext,
    code: string,
    input: Record<string, unknown>,
  ): Promise<IntegrationDetailDto> {
    const p = this.provider(code);
    await this.requireProviderFeature(ctx, p.code);
    const parsed = p.parse(input);
    if (!parsed.ok)
      throw invalid(
        'Please fix the highlighted fields.',
        parsed.errors,
        'INTEGRATION_CONFIG_INVALID',
      );
    return mapErrors(() =>
      this.db.withUser(ctx.userId, async (tx) => {
        const existing = await this.row(tx, ctx.tenantId, p.code);
        const config = JSON.stringify(parsed.config);
        if (!existing) {
          await tx.execute(sql`
            insert into public.marketing_integrations (tenant_id, provider_code, config, created_by, updated_by, updated_at)
            values (${ctx.tenantId}::uuid, ${p.code}, ${config}::jsonb, ${ctx.userId}::uuid, ${ctx.userId}::uuid, now())`);
          await this.audit(tx, ctx, p.code, 'configure', 'Configuration saved');
        } else if (
          JSON.stringify(configOf(existing)) !== JSON.stringify(parsed.config)
        ) {
          await tx.execute(sql`
            update public.marketing_integrations set config = ${config}::jsonb, updated_by = ${ctx.userId}::uuid, updated_at = now()
            where tenant_id = ${ctx.tenantId}::uuid and provider_code = ${p.code}`);
          await this.audit(
            tx,
            ctx,
            p.code,
            'update',
            existing.enabled
              ? 'Settings changed; switched off until enabled again'
              : 'Settings changed',
          );
        }
        // The provider's rules accepted it, so it is valid (a changed configuration was just reset to unverified).
        const now = await this.row(tx, ctx.tenantId, p.code);
        if (now && now.validation_status !== 'valid') {
          await this.recordValidation(tx, ctx, p.code, true, null);
          await this.audit(
            tx,
            ctx,
            p.code,
            'validate',
            'Settings passed validation',
          );
        }
        return this.detail(tx, ctx, p);
      }),
    );
  }

  private async recordValidation(
    tx: DbTx,
    ctx: OrgContext,
    code: string,
    ok: boolean,
    error: string | null,
  ) {
    const r = rowsOf<{ r: string }>(
      await tx.execute(sql`
        select public.record_marketing_integration_validation(${ctx.tenantId}::uuid, ${code}, ${ok}, ${error}) as r`),
    )[0].r;
    if (r === 'forbidden') throw forbidden();
    if (r === 'not_configured') throw this.notConfigured();
  }

  private notConfigured() {
    return notFound(
      'This integration has not been configured yet.',
      'INTEGRATION_NOT_CONFIGURED',
    );
  }

  async setEnabled(
    ctx: OrgContext,
    code: string,
    enabled: boolean,
  ): Promise<IntegrationDetailDto> {
    const p = this.provider(code);
    if (enabled) await this.requireProviderFeature(ctx, p.code);
    return this.db.withUser(ctx.userId, async (tx) => {
      const r = rowsOf<{ r: string }>(
        await tx.execute(sql`
          select public.set_marketing_integration_enabled(${ctx.tenantId}::uuid, ${p.code}, ${enabled}) as r`),
      )[0].r;
      if (r === 'forbidden') throw forbidden();
      if (r === 'not_configured') throw this.notConfigured();
      if (r === 'not_valid')
        throw conflict(
          'Validate the configuration before switching this on.',
          undefined,
          'INTEGRATION_NOT_VALID',
        );
      await this.audit(tx, ctx, p.code, enabled ? 'enable' : 'disable');
      return this.detail(tx, ctx, p);
    });
  }

  /** Checks the saved configuration against the outside world. A failure never switches an integration off: it is only reported. */
  async test(ctx: OrgContext, code: string): Promise<IntegrationTestResultDto> {
    const p = this.provider(code);
    await this.requireProviderFeature(ctx, p.code);
    const saved = await this.db.withUser(ctx.userId, (tx) =>
      this.row(tx, ctx.tenantId, p.code),
    );
    if (!saved) throw this.notConfigured();
    // The outside call is made with no transaction open.
    const checks = await p.test(configOf(saved));
    const ok = checks.every((c) => c.ok);
    await this.db.withUser(ctx.userId, async (tx) => {
      if (ok) await this.recordValidation(tx, ctx, p.code, true, null);
      await this.audit(
        tx,
        ctx,
        p.code,
        ok ? 'validate' : 'validate_failed',
        ok
          ? 'Test passed'
          : `Test failed: ${checks
              .filter((c) => !c.ok)
              .map((c) => c.name)
              .join(', ')}`.slice(0, 300),
      );
    });
    return { ok, checks, note: p.testNote };
  }

  /** Removes the configuration. The audit trail of what happened to it stays. */
  async remove(ctx: OrgContext, code: string): Promise<void> {
    const p = this.provider(code);
    await this.db.withUser(ctx.userId, async (tx) => {
      if (!(await this.row(tx, ctx.tenantId, p.code)))
        throw this.notConfigured();
      await this.audit(tx, ctx, p.code, 'remove');
      await tx.execute(sql`
        delete from public.marketing_integrations where tenant_id = ${ctx.tenantId}::uuid and provider_code = ${p.code}`);
    });
  }

  /** What the storefront of one store may load: enabled and validated integrations, public identifiers only. */
  async trackingFor(tenantId: string): Promise<TrackingConfigDto> {
    return this.db.withCheckout(tenantId, async (tx) => {
      const rows = rowsOf<{
        provider_code: string;
        config: Record<string, string> | string;
      }>(
        await tx.execute(
          sql`select provider_code, config from public.public_tracking_config(${tenantId}::uuid)`,
        ),
      );
      return {
        providers: rows
          .filter((r) => findProvider(r.provider_code))
          .map((r) => ({
            provider: r.provider_code,
            config:
              typeof r.config === 'string'
                ? (JSON.parse(r.config) as Record<string, string>)
                : r.config,
          })),
        consentRequired: true,
      };
    });
  }
}
