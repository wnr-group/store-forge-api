import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  AppException,
  conflict,
  invalid,
  notFound,
} from '../../common/app.exception.js';
import { Paginated } from '../../common/dto/api-response.dto.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import { findIndianState } from '../orders/indian-states.js';
import { CheckoutService, ORDER_COLUMNS } from '../orders/checkout.service.js';
import type { OrderRow } from '../orders/checkout.service.js';
import { cancelOrder } from '../orders/order-cancellation.js';
import type {
  AccountOrderDto,
  AccountOrderSummaryDto,
  ChangeCustomerPasswordDto,
  CustomerAccountOrdersQueryDto,
  CustomerAddressDto,
  CustomerAddressInputDto,
  CustomerProfileDto,
  CustomerSessionDto,
  LoginCustomerDto,
  RegisterCustomerDto,
  UpdateCustomerProfileDto,
} from './customer-accounts.dto.js';
import {
  decoyHash,
  hashPassword,
  verifyPassword,
} from './customer-password.js';
import {
  CustomerSessionService,
  type CustomerPrincipal,
} from './customer-session.service.js';

const MAX_ADDRESSES = 10;
/** Wrong passwords in a row before the account is locked, and for how long. */
const MAX_FAILED_ATTEMPTS = 8;
const LOCK_MINUTES = 15;

const GENERIC_LOGIN_ERROR = 'The email or password is not correct.';

type AccountRow = {
  id: string;
  customer_id: string;
  email: string;
  full_name: string;
  phone: string | null;
  password_hash: string;
  failed_attempts: number;
  locked_until: string | Date | null;
};

const profileOf = (p: {
  fullName: string;
  email: string;
  phone: string | null;
}): CustomerProfileDto => ({
  fullName: p.fullName,
  email: p.email,
  phone: p.phone,
});

/**
 * Storefront customer accounts: sign up, sign in, profile, saved addresses and the shopper's own orders. Every method runs in ONE
 * transaction as the tenant-pinned checkout role for the store named in the URL, and every row it touches is looked up by the
 * account id read from the session, never from the request. A shopper therefore cannot reach another account's data, or any data
 * of another store, even by guessing ids.
 */
