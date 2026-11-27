import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { AppException, forbidden } from '../../common/app.exception.js';
import type { AuthUser } from '../../common/interfaces/request-context.js';
import { listActiveMemberships } from '../../common/tenancy/memberships.js';
import type { AppConfig } from '../../config/configuration.js';
import { DatabaseService } from '../../database/database.service.js';
import { stores } from '../../database/schema/index.js';
import type { HandoffDto, LoginSessionOnly } from './auth.dto.js';
import {
  HANDOFF_TTL_SECONDS,
  openHandoff,
  sealHandoff,
} from './handoff-code.js';
import { isTrustedServer } from './request-trust.js';
import { SessionService } from './session.service.js';
import { SupabaseAdminService } from './supabase-admin.service.js';

const now = () => Math.floor(Date.now() / 1000);

/**
 * Carries a signed-in person to one of THEIR store hosts without widening the session cookie. Cookies stay host-only (one set per
 * store host), so a new host has none: the root site asks for a short-lived single-use code for that host (`issue`), and the host
 * trades it for its own, new session (`exchange`). The person stays signed in on the root site too, and no store host can ever read
 * another host's cookie.
 */
@Injectable()
export class HandoffService {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly db: DatabaseService,
    private readonly authAdmin: SupabaseAdminService,
    private readonly sessions: SessionService,
  ) {}

  private secret(): string {
    const secret = this.config.get('auth', { infer: true }).bffSecret;
    if (!secret)
      throw new AppException(
        'UNAVAILABLE',
        'Opening your store from here is not available right now.',
      );
    return secret;
  }

  /**
   * A code for `audience` (a store host label). The caller must be an ACTIVE member of the store that owns that host: the database
   * decides that, so a made-up or someone else's host gets nothing.
   */
  async issue(user: AuthUser, audience: string): Promise<HandoffDto> {
    const secret = this.secret();
    if (!user.email) throw forbidden();
    const allowed = await this.db.withUser(user.id, async (tx) => {
      const mine = new Set(
        (await listActiveMemberships(tx, user.id)).map((m) => m.tenant.id),
      );
      const rows = await tx
        .select({ tenantId: stores.tenantId })
        .from(stores)
        .where(eq(stores.subdomain, audience));
      return rows.some((r) => mine.has(r.tenantId));
    });
    if (!allowed) throw forbidden('You do not have access to this store.');
    const tokenHash = await this.authAdmin.createLoginTokenHash(user.email);
    return {
      code: sealHandoff(secret, tokenHash, audience, now()),
      expiresInSeconds: HANDOFF_TTL_SECONDS,
    };
  }

  /**
   * Trades a code for a new session on the store host that is calling. Only the trusted frontend server may call this (it holds the
   * shared secret and knows the real host), and the code must have been made for exactly this host.
   */
  async exchange(
    req: Request,
    res: Response,
    code: string,
    audience: string,
  ): Promise<LoginSessionOnly> {
    const secret = this.secret();
    if (!isTrustedServer(req, secret)) throw forbidden();
    const tokenHash = openHandoff(secret, code, audience, now());
    if (!tokenHash)
      throw new AppException(
        'UNAUTHENTICATED',
        'This sign-in link has expired. Please sign in again.',
        { code: 'HANDOFF_INVALID' },
      );
    return this.sessions.signInWithTokenHash(req, res, tokenHash);
  }
}
