-- Custom migration: let the public storefront response carry the tenant's public id (tenants.public_id, added in 0028).
--
-- The storefront host is {store-slug}-{public_id}.<root domain>. The web app must check that the public id in the host
-- belongs to the store named by the slug part, otherwise any suffix would open a store. get_public_storefront() is
-- left untouched (it is large and several migrations replace it); this adds one narrow read-only lookup instead.
-- Only active stores of active organizations answer, exactly like get_public_storefront(), so an unknown, inactive or
-- suspended store still looks the same: NULL. Only the public id is returned, never the tenant id.

CREATE FUNCTION public.get_public_store_public_id(p_slug text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT t.public_id
  FROM public.stores s
  JOIN public.tenants t ON t.id = s.tenant_id
  WHERE p_slug IS NOT NULL
    AND public.is_valid_store_slug(p_slug)
    AND s.slug = p_slug
    AND s.status = 'active'
    AND t.status = 'active';
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_public_store_public_id(text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_public_store_public_id(text) TO authenticated;
