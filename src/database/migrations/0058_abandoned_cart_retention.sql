-- Custom migration: how long saved carts are kept (phase 7 of docs/MARKETING_ANALYTICS_PLAN.md).
--
-- A saved cart holds a shopper's email, name and phone, so it must not live forever. purge_stale_abandoned_carts() deletes, across
-- all tenants and in batches so one run never holds a long lock:
--   * carts nobody has touched for the tenant's recovery-link lifetime plus 30 days (the link stopped working long ago, and the
--     owner has had a month to see the cart as expired);
--   * carts that were recovered more than 180 days ago (long enough for the reports that count recoveries).
-- Called by the scheduler through the tenant-less checkout role, like the stock-hold expiry; it cannot be executed by anyone else.

CREATE FUNCTION public.purge_stale_abandoned_carts(p_batch integer DEFAULT 2000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 10000 THEN p_batch := 2000; END IF;
  WITH stale AS (
    SELECT c.id
    FROM public.abandoned_carts c
    LEFT JOIN public.tenant_marketing_settings s ON s.tenant_id = c.tenant_id
    WHERE (c.status <> 'recovered'
           AND c.last_activity_at < now() - make_interval(days => coalesce(s.recovery_link_days, 14) + 30))
       OR (c.status = 'recovered' AND c.recovered_at < now() - interval '180 days')
    ORDER BY c.last_activity_at
    LIMIT p_batch
  )
  DELETE FROM public.abandoned_carts a USING stale WHERE a.id = stale.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.purge_stale_abandoned_carts(integer) FROM public, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.purge_stale_abandoned_carts(integer) TO storeforge_checkout;
