-- Custom migration: what a storefront may learn about a store's tracking integrations (phase 5 of docs/MARKETING_ANALYTICS_PLAN.md).
--
-- public_tracking_config(): the provider code and the PUBLIC identifiers (a GA4 Measurement ID, a Pixel ID) of the integrations a store has
-- validated AND switched on, nothing else. No secret column is ever selected here. It is granted to the tenant-pinned checkout role only
-- and refuses any other tenant, so a storefront can only ever receive its own store's identifiers.

CREATE FUNCTION public.public_tracking_config(p_tenant uuid)
RETURNS TABLE (provider_code text, config jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT i.provider_code, i.config
  FROM public.marketing_integrations i
  WHERE i.tenant_id = p_tenant AND p_tenant = public.pinned_tenant_id()
    AND i.enabled AND i.validation_status = 'valid'
  ORDER BY i.provider_code
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.public_tracking_config(uuid) FROM public, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.public_tracking_config(uuid) TO storeforge_checkout;