@Injectable()
export class CustomerAccountsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sessions: CustomerSessionService,
    private readonly checkout: CheckoutService,
  ) {}

  // --- sign up / in / out ---------------------------------------------------------------------------------------

  async register(
    slug: string,
    dto: RegisterCustomerDto,
  ): Promise<CustomerSessionDto> {
    const store = await this.sessions.resolveStore(slug);
    const passwordHash = await hashPassword(dto.password);
    try {
      return await this.registerIn(store.tenantId, dto, passwordHash);
    } catch (error) {
      // Two sign-ups with one email at the same moment: the second hits the unique index and gets the same answer as a repeat.
      if (
        /customer_accounts_tenant_email_key/.test(
          String((error as Error).cause ?? error),
        )
      )
        throw this.emailTaken();
      throw error;
    }
  }

  private registerIn(
    tenantId: string,
    dto: RegisterCustomerDto,
    passwordHash: string,
  ): Promise<CustomerSessionDto> {
    return this.db.withCheckout(tenantId, async (tx) => {
      const taken = rowsOf(
        await tx.execute(sql`
          select 1 from public.customer_accounts
          where tenant_id = ${tenantId}::uuid and lower(email) = ${dto.email}`),
      )[0];
      if (taken) throw this.emailTaken();
      // The merchant's customer record for this email (created by an earlier purchase, or new). Its order history is NOT
      // shared with the account: an account only ever sees orders placed while signed in to it.
      const customerId = await this.customerRecord(
        tx,
        tenantId,
        dto.email,
        dto.fullName,
        dto.phone ?? null,
      );
      const account = rowsOf<{ id: string }>(
        await tx.execute(sql`
          insert into public.customer_accounts (tenant_id, customer_id, email, full_name, phone, password_hash, last_login_at)
          values (${tenantId}::uuid, ${customerId}::uuid, ${dto.email}, ${dto.fullName}, ${dto.phone ?? null}, ${passwordHash}, now())
          returning id`),
      )[0];
      const session = await this.sessions.issue(tx, tenantId, account.id);
      return {
        sessionToken: session.token,
        expiresAt: session.expiresAt,
        profile: profileOf({
          fullName: dto.fullName,
          email: dto.email,
          phone: dto.phone ?? null,
        }),
      };
    });
  }

  private emailTaken() {
    return conflict(
      'An account with this email already exists. Sign in instead.',
      { email: 'An account with this email already exists.' },
      'CUSTOMER_EMAIL_TAKEN',
    );
  }

  async login(
    slug: string,
    dto: LoginCustomerDto,
  ): Promise<CustomerSessionDto> {
    const store = await this.sessions.resolveStore(slug);
    // Failures must be SAVED (the attempt counter), so the transaction commits and the error is thrown after it.
    const outcome = await this.db.withCheckout(store.tenantId, async (tx) => {
      const account = rowsOf<AccountRow>(
        await tx.execute(sql`
          select id, customer_id, email, full_name, phone, password_hash, failed_attempts, locked_until
          from public.customer_accounts
          where tenant_id = ${store.tenantId}::uuid and lower(email) = ${dto.email}
          for update`),
      )[0];
      if (!account) {
        // Same work as a real check, so "no such account" and "wrong password" take the same time.
        await verifyPassword(dto.password, await decoyHash());
        return { kind: 'invalid' as const };
      }
      if (account.locked_until && new Date(account.locked_until) > new Date())
        return { kind: 'locked' as const };
      if (!(await verifyPassword(dto.password, account.password_hash))) {
        const locking = account.failed_attempts + 1 >= MAX_FAILED_ATTEMPTS;
        await tx.execute(sql`
          update public.customer_accounts
          set failed_attempts = ${locking ? 0 : account.failed_attempts + 1},
              locked_until = ${locking ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null}::timestamptz
          where id = ${account.id}::uuid and tenant_id = ${store.tenantId}::uuid`);
        return { kind: 'invalid' as const };
      }
      await tx.execute(sql`
        update public.customer_accounts set failed_attempts = 0, locked_until = null, last_login_at = now()
        where id = ${account.id}::uuid and tenant_id = ${store.tenantId}::uuid`);
      const session = await this.sessions.issue(tx, store.tenantId, account.id);
      return {
        kind: 'ok' as const,
        result: {
          sessionToken: session.token,
          expiresAt: session.expiresAt,
          profile: profileOf({
            fullName: account.full_name,
            email: account.email,
            phone: account.phone,
          }),
        },
      };
    });
    if (outcome.kind === 'locked')
      throw new AppException(
        'RATE_LIMITED',
        `Too many wrong attempts. Try again in ${LOCK_MINUTES} minutes.`,
        { code: 'CUSTOMER_LOCKED' },
      );
    if (outcome.kind === 'invalid')
      throw new AppException('UNAUTHENTICATED', GENERIC_LOGIN_ERROR, {
        code: 'CUSTOMER_INVALID_LOGIN',
      });
    return outcome.result;
  }

  async logout(slug: string, token: string | undefined): Promise<null> {
    const store = await this.sessions.resolveStore(slug);
    await this.db.withCheckout(store.tenantId, (tx) =>
      this.sessions.revoke(tx, store.tenantId, token),
    );
    return null;
  }

  // --- profile ---------------------------------------------------------------------------------------------------

  me(slug: string, token: string | undefined): Promise<CustomerProfileDto> {
    return this.asCustomer(slug, token, async (_tx, who) => profileOf(who));
  }

  updateProfile(
    slug: string,
    token: string | undefined,
    dto: UpdateCustomerProfileDto,
  ): Promise<CustomerProfileDto> {
    return this.asCustomer(slug, token, async (tx, who) => {
      const fullName = dto.fullName ?? who.fullName;
      const phone = dto.phone === undefined ? who.phone : dto.phone || null;
      await tx.execute(sql`
        update public.customer_accounts set full_name = ${fullName}, phone = ${phone}, updated_at = now()
        where id = ${who.accountId}::uuid and tenant_id = ${who.tenantId}::uuid`);
      // The merchant's `customers` record is left alone: an unverified email must not be able to rewrite what a store owner sees.
      return profileOf({ fullName, email: who.email, phone });
    });
  }

  async changePassword(
    slug: string,
    token: string | undefined,
    dto: ChangeCustomerPasswordDto,
  ): Promise<null> {
    const ok = await this.asCustomer(slug, token, async (tx, who) => {
      const row = rowsOf<{ password_hash: string }>(
        await tx.execute(sql`
          select password_hash from public.customer_accounts
          where id = ${who.accountId}::uuid and tenant_id = ${who.tenantId}::uuid for update`),
      )[0];
      if (
        !row ||
        !(await verifyPassword(dto.currentPassword, row.password_hash))
      )
        return false;
      await tx.execute(sql`
        update public.customer_accounts set password_hash = ${await hashPassword(dto.newPassword)}, updated_at = now()
        where id = ${who.accountId}::uuid and tenant_id = ${who.tenantId}::uuid`);
      // Any other device or browser that was signed in must sign in again with the new password.
      await this.sessions.revokeOthers(tx, who.tenantId, who.accountId, token);
      return true;
    });
    if (!ok)
      throw invalid(
        'Your current password is not correct.',
        { currentPassword: 'Your current password is not correct.' },
        'CUSTOMER_WRONG_PASSWORD',
      );
    return null;
  }

  // --- addresses -------------------------------------------------------------------------------------------------

  listAddresses(
    slug: string,
    token: string | undefined,
  ): Promise<CustomerAddressDto[]> {
    return this.asCustomer(slug, token, (tx, who) => this.addresses(tx, who));
  }

  addAddress(
    slug: string,
    token: string | undefined,
    dto: CustomerAddressInputDto,
  ): Promise<CustomerAddressDto[]> {
    return this.asCustomer(slug, token, async (tx, who) => {
      const count = rowsOf<{ n: number }>(
        await tx.execute(sql`
          select count(*)::int as n from public.customer_addresses
          where account_id = ${who.accountId}::uuid and tenant_id = ${who.tenantId}::uuid`),
      )[0].n;
      if (count >= MAX_ADDRESSES)
        throw conflict(
          `You can save up to ${MAX_ADDRESSES} addresses. Remove one to add another.`,
          undefined,
          'ADDRESS_LIMIT',
        );
      const a = this.address(dto);
      // The first address is the default; so is any address marked as one.
      const makeDefault = dto.isDefault === true || count === 0;
      if (makeDefault) await this.clearDefault(tx, who);
      await tx.execute(sql`
        insert into public.customer_addresses (tenant_id, account_id, label, full_name, phone, line1, line2, city, state, state_code, postal_code, is_default)
        values (${who.tenantId}::uuid, ${who.accountId}::uuid, ${dto.label || null}, ${a.fullName}, ${a.phone}, ${a.line1}, ${a.line2},
          ${a.city}, ${a.stateName}, ${a.stateCode}, ${a.postalCode}, ${makeDefault})`);
      return this.addresses(tx, who);
    });
  }

  updateAddress(
    slug: string,
    token: string | undefined,
    id: string,
    dto: CustomerAddressInputDto,
  ): Promise<CustomerAddressDto[]> {
    return this.asCustomer(slug, token, async (tx, who) => {
      const a = this.address(dto);
      if (dto.isDefault === true) await this.clearDefault(tx, who);
      const updated = rowsOf(
        await tx.execute(sql`
          update public.customer_addresses
          set label = ${dto.label || null}, full_name = ${a.fullName}, phone = ${a.phone}, line1 = ${a.line1}, line2 = ${a.line2},
              city = ${a.city}, state = ${a.stateName}, state_code = ${a.stateCode}, postal_code = ${a.postalCode},
              is_default = case when ${dto.isDefault === true} then true else is_default end
          where id = ${id}::uuid and account_id = ${who.accountId}::uuid and tenant_id = ${who.tenantId}::uuid
          returning id`),
      );
      if (updated.length === 0)
        throw notFound('Address not found.', 'ADDRESS_NOT_FOUND');
      return this.addresses(tx, who);
    });
  }

  deleteAddress(
    slug: string,
    token: string | undefined,
    id: string,
  ): Promise<CustomerAddressDto[]> {
    return this.asCustomer(slug, token, async (tx, who) => {
      const removed = rowsOf<{ is_default: boolean }>(
        await tx.execute(sql`
          delete from public.customer_addresses
          where id = ${id}::uuid and account_id = ${who.accountId}::uuid and tenant_id = ${who.tenantId}::uuid
          returning is_default`),
      )[0];
      if (!removed) throw notFound('Address not found.', 'ADDRESS_NOT_FOUND');
      // Never leave an account with addresses but no default.
      if (removed.is_default)
        await tx.execute(sql`
          update public.customer_addresses set is_default = true
          where id = (select id from public.customer_addresses where account_id = ${who.accountId}::uuid and tenant_id = ${who.tenantId}::uuid
                      order by created_at, id limit 1)`);
      return this.addresses(tx, who);
    });
  }

  // --- orders ----------------------------------------------------------------------------------------------------

  listOrders(
    slug: string,
    token: string | undefined,
    query: CustomerAccountOrdersQueryDto,
  ): Promise<Paginated<AccountOrderSummaryDto>> {
    return this.asCustomer(slug, token, async (tx, who) => {
      const total = rowsOf<{ n: number }>(
        await tx.execute(sql`
          select count(*)::int as n from public.orders
          where account_id = ${who.accountId}::uuid and tenant_id = ${who.tenantId}::uuid`),
      )[0].n;
      const rows = rowsOf<{
        order_number: number;
        status: string;
        payment_status: string;
        payment_method: string;
        currency: string;
        total_minor: number;
        placed_at: string | Date;
        item_count: number;
        first_item: string | null;
      }>(
        await tx.execute(sql`
          select o.order_number, o.status, o.payment_status, o.payment_method, o.currency, o.total_minor::float8 as total_minor, o.placed_at,
            (select coalesce(sum(oi.quantity), 0)::int from public.order_items oi where oi.tenant_id = o.tenant_id and oi.order_id = o.id) as item_count,
            (select oi.name from public.order_items oi where oi.tenant_id = o.tenant_id and oi.order_id = o.id order by oi.name limit 1) as first_item
          from public.orders o
          where o.account_id = ${who.accountId}::uuid and o.tenant_id = ${who.tenantId}::uuid
          order by o.placed_at desc, o.id desc
          limit ${query.limit} offset ${(query.page - 1) * query.limit}`),
      );
      return new Paginated(
        rows.map((r) => ({
          orderNumber: r.order_number,
          status: r.status,
          paymentStatus: r.payment_status,
          paymentMethod: r.payment_method,
          currency: r.currency,
          totalMinor: Number(r.total_minor),
          placedAt: new Date(r.placed_at),
          itemCount: r.item_count,
          firstItemName: r.first_item,
        })),
        { page: query.page, limit: query.limit, total },
      );
    });
  }

  getOrder(
    slug: string,
    token: string | undefined,
    orderNumber: number,
  ): Promise<AccountOrderDto> {
    return this.asCustomer(slug, token, (tx, who) =>
      this.orderView(tx, who, orderNumber),
    );
  }

  cancelOrder(
    slug: string,
    token: string | undefined,
    orderNumber: number,
  ): Promise<AccountOrderDto> {
    return this.asCustomer(slug, token, async (tx, who) => {
      const order = await this.ownOrder(tx, who, orderNumber);
      await cancelOrder(
        tx,
        who.tenantId,
        order.id,
        { type: 'customer', id: null },
        'Cancelled by the customer',
      );
      return this.orderView(tx, who, orderNumber);
    });
  }

  // --- internals -------------------------------------------------------------------------------------------------

  /** Resolves the store, opens the pinned transaction and finds the shopper; a missing or foreign session is a 401. */
  private async asCustomer<T>(
    slug: string,
    token: string | undefined,
    fn: (tx: DbTx, who: CustomerPrincipal) => Promise<T>,
  ): Promise<T> {
    const store = await this.sessions.resolveStore(slug);
    return this.db.withCheckout(store.tenantId, async (tx) =>
      fn(tx, await this.sessions.require(tx, store.tenantId, token)),
    );
  }

  /** The order row, but ONLY if it was placed from this account. Anyone else's order and a missing order look the same. */
  private async ownOrder(
    tx: DbTx,
    who: CustomerPrincipal,
    orderNumber: number,
  ): Promise<OrderRow> {
    const row = rowsOf<OrderRow>(
      await tx.execute(sql`
        select ${ORDER_COLUMNS} from public.orders
        where tenant_id = ${who.tenantId}::uuid and account_id = ${who.accountId}::uuid and order_number = ${orderNumber}`),
    )[0];
    if (!row) throw notFound('Order not found.', 'ORDER_NOT_FOUND');
    return row;
  }

  private async orderView(
    tx: DbTx,
    who: CustomerPrincipal,
    orderNumber: number,
  ): Promise<AccountOrderDto> {
    const order = await this.ownOrder(tx, who, orderNumber);
    const view = await this.checkout.view(tx, who.tenantId, order, null, false);
    // Only the status and the time are shown: notes and who made the change stay with the merchant.
    const history = rowsOf<{ to_status: string; created_at: string | Date }>(
      await tx.execute(sql`
        select to_status, created_at from public.order_status_history
        where tenant_id = ${who.tenantId}::uuid and order_id = ${order.id}::uuid
        order by created_at, id`),
    );
    return {
      ...view,
      timeline: history.map((h) => ({
        status: h.to_status,
        at: new Date(h.created_at),
      })),
    };
  }

  private async addresses(
    tx: DbTx,
    who: CustomerPrincipal,
  ): Promise<CustomerAddressDto[]> {
    const rows = rowsOf<{
      id: string;
      label: string | null;
      full_name: string;
      phone: string;
      line1: string;
      line2: string | null;
      city: string;
      state: string;
      postal_code: string;
      is_default: boolean;
    }>(
      await tx.execute(sql`
        select id, label, full_name, phone, line1, line2, city, state, postal_code, is_default
        from public.customer_addresses
        where account_id = ${who.accountId}::uuid and tenant_id = ${who.tenantId}::uuid
        order by is_default desc, created_at, id`),
    );
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      fullName: r.full_name,
      phone: r.phone,
      line1: r.line1,
      line2: r.line2,
      city: r.city,
      state: r.state,
      postalCode: r.postal_code,
      isDefault: r.is_default,
    }));
  }

  private clearDefault(tx: DbTx, who: CustomerPrincipal) {
    return tx.execute(sql`
      update public.customer_addresses set is_default = false
      where account_id = ${who.accountId}::uuid and tenant_id = ${who.tenantId}::uuid and is_default`);
  }

  private address(a: CustomerAddressInputDto) {
    const state = findIndianState(a.state);
    if (!state)
      throw invalid('Choose a valid Indian state or union territory.', {
        state: 'Choose a valid Indian state or union territory.',
      });
    return {
      fullName: a.fullName,
      phone: a.phone,
      line1: a.line1,
      line2: a.line2 || null,
      city: a.city,
      stateName: state.name,
      stateCode: state.code,
      postalCode: a.postalCode,
    };
  }

  /** The merchant's `customers` row for an email: created if missing, otherwise left as it is. */
  private async customerRecord(
    tx: DbTx,
    tenantId: string,
    email: string,
    fullName: string,
    phone: string | null,
  ): Promise<string> {
    const inserted = rowsOf<{ id: string }>(
      await tx.execute(sql`
        insert into public.customers (tenant_id, email, full_name, phone)
        values (${tenantId}::uuid, ${email}, ${fullName}, ${phone})
        on conflict (tenant_id, lower(email)) do nothing
        returning id`),
    )[0];
    if (inserted) return inserted.id;
    return rowsOf<{ id: string }>(
      await tx.execute(sql`
        select id from public.customers where tenant_id = ${tenantId}::uuid and lower(email) = ${email}`),
    )[0].id;
  }
}
