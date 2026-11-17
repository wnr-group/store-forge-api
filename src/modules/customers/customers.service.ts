import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { notFound } from '../../common/app.exception.js';
import { mapErrors } from '../../common/db-errors.js';
import { Paginated } from '../../common/dto/api-response.dto.js';
import { likeTerm, offsetOf } from '../../common/dto/pagination-query.dto.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { DatabaseService } from '../../database/database.service.js';
import { customers, orders } from '../../database/schema/index.js';
import { REVENUE_ORDER_STATUSES } from '../../database/schema/enums.js';
import type {
  CreateCustomerDto,
  CustomerDetailDto,
  CustomerDto,
  CustomerListQueryDto,
  UpdateCustomerDto,
} from './customers.dto.js';

const revenueStatuses = sql.join(
  REVENUE_ORDER_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

/** Per-customer order aggregates, computed in SQL from real orders (revenue statuses only for spend). */
const orderCount = sql<number>`(select count(*)::int from "orders" o where o.customer_id = "customers"."id")`;
const spent = sql<number>`coalesce((select sum(o.total_minor) from "orders" o where o.customer_id = "customers"."id" and o.status in (${revenueStatuses})), 0)::float8`;
const lastOrder = sql<Date | null>`(select max(o.placed_at) from "orders" o where o.customer_id = "customers"."id")`;

const notFoundError = () =>
  notFound('That customer no longer exists.', 'CUSTOMER_NOT_FOUND');

type Row = {
  customer: typeof customers.$inferSelect;
  orderCount: number;
  totalSpentMinor: number | string;
  lastOrderAt: Date | string | null;
};

const toDto = (r: Row): CustomerDto => ({
  id: r.customer.id,
  fullName: r.customer.fullName,
  email: r.customer.email,
  phone: r.customer.phone,
  notes: r.customer.notes,
  orderCount: r.orderCount,
  totalSpentMinor: Number(r.totalSpentMinor),
  lastOrderAt: r.lastOrderAt ? new Date(r.lastOrderAt) : null,
  createdAt: r.customer.createdAt,
  updatedAt: r.customer.updatedAt,
});

@Injectable()
export class CustomersService {
  constructor(private readonly db: DatabaseService) {}

  async list(
    ctx: OrgContext,
    q: CustomerListQueryDto,
  ): Promise<Paginated<CustomerDto>> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const where: (SQL | undefined)[] = [eq(customers.tenantId, ctx.tenantId)];
      if (q.search) {
        const term = likeTerm(q.search);
        where.push(
          or(
            ilike(customers.fullName, term),
            ilike(customers.email, term),
            ilike(customers.phone, term),
          ),
        );
      }
      const dir = q.sortOrder === 'asc' ? asc : desc;
      const order =
        q.sortBy === 'name'
          ? dir(customers.fullName)
          : q.sortBy === 'spent'
            ? dir(spent)
            : q.sortBy === 'orders'
              ? dir(orderCount)
              : dir(customers.createdAt);
      const cond = and(...where) as SQL;
      const [rows, [{ total }]] = await Promise.all([
        tx
          .select({
            customer: customers,
            orderCount,
            totalSpentMinor: spent,
            lastOrderAt: lastOrder,
          })
          .from(customers)
          .where(cond)
          .orderBy(order, asc(customers.id))
          .limit(q.limit)
          .offset(offsetOf(q)),
        tx
          .select({ total: sql<number>`count(*)::int` })
          .from(customers)
          .where(cond),
      ]);
      return new Paginated(rows.map(toDto), {
        page: q.page,
        limit: q.limit,
        total,
      });
    });
  }

  async get(ctx: OrgContext, id: string): Promise<CustomerDetailDto> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const [row] = await tx
        .select({
          customer: customers,
          orderCount,
          totalSpentMinor: spent,
          lastOrderAt: lastOrder,
        })
        .from(customers)
        .where(and(eq(customers.id, id), eq(customers.tenantId, ctx.tenantId)));
      if (!row) throw notFoundError();
      const history = await tx
        .select()
        .from(orders)
        .where(
          and(eq(orders.customerId, id), eq(orders.tenantId, ctx.tenantId)),
        )
        .orderBy(desc(orders.placedAt))
        .limit(50);
      return Object.assign(toDto(row), {
        orders: history.map((o) => ({
          id: o.id,
          orderNumber: o.orderNumber,
          status: o.status,
          currency: o.currency,
          subtotalMinor: o.subtotalMinor,
          totalMinor: o.totalMinor,
          placedAt: o.placedAt,
        })),
      });
    });
  }

  async create(
    ctx: OrgContext,
    dto: CreateCustomerDto,
  ): Promise<CustomerDetailDto> {
    const id = await this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const [row] = await tx
          .insert(customers)
          .values({
            tenantId: ctx.tenantId,
            fullName: dto.fullName,
            email: dto.email,
            phone: dto.phone ?? null,
            notes: dto.notes ?? null,
          })
          .returning({ id: customers.id });
        return row.id;
      }),
    );
    return this.get(ctx, id);
  }

  async update(
    ctx: OrgContext,
    id: string,
    dto: UpdateCustomerDto,
  ): Promise<CustomerDetailDto> {
    await this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const changes = {
          ...(dto.fullName !== undefined && { fullName: dto.fullName }),
          ...(dto.email !== undefined && { email: dto.email }),
          ...(dto.phone !== undefined && { phone: dto.phone }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
        };
        const rows =
          Object.keys(changes).length > 0
            ? await tx
                .update(customers)
                .set(changes)
                .where(
                  and(
                    eq(customers.id, id),
                    eq(customers.tenantId, ctx.tenantId),
                  ),
                )
                .returning({ id: customers.id })
            : await tx
                .select({ id: customers.id })
                .from(customers)
                .where(
                  and(
                    eq(customers.id, id),
                    eq(customers.tenantId, ctx.tenantId),
                  ),
                );
        if (!rows.length) throw notFoundError();
      }),
    );
    return this.get(ctx, id);
  }

  async remove(ctx: OrgContext, id: string): Promise<void> {
    await this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const rows = await tx
          .delete(customers)
          .where(
            and(eq(customers.id, id), eq(customers.tenantId, ctx.tenantId)),
          )
          .returning({ id: customers.id });
        if (!rows.length) throw notFoundError();
      }),
    );
  }
}
