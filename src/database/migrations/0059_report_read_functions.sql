-- Custom migration: the rows the sales, product and customer reports are made of (phase 7 of docs/MARKETING_ANALYTICS_PLAN.md).
--
-- Why: row level security checks access once PER ROW. For a report over tens of thousands of orders that is tens of thousands of
-- function calls, measured at about 45 times slower than the same aggregate without it. These functions check access ONCE, for the
-- whole call, and then read the rows; they return exactly the rows the caller could see through row level security (the same
-- tenant, the same module), so nothing becomes visible that was not.
--
-- Second reason: with row level security, a member who may see customers but not orders would get a customer report full of
-- silent zeros (their order rows are filtered out). Here a missing access raises `permission denied` (a 403 in the API) instead.
--
-- Every function: refuses another tenant's id for a caller who is not a member of it (has_module_access is false), refuses the
-- PostgREST login role, and is executable by signed-in users only. They are read-only (STABLE) and take the revenue statuses from
-- the caller, so the list of statuses that count as sales lives in one place (the application).

CREATE FUNCTION public.report_counted_orders(p_tenant uuid, p_from timestamptz, p_to timestamptz, p_statuses text[])
RETURNS TABLE (id uuid, customer_id uuid, placed_at timestamptz, subtotal_minor bigint, discount_minor bigint, fees_minor bigint,
               tax_minor bigint, total_minor bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.has_module_access(p_tenant, 'orders', 'read') OR session_user = 'authenticator' THEN
    RAISE EXCEPTION 'permission denied for orders' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT o.id, o.customer_id, o.placed_at, o.subtotal_minor, o.discount_minor, o.shipping_minor + o.cod_fee_minor, o.tax_minor, o.total_minor
    FROM public.orders o
    WHERE o.tenant_id = p_tenant AND o.status = ANY (p_statuses)
      AND (p_from IS NULL OR o.placed_at >= p_from) AND (p_to IS NULL OR o.placed_at < p_to);
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.report_counted_items(p_tenant uuid, p_from timestamptz, p_to timestamptz, p_statuses text[])
RETURNS TABLE (order_id uuid, product_id uuid, quantity integer, total_minor bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.has_module_access(p_tenant, 'orders', 'read') OR session_user = 'authenticator' THEN
    RAISE EXCEPTION 'permission denied for orders' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT i.order_id, i.product_id, i.quantity, i.total_minor
    FROM public.order_items i
    JOIN public.orders o ON o.tenant_id = i.tenant_id AND o.id = i.order_id
    WHERE i.tenant_id = p_tenant AND i.product_id IS NOT NULL AND o.status = ANY (p_statuses)
      AND (p_from IS NULL OR o.placed_at >= p_from) AND (p_to IS NULL OR o.placed_at < p_to);
END
$$;
--> statement-breakpoint

-- The catalogue as the product report lists it. Product names are already on every order line, so orders access is what it needs
-- (a member who may read orders but not the catalogue would otherwise see an empty report).
CREATE FUNCTION public.report_products(p_tenant uuid)
RETURNS TABLE (id uuid, name text, slug text, status text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.has_module_access(p_tenant, 'orders', 'read') OR session_user = 'authenticator' THEN
    RAISE EXCEPTION 'permission denied for orders' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT p.id, p.name, p.slug, p.status FROM public.products p WHERE p.tenant_id = p_tenant;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.report_customers(p_tenant uuid)
RETURNS TABLE (id uuid, full_name text, email text, created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.has_module_access(p_tenant, 'customers', 'read') OR session_user = 'authenticator' THEN
    RAISE EXCEPTION 'permission denied for customers' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT c.id, c.full_name, c.email, c.created_at FROM public.customers c WHERE c.tenant_id = p_tenant;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.report_counted_orders(uuid, timestamptz, timestamptz, text[]),
  public.report_counted_items(uuid, timestamptz, timestamptz, text[]),
  public.report_products(uuid),
  public.report_customers(uuid) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.report_counted_orders(uuid, timestamptz, timestamptz, text[]),
  public.report_counted_items(uuid, timestamptz, timestamptz, text[]),
  public.report_products(uuid),
  public.report_customers(uuid) TO authenticated;
