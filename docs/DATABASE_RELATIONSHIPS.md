# Database Relationships

```
auth.users (Supabase, not modelled)
 ├─1:1── profiles                       (id = auth.users.id, cascade)
 ├─1:N── memberships ──N:1── tenants    (cascade both ways; unique (tenant,user); one owner/tenant)
 ├─1:1?─ platform_admins                (cascade; excludes anyone with a membership)
 ├─0:N── tenants.created_by             (set null)
 └─0:N── inventory_adjustments.created_by (set null)

tenants ─1:N─ stores                    (cascade; unique (tenant_id,id) enables composite FKs)
tenants ─1:N─ categories ─self─ parent_id (set null on delete)
tenants ─1:N─ collections ─N:M─ products via collection_products (composite FKs, cascade)
tenants ─1:1─ catalog_hierarchies ─1:N─ catalog_levels ─1:N─ catalog_nodes (parent_id: tree, level right below the parent) ─N:M─ products via catalog_node_products (composite FKs, cascade)
tenants ─1:N─ products ─N:1─ categories (category_id, set null)
products ─1:N─ product_images | product_options | product_variants   (composite FK (tenant_id,product_id), cascade)
product_variants ─N:1─ product_images (image_id, set null)
products/variants ─1:N─ inventory_adjustments (composite FKs, cascade)
tenants ─1:N─ customers ─1:N─ orders ─1:N─ order_items
order_items ─N:1─ products / product_variants (set null; name/sku/price are snapshots)

Standalone (no FKs by design, survive deletions): admin_audit_logs, platform_settings, rate_limits
```

## Tenant-isolation properties of the relationships

* Every tenant-owned row carries `tenant_id`; children reference the parent through `(tenant_id, id)` composite FKs, so a child cannot point at another tenant's parent even for a privileged writer.
* Deleting a tenant cascades through stores, catalog, customers, orders and memberships; `platform_delete_tenant` returns the auth users left with no membership so the API can delete them after commit.
* Deleting a category sets `products.category_id` and child `parent_id` to null; deleting a customer sets `orders.customer_id` to null.
