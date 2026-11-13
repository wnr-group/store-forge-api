-- Custom migration: read-only data for the public storefront served on <store-slug>.<root-domain>.
--
-- Anonymous visitors have no table access (RLS grants them nothing). Instead of opening any table, the
-- app calls this one SECURITY DEFINER function with an explicit store slug. It returns ONLY what a
-- storefront may show - store name / description / logo / currency and ACTIVE products of an ACTIVE
-- store in an ACTIVE (not suspended) company - and NULL for everything else, so an unknown, inactive
-- or suspended store is indistinguishable from a missing one. No customers, orders, costs, stock
-- counts, SKUs or draft products are included. Executable by `authenticated` only, like every other
-- function: the app calls it in a transaction with no user identity (see withPublicContext()).

CREATE FUNCTION public.get_public_storefront(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_store record;
BEGIN
  IF p_slug IS NULL OR NOT public.is_valid_store_slug(p_slug) THEN
    RETURN NULL;
  END IF;

  SELECT s.tenant_id, s.name, s.slug, s.description, s.logo_url, s.currency
  INTO v_store
  FROM public.stores s
  JOIN public.tenants t ON t.id = s.tenant_id
  WHERE s.slug = p_slug AND s.status = 'active' AND t.status = 'active';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'name', v_store.name,
    'slug', v_store.slug,
    'description', v_store.description,
    'logo_path', v_store.logo_url,
    'currency', v_store.currency,
    'products', coalesce((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC, x.slug)
      FROM (
        SELECT p.name, p.slug, p.short_description, p.price_minor, p.compare_at_price_minor, p.created_at,
               (SELECT i.storage_path FROM public.product_images i
                 WHERE i.product_id = p.id AND i.tenant_id = p.tenant_id
                 ORDER BY i.is_primary DESC, i.position, i.id LIMIT 1) AS image_path
        FROM public.products p
        WHERE p.tenant_id = v_store.tenant_id AND p.status = 'active'
        ORDER BY p.created_at DESC, p.slug
        LIMIT 48
      ) x
    ), '[]'::jsonb)
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_public_storefront(text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_public_storefront(text) TO authenticated;
