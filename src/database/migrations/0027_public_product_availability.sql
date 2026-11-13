-- Custom migration: "sold out" for the public storefront.
--
-- Shoppers should see whether a product can be bought. The public functions (0009, 0011, 0014) return only public
-- fields and never stock counts, so this adds ONE derived boolean, `available`, to each product they return:
--   * a product that does not track inventory is always available;
--   * a product with variants is available when at least one ACTIVE variant has stock;
--   * any other product is available when its quantity is above zero.
-- A variant carries the same flag. Quantities are never exposed. Nothing else changes: same signatures, same return type
-- (jsonb), same filters (active store, active tenant, active products only), same privileges. CREATE OR REPLACE takes
-- its attributes from the statement, so STABLE, SECURITY DEFINER and the empty search_path are restated on purpose.
-- No table, column or row is touched, and clients that ignore the new key keep working.

CREATE FUNCTION public.product_available(p_track boolean, p_has_variants boolean, p_quantity integer, p_product_id uuid, p_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT NOT p_track OR CASE
    WHEN p_has_variants THEN EXISTS (
      SELECT 1 FROM public.product_variants v
      WHERE v.product_id = p_product_id AND v.tenant_id = p_tenant_id AND v.is_active AND v.quantity > 0
    )
    ELSE p_quantity > 0
  END
$$;
--> statement-breakpoint
-- Internal helper: only the public SECURITY DEFINER functions below call it.
REVOKE ALL ON FUNCTION public.product_available(boolean, boolean, integer, uuid, uuid) FROM public, anon, authenticated;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.get_public_storefront(p_slug text)
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

  SELECT s.id, s.tenant_id, s.name, s.slug, s.description, s.logo_url, s.currency
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
                 ORDER BY i.is_primary DESC, i.position, i.id LIMIT 1) AS image_path,
               public.product_available(p.track_inventory, p.has_variants, p.quantity, p.id, p.tenant_id) AS available
        FROM public.products p
        WHERE p.tenant_id = v_store.tenant_id AND p.status = 'active'
        ORDER BY p.created_at DESC, p.slug
        LIMIT 48
      ) x
    ), '[]'::jsonb),
    'template', (
      SELECT jsonb_build_object(
        'key', ts.template_key,
        'accent_color', ts.accent_color,
        'hero_heading', ts.hero_heading,
        'hero_subheading', ts.hero_subheading,
        'hero_image_path', ts.hero_image_path
      )
      FROM public.store_template_settings ts
      WHERE ts.store_id = v_store.id AND ts.tenant_id = v_store.tenant_id
    )
  );
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.get_public_collection(p_slug text, p_collection_slug text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_store record;
  v_collection record;
BEGIN
  IF p_slug IS NULL OR NOT public.is_valid_store_slug(p_slug) OR p_collection_slug IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT s.tenant_id, s.name, s.slug, s.description, s.logo_url, s.currency INTO v_store
  FROM public.stores s
  JOIN public.tenants t ON t.id = s.tenant_id
  WHERE s.slug = p_slug AND s.status = 'active' AND t.status = 'active';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT c.id, c.name, c.slug, c.description, c.image_path INTO v_collection
  FROM public.collections c
  WHERE c.tenant_id = v_store.tenant_id AND c.slug = p_collection_slug AND c.status = 'active';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'store', jsonb_build_object(
      'name', v_store.name, 'slug', v_store.slug, 'description', v_store.description,
      'logo_path', v_store.logo_url, 'currency', v_store.currency
    ),
    'collection', jsonb_build_object(
      'id', v_collection.id, 'name', v_collection.name, 'slug', v_collection.slug,
      'description', v_collection.description, 'image_path', v_collection.image_path
    ),
    'products', coalesce((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.position, x.created_at DESC, x.slug)
      FROM (
        SELECT p.name, p.slug, p.short_description, p.price_minor, p.compare_at_price_minor, p.created_at, cp.position,
               (SELECT i.storage_path FROM public.product_images i
                 WHERE i.product_id = p.id AND i.tenant_id = p.tenant_id
                 ORDER BY i.is_primary DESC, i.position, i.id LIMIT 1) AS image_path,
               public.product_available(p.track_inventory, p.has_variants, p.quantity, p.id, p.tenant_id) AS available
        FROM public.collection_products cp
        JOIN public.products p ON p.id = cp.product_id AND p.tenant_id = cp.tenant_id AND p.status = 'active'
        WHERE cp.collection_id = v_collection.id AND cp.tenant_id = v_store.tenant_id
        ORDER BY cp.position, p.created_at DESC, p.slug
        LIMIT 48
      ) x
    ), '[]'::jsonb)
  );
END;
$$;
--> statement-breakpoint
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
REVOKE ALL ON FUNCTION public.get_public_storefront(text), public.get_public_collection(text, text), public.get_public_product(text, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_public_storefront(text), public.get_public_collection(text, text), public.get_public_product(text, text) TO authenticated;
