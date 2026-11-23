-- Custom migration: what the public checkout needs on top of 0045.
--
-- * orders.access_token_hash: a guest can read their own order with the token returned once at placement. Only the SHA-256
--   hash is stored, so a database reader cannot use it to open an order.
-- * inventory_reservations gains the status 'restocked' (a committed reservation whose stock was returned by a cancellation).
-- * Two SECURITY DEFINER lookups that run before a tenant can be pinned. They are granted to storeforge_checkout ONLY (not
--   to `authenticated`, which PostgREST exposes), so a signed-in user cannot call them through the Supabase REST API.

ALTER TABLE "orders" ADD COLUMN "access_token_hash" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_access_token_hash_check"
  CHECK ("access_token_hash" IS NULL OR "access_token_hash" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint

ALTER TABLE "inventory_reservations" DROP CONSTRAINT "inventory_reservations_status_check";
--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_status_check"
  CHECK ("status" IN ('active', 'committed', 'released', 'expired', 'restocked'));
--> statement-breakpoint

-- Which tenant and currency does an ACTIVE store (of an ACTIVE company) belong to? NULL row = unknown / inactive / suspended.
CREATE FUNCTION public.get_checkout_store(p_slug text)
RETURNS TABLE (tenant_id uuid, currency text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT s.tenant_id, s.currency
  FROM public.stores s
  JOIN public.tenants t ON t.id = s.tenant_id
  WHERE s.slug = p_slug AND s.status = 'active' AND t.status = 'active'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_checkout_store(text) FROM public, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_checkout_store(text) TO storeforge_checkout;
--> statement-breakpoint

-- Tenants that have reservations past their expiry, for the scheduled cleanup job.
CREATE FUNCTION public.tenants_with_expired_reservations(p_limit integer)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT DISTINCT r.tenant_id
  FROM public.inventory_reservations r
  WHERE r.status = 'active' AND r.expires_at <= now()
  LIMIT greatest(1, least(coalesce(p_limit, 100), 500))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.tenants_with_expired_reservations(integer) FROM public, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.tenants_with_expired_reservations(integer) TO storeforge_checkout;
