-- Custom migration: publish per-product presentation settings through get_public_product (follows 0032).
--
-- get_public_product is replaced with its 0027 definition PLUS one extra key, `presentation`: the PUBLISHED settings
-- of that product (gallery layout, focal point, hidden blocks), or null when the product has none. Everything else is
-- identical to 0027 on purpose: same signature and return type, same filters (active store, active tenant, active
-- product), same `available` flags, same limits and ordering, same privileges. CREATE OR REPLACE takes its attributes
-- from the statement, so STABLE, SECURITY DEFINER and the empty search_path are restated.
--
-- Only `published` is read and only the four known keys are returned (a projection, never the whole column), so a
-- draft, revision, tenant, store or publisher id can never reach a shopper. Product cards (storefront list,
-- collection, related products) are NOT changed: card settings are not defined yet, so those functions stay as in 0027.
-- get_public_template_layout (0014) is not touched.

CREATE OR REPLACE FUNCTION public.get_public_product(p_slug text, p_product_slug text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_store record;
  v_product record;
BEGIN
  IF p_slug IS NULL OR NOT public.is_valid_store_slug(p_slug) OR p_product_slug IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT s.tenant_id, s.name, s.slug, s.description, s.logo_url, s.currency INTO v_store
  FROM public.stores s
  JOIN public.tenants t ON t.id = s.tenant_id
  WHERE s.slug = p_slug AND s.status = 'active' AND t.status = 'active';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT p.id, p.category_id, p.name, p.slug, p.description, p.short_description, p.product_type, p.sku,
         p.price_minor, p.compare_at_price_minor, p.has_variants, p.track_inventory, p.quantity,
         (SELECT c.name FROM public.categories c WHERE c.id = p.category_id AND c.tenant_id = p.tenant_id) AS category_name
  INTO v_product
  FROM public.products p
  WHERE p.tenant_id = v_store.tenant_id AND p.slug = p_product_slug AND p.status = 'active';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'store', jsonb_build_object(
      'name', v_store.name, 'slug', v_store.slug, 'description', v_store.description,
      'logo_path', v_store.logo_url, 'currency', v_store.currency
    ),
    'product', jsonb_build_object(
      'name', v_product.name, 'slug', v_product.slug, 'description', v_product.description,
      'short_description', v_product.short_description, 'product_type', v_product.product_type, 'sku', v_product.sku,
      'price_minor', v_product.price_minor, 'compare_at_price_minor', v_product.compare_at_price_minor,
      'has_variants', v_product.has_variants, 'category_name', v_product.category_name,
      'available', public.product_available(v_product.track_inventory, v_product.has_variants, v_product.quantity, v_product.id, v_store.tenant_id)
    ),
    'presentation', (
      SELECT jsonb_strip_nulls(jsonb_build_object(
               'schemaVersion', pp.published -> 'schemaVersion',
               'gallery', pp.published -> 'gallery',
               'focalPoint', pp.published -> 'focalPoint',
               'hiddenBlocks', pp.published -> 'hiddenBlocks'))
      FROM public.product_presentations pp
      WHERE pp.product_id = v_product.id AND pp.tenant_id = v_store.tenant_id AND pp.published IS NOT NULL
    ),
    'images', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', i.id, 'path', i.storage_path, 'alt', i.alt_text, 'position', i.position, 'is_primary', i.is_primary)
                       ORDER BY i.is_primary DESC, i.position, i.id)
      FROM public.product_images i
      WHERE i.product_id = v_product.id AND i.tenant_id = v_store.tenant_id
    ), '[]'::jsonb),
    'options', coalesce((
      SELECT jsonb_agg(jsonb_build_object('name', o.name, 'values', to_jsonb(o."values")) ORDER BY o.position, o.name)
      FROM public.product_options o
      WHERE o.product_id = v_product.id AND o.tenant_id = v_store.tenant_id
    ), '[]'::jsonb),
    'variants', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', v.id, 'title', v.title, 'options', v.options, 'sku', v.sku,
               'price_minor', v.price_minor, 'compare_at_price_minor', v.compare_at_price_minor, 'image_id', v.image_id,
               'available', (NOT v_product.track_inventory OR v.quantity > 0))
             ORDER BY v.position, v.id)
      FROM public.product_variants v
      WHERE v.product_id = v_product.id AND v.tenant_id = v_store.tenant_id AND v.is_active
    ), '[]'::jsonb),
    'related', coalesce((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC, x.slug)
      FROM (
        SELECT p.name, p.slug, p.short_description, p.price_minor, p.compare_at_price_minor, p.created_at,
               (SELECT i.storage_path FROM public.product_images i
                 WHERE i.product_id = p.id AND i.tenant_id = p.tenant_id
                 ORDER BY i.is_primary DESC, i.position, i.id LIMIT 1) AS image_path,
               public.product_available(p.track_inventory, p.has_variants, p.quantity, p.id, p.tenant_id) AS available
        FROM public.products p
        WHERE p.tenant_id = v_store.tenant_id AND p.status = 'active' AND p.id <> v_product.id
          AND (
            (v_product.category_id IS NOT NULL AND p.category_id = v_product.category_id)
            OR EXISTS (
              SELECT 1
              FROM public.collection_products mine
              JOIN public.collections c ON c.id = mine.collection_id AND c.tenant_id = mine.tenant_id AND c.status = 'active'
              JOIN public.collection_products theirs ON theirs.collection_id = mine.collection_id AND theirs.tenant_id = mine.tenant_id
              WHERE mine.product_id = v_product.id AND mine.tenant_id = v_store.tenant_id AND theirs.product_id = p.id
            )
          )
        ORDER BY p.created_at DESC, p.slug
        LIMIT 8
      ) x
    ), '[]'::jsonb)
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_public_product(text, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_public_product(text, text) TO authenticated;
