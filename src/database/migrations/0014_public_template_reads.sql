-- Custom migration: read-only public functions for template-driven storefront pages (decisions D2, D7, D13).
--
-- Same pattern as get_public_storefront() (0009, 0011): SECURITY DEFINER, empty search_path, executable by
-- `authenticated` only (the app calls them in a transaction with no user identity, see withPublicContext()).
-- Every function resolves the store by slug and returns NULL unless the store AND its company are active, so
-- unknown, inactive and suspended stores look identical. Only ACTIVE catalog rows are returned, and only public
-- fields: no tenant_id, store_id, costs, stock quantities or draft content. Templates are read from the PUBLISHED
-- version only; the draft column is never selected. get_public_storefront() is not changed.
--
-- SKUs are returned here on purpose: the product page shows them (D9, D12). Variant stock is not.

-- Active collections of a store, for the Collection list section and for resolving a Featured collection (D13).
CREATE FUNCTION public.get_public_collections(p_slug text)
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

  SELECT s.id, s.tenant_id INTO v_store
  FROM public.stores s
  JOIN public.tenants t ON t.id = s.tenant_id
  WHERE s.slug = p_slug AND s.status = 'active' AND t.status = 'active';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN coalesce((
    SELECT jsonb_agg(to_jsonb(x) ORDER BY x.name, x.slug)
    FROM (
      SELECT c.id, c.name, c.slug, c.description, c.image_path,
             (SELECT count(*)::int
                FROM public.collection_products cp
                JOIN public.products p ON p.id = cp.product_id AND p.tenant_id = cp.tenant_id AND p.status = 'active'
               WHERE cp.collection_id = c.id AND cp.tenant_id = c.tenant_id) AS product_count
      FROM public.collections c
      WHERE c.tenant_id = v_store.tenant_id AND c.status = 'active'
      ORDER BY c.name, c.slug
      LIMIT 100
    ) x
  ), '[]'::jsonb);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_public_collections(text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_public_collections(text) TO authenticated;
--> statement-breakpoint

-- One active collection with its active products, in the collection's own order.
CREATE FUNCTION public.get_public_collection(p_slug text, p_collection_slug text)
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
                 ORDER BY i.is_primary DESC, i.position, i.id LIMIT 1) AS image_path
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
REVOKE ALL ON FUNCTION public.get_public_collection(text, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_public_collection(text, text) TO authenticated;
--> statement-breakpoint

-- One active product with its images, options, active variants and related products. Related products are active
-- products that share an active collection with it or have the same category: existing relationships only (D12).
CREATE FUNCTION public.get_public_product(p_slug text, p_product_slug text)
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
         p.price_minor, p.compare_at_price_minor, p.has_variants,
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
      'has_variants', v_product.has_variants, 'category_name', v_product.category_name
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
               'price_minor', v.price_minor, 'compare_at_price_minor', v.compare_at_price_minor, 'image_id', v.image_id)
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
                 ORDER BY i.is_primary DESC, i.position, i.id LIMIT 1) AS image_path
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
--> statement-breakpoint

-- The published layout for a page (D7, D8): the page template (the one assigned to the product or collection,
-- else the store default, each only if active and published), the published theme settings and the three
-- published groups. Anything not published is null and the app falls back to the registry defaults. `source` says
-- which step of the fallback chain produced the template. An unknown resource slug just means "no assignment".
CREATE FUNCTION public.get_public_template_layout(p_slug text, p_kind text, p_resource_slug text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_store record;
  v_resource_id uuid;
  v_template jsonb;
  v_source text;
BEGIN
  IF p_slug IS NULL OR NOT public.is_valid_store_slug(p_slug) OR p_kind IS NULL OR p_kind NOT IN ('index', 'product', 'collection') THEN
    RETURN NULL;
  END IF;

  SELECT s.id, s.tenant_id INTO v_store
  FROM public.stores s
  JOIN public.tenants t ON t.id = s.tenant_id
  WHERE s.slug = p_slug AND s.status = 'active' AND t.status = 'active';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF p_resource_slug IS NOT NULL THEN
    IF p_kind = 'product' THEN
      SELECT p.id INTO v_resource_id FROM public.products p
      WHERE p.tenant_id = v_store.tenant_id AND p.slug = p_resource_slug AND p.status = 'active';
    ELSIF p_kind = 'collection' THEN
      SELECT c.id INTO v_resource_id FROM public.collections c
      WHERE c.tenant_id = v_store.tenant_id AND c.slug = p_resource_slug AND c.status = 'active';
    END IF;
  END IF;

  IF v_resource_id IS NOT NULL THEN
    SELECT jsonb_build_object('name', t.name, 'version_number', v.version_number, 'document', v.document) INTO v_template
    FROM public.template_assignments a
    JOIN public.templates t ON t.id = a.template_id AND t.tenant_id = a.tenant_id AND t.store_id = a.store_id AND t.status = 'active'
    JOIN public.template_versions v ON v.id = t.published_version_id AND v.template_id = t.id
    WHERE a.tenant_id = v_store.tenant_id AND a.store_id = v_store.id
      AND ((p_kind = 'product' AND a.product_id = v_resource_id) OR (p_kind = 'collection' AND a.collection_id = v_resource_id));
    IF v_template IS NOT NULL THEN
      v_source := 'assigned';
    END IF;
  END IF;

  IF v_template IS NULL THEN
    SELECT jsonb_build_object('name', t.name, 'version_number', v.version_number, 'document', v.document) INTO v_template
    FROM public.templates t
    JOIN public.template_versions v ON v.id = t.published_version_id AND v.template_id = t.id
    WHERE t.tenant_id = v_store.tenant_id AND t.store_id = v_store.id AND t.kind = p_kind AND t.is_default AND t.status = 'active';
    IF v_template IS NOT NULL THEN
      v_source := 'default';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'source', v_source,
    'template', v_template,
    'theme', (
      SELECT v.document FROM public.templates t
      JOIN public.template_versions v ON v.id = t.published_version_id AND v.template_id = t.id
      WHERE t.tenant_id = v_store.tenant_id AND t.store_id = v_store.id AND t.kind = 'theme_settings' AND t.status = 'active'
    ),
    'groups', jsonb_build_object(
      'header', (
        SELECT v.document FROM public.templates t
        JOIN public.template_versions v ON v.id = t.published_version_id AND v.template_id = t.id
        WHERE t.tenant_id = v_store.tenant_id AND t.store_id = v_store.id AND t.kind = 'group_header' AND t.status = 'active'
      ),
      'footer', (
        SELECT v.document FROM public.templates t
        JOIN public.template_versions v ON v.id = t.published_version_id AND v.template_id = t.id
        WHERE t.tenant_id = v_store.tenant_id AND t.store_id = v_store.id AND t.kind = 'group_footer' AND t.status = 'active'
      ),
      'announcement', (
        SELECT v.document FROM public.templates t
        JOIN public.template_versions v ON v.id = t.published_version_id AND v.template_id = t.id
        WHERE t.tenant_id = v_store.tenant_id AND t.store_id = v_store.id AND t.kind = 'group_announcement' AND t.status = 'active'
      )
    )
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_public_template_layout(text, text, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_public_template_layout(text, text, text) TO authenticated;
