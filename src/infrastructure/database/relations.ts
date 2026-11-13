// GENERATED from wnr-group/store-forge lib/db/relations.ts. DO NOT EDIT.

import { relations } from "drizzle-orm";
import { memberships, stores, tenants } from "./schema/index.js";

export const tenantsRelations = relations(tenants, ({ many }) => ({
  memberships: many(memberships),
  stores: many(stores),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  tenant: one(tenants, { fields: [memberships.tenantId], references: [tenants.id] }),
}));

export const storesRelations = relations(stores, ({ one }) => ({
  tenant: one(tenants, { fields: [stores.tenantId], references: [tenants.id] }),
}));
