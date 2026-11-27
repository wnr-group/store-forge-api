-- Custom migration: Catalog Hierarchy (part 2 of 2: public reads, follows 0072).
--
--   * get_public_product() is redefined from its latest definition (0033) with ONE extra key in `product`: part_number
--     (null when the product has none). Everything else is identical on purpose: same signature, same filters (active
--     store of an active organization, active product), same limits, same privileges. CREATE OR REPLACE takes its attributes
--     from the statement, so STABLE, SECURITY DEFINER and the empty search_path are restated.
--   * get_public_catalog_tree() and get_public_catalog_node() are new. They follow the other public functions: they take the
--     store slug (never a tenant id), only an active store of an active organization answers, only ACTIVE nodes of an ACTIVE
--     hierarchy are visible, a node below a draft node is hidden too, only ACTIVE products are listed, and the result is a
--     small jsonb document. They are granted to `authenticated` (the role of every API request, with or without a user) and
--     not to anon, exactly like the existing functions.

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

  SELECT p.id, p.category_id, p.name, p.slug, p.description, p.short_description, p.product_type, p.sku, p.part_number,
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
      'short_description', v_product.short_description, 'product_type', v_product.product_type, 'sku', v_product.sku, 'part_number', v_product.part_number,
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
--> statement-breakpoint

-- The published catalogue tree of a store: the levels and every ACTIVE node whose ancestors are all ACTIVE (a draft parent
-- hides everything below it). A store without a published hierarchy still answers (empty lists); an unknown, inactive or
-- suspended store gives NULL like the other public functions. p_max_depth limits how deep to go (NULL = all); nodes below
-- it are left out but their parents say has_children = true. At most 5000 nodes are returned; `truncated` says if more exist.
CREATE FUNCTION public.get_public_catalog_tree(p_slug text, p_max_depth integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_store record;
  v_h record;
  v_levels jsonb;
  v_nodes jsonb;
  v_truncated boolean;
BEGIN
  IF p_slug IS NULL OR NOT public.is_valid_store_slug(p_slug) THEN
    RETURN NULL;
  END IF;

  SELECT s.tenant_id, s.name, s.slug, s.description, s.logo_url, s.currency INTO v_store
  FROM public.stores s
  JOIN public.tenants t ON t.id = s.tenant_id
  WHERE s.slug = p_slug AND s.status = 'active' AND t.status = 'active';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT h.id, h.name INTO v_h
  FROM public.catalog_hierarchies h
  WHERE h.tenant_id = v_store.tenant_id AND h.status = 'active';

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'store', jsonb_build_object('name', v_store.name, 'slug', v_store.slug, 'currency', v_store.currency),
      'hierarchy', NULL, 'levels', '[]'::jsonb, 'nodes', '[]'::jsonb, 'truncated', false
    );
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'name', l.name, 'position', l.position, 'can_hold_products', l.can_hold_products
         ) ORDER BY l.position), '[]'::jsonb)
  INTO v_levels
  FROM public.catalog_levels l
  WHERE l.hierarchy_id = v_h.id AND l.tenant_id = v_store.tenant_id;

  WITH RECURSIVE t AS (
    SELECT n.id, n.parent_id, n.level_id, n.name, n.slug, n.description, n.position, n.depth,
           n.seo_title, n.seo_description, n.slug::text AS spath
    FROM public.catalog_nodes n
    WHERE n.tenant_id = v_store.tenant_id AND n.hierarchy_id = v_h.id AND n.parent_id IS NULL AND n.status = 'active'
    UNION ALL
    SELECT c.id, c.parent_id, c.level_id, c.name, c.slug, c.description, c.position, c.depth,
           c.seo_title, c.seo_description, t.spath || '/' || c.slug
    FROM public.catalog_nodes c
    JOIN t ON c.parent_id = t.id
    WHERE c.tenant_id = v_store.tenant_id AND c.status = 'active' AND (p_max_depth IS NULL OR c.depth <= p_max_depth)
  ), limited AS (
    SELECT * FROM t ORDER BY depth, position, name, id LIMIT 5001
  )
  SELECT
    coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', x.id, 'parent_id', x.parent_id, 'level_id', x.level_id, 'name', x.name, 'slug', x.slug,
               'path', x.spath, 'description', x.description, 'position', x.position, 'depth', x.depth,
               'seo_title', x.seo_title, 'seo_description', x.seo_description,
               'has_children', EXISTS (
                 SELECT 1 FROM public.catalog_nodes k
                 WHERE k.parent_id = x.id AND k.tenant_id = v_store.tenant_id AND k.status = 'active'),
               'product_count', (
                 SELECT count(*) FROM public.catalog_node_products np
                 JOIN public.products p ON p.id = np.product_id AND p.tenant_id = np.tenant_id AND p.status = 'active'
                 WHERE np.node_id = x.id AND np.tenant_id = v_store.tenant_id)
             ) ORDER BY x.depth, x.position, x.name, x.id)
      FROM (SELECT * FROM limited ORDER BY depth, position, name, id LIMIT 5000) x
    ), '[]'::jsonb),
    (SELECT count(*) FROM limited) > 5000
  INTO v_nodes, v_truncated;

  RETURN jsonb_build_object(
    'store', jsonb_build_object('name', v_store.name, 'slug', v_store.slug, 'currency', v_store.currency),
    'hierarchy', jsonb_build_object('id', v_h.id, 'name', v_h.name),
    'levels', v_levels,
    'nodes', v_nodes,
    'truncated', v_truncated
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_public_catalog_tree(text, integer) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_public_catalog_tree(text, integer) TO authenticated;
--> statement-breakpoint

-- One published node, found by its slugs from the root ("toyota/camry/le"): the node, its breadcrumbs, its active children
-- and a page of its ACTIVE products (optionally those of all active descendants too, each product once). NULL when the store,
-- the hierarchy or any node on the way is unknown or not active, so a draft parent hides its whole subtree.
-- p_sort: position (default), newest, name, price_asc, price_desc. p_limit is clamped to 1..100.
CREATE FUNCTION public.get_public_catalog_node(
  p_slug text, p_node_path text, p_page integer DEFAULT 1, p_limit integer DEFAULT 24,
  p_include_descendants boolean DEFAULT false, p_sort text DEFAULT 'position')
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_store record;
  v_h record;
  v_segments text[];
  v_node record;
  v_level record;
  v_node_id uuid;
  v_crumbs jsonb := '[]'::jsonb;
  v_path text := '';
  v_children jsonb;
  v_items jsonb;
  v_total bigint;
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_limit integer := least(greatest(coalesce(p_limit, 24), 1), 100);
  v_sort text := coalesce(p_sort, 'position');
  v_include boolean := coalesce(p_include_descendants, false);
  i integer;
BEGIN
  IF p_slug IS NULL OR NOT public.is_valid_store_slug(p_slug) OR p_node_path IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT s.tenant_id, s.name, s.slug, s.description, s.logo_url, s.currency INTO v_store
  FROM public.stores s
  JOIN public.tenants t ON t.id = s.tenant_id
  WHERE s.slug = p_slug AND s.status = 'active' AND t.status = 'active';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT h.id, h.name INTO v_h
  FROM public.catalog_hierarchies h
  WHERE h.tenant_id = v_store.tenant_id AND h.status = 'active';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_segments := string_to_array(trim(both '/' from p_node_path), '/');
  IF v_segments IS NULL OR cardinality(v_segments) < 1 OR cardinality(v_segments) > 20 THEN
    RETURN NULL;
  END IF;

  -- Walk down from the root, one slug per level; every node on the way must be active.
  FOR i IN 1..cardinality(v_segments) LOOP
    IF i = 1 THEN
      SELECT n.id, n.parent_id, n.level_id, n.name, n.slug, n.description, n.position, n.depth, n.seo_title, n.seo_description INTO v_node
      FROM public.catalog_nodes n
      WHERE n.tenant_id = v_store.tenant_id AND n.hierarchy_id = v_h.id AND n.parent_id IS NULL
        AND n.slug = v_segments[i] AND n.status = 'active';
    ELSE
      SELECT n.id, n.parent_id, n.level_id, n.name, n.slug, n.description, n.position, n.depth, n.seo_title, n.seo_description INTO v_node
      FROM public.catalog_nodes n
      WHERE n.tenant_id = v_store.tenant_id AND n.parent_id = v_node_id
        AND n.slug = v_segments[i] AND n.status = 'active';
    END IF;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    v_node_id := v_node.id;
    v_path := v_path || CASE WHEN i > 1 THEN '/' ELSE '' END || v_node.slug;
    v_crumbs := v_crumbs || jsonb_build_object(
      'id', v_node.id, 'name', v_node.name, 'slug', v_node.slug, 'path', v_path, 'depth', v_node.depth,
      'level_id', v_node.level_id,
      'level_name', (SELECT l.name FROM public.catalog_levels l WHERE l.id = v_node.level_id)
    );
  END LOOP;

  SELECT l.id, l.name, l.position, l.can_hold_products INTO v_level
  FROM public.catalog_levels l
  WHERE l.id = v_node.level_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'name', c.name, 'slug', c.slug, 'path', v_path || '/' || c.slug, 'description', c.description,
           'position', c.position, 'level_id', c.level_id, 'depth', c.depth,
           'has_children', EXISTS (
             SELECT 1 FROM public.catalog_nodes k
             WHERE k.parent_id = c.id AND k.tenant_id = v_store.tenant_id AND k.status = 'active'),
           'product_count', (
             SELECT count(*) FROM public.catalog_node_products np
             JOIN public.products p ON p.id = np.product_id AND p.tenant_id = np.tenant_id AND p.status = 'active'
             WHERE np.node_id = c.id AND np.tenant_id = v_store.tenant_id)
         ) ORDER BY c.position, c.name, c.id), '[]'::jsonb)
  INTO v_children
  FROM (
    SELECT k.id, k.name, k.slug, k.description, k.position, k.level_id, k.depth
    FROM public.catalog_nodes k
    WHERE k.tenant_id = v_store.tenant_id AND k.parent_id = v_node_id AND k.status = 'active'
    ORDER BY k.position, k.name, k.id
    LIMIT 500
  ) c;

  WITH RECURSIVE sub AS (
    SELECT v_node_id AS id
    UNION ALL
    SELECT k.id
    FROM public.catalog_nodes k
    JOIN sub ON k.parent_id = sub.id
    WHERE v_include AND k.tenant_id = v_store.tenant_id AND k.status = 'active'
  ), picked AS (
    SELECT p.id, p.name, p.slug, p.part_number, p.short_description, p.price_minor, p.compare_at_price_minor,
           p.created_at, p.track_inventory, p.has_variants, p.quantity, min(np.position) AS position
    FROM sub
    JOIN public.catalog_node_products np ON np.node_id = sub.id AND np.tenant_id = v_store.tenant_id
    JOIN public.products p ON p.id = np.product_id AND p.tenant_id = np.tenant_id AND p.status = 'active'
    GROUP BY p.id
  )
  SELECT
    (SELECT count(*) FROM picked),
    coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'name', y.name, 'slug', y.slug, 'part_number', y.part_number,
               'short_description', y.short_description, 'price_minor', y.price_minor,
               'compare_at_price_minor', y.compare_at_price_minor,
               'image_path', (SELECT i.storage_path FROM public.product_images i
                               WHERE i.product_id = y.id AND i.tenant_id = v_store.tenant_id
                               ORDER BY i.is_primary DESC, i.position, i.id LIMIT 1),
               'available', public.product_available(y.track_inventory, y.has_variants, y.quantity, y.id, v_store.tenant_id)
             ) ORDER BY y.rn)
      FROM (
        SELECT pk.*, row_number() OVER (
                 ORDER BY
                   CASE WHEN v_sort = 'price_asc' THEN pk.price_minor END ASC,
                   CASE WHEN v_sort = 'price_desc' THEN pk.price_minor END DESC,
                   CASE WHEN v_sort = 'name' THEN pk.name END ASC,
                   CASE WHEN v_sort = 'newest' THEN pk.created_at END DESC,
                   pk.position ASC, pk.created_at DESC, pk.slug ASC, pk.id ASC) AS rn
        FROM picked pk
        ORDER BY rn
        LIMIT v_limit OFFSET (v_page - 1) * v_limit
      ) y
    ), '[]'::jsonb)
  INTO v_total, v_items;

  RETURN jsonb_build_object(
    'store', jsonb_build_object(
      'name', v_store.name, 'slug', v_store.slug, 'description', v_store.description,
      'logo_path', v_store.logo_url, 'currency', v_store.currency
    ),
    'hierarchy', jsonb_build_object('id', v_h.id, 'name', v_h.name),
    'node', jsonb_build_object(
      'id', v_node.id, 'parent_id', v_node.parent_id, 'level_id', v_node.level_id, 'name', v_node.name, 'slug', v_node.slug,
      'description', v_node.description, 'position', v_node.position,
      'path', v_path, 'depth', v_node.depth, 'seo_title', v_node.seo_title, 'seo_description', v_node.seo_description,
      'has_children', EXISTS (
        SELECT 1 FROM public.catalog_nodes k
        WHERE k.parent_id = v_node.id AND k.tenant_id = v_store.tenant_id AND k.status = 'active'),
      'product_count', (
        SELECT count(*) FROM public.catalog_node_products np
        JOIN public.products p ON p.id = np.product_id AND p.tenant_id = np.tenant_id AND p.status = 'active'
        WHERE np.node_id = v_node.id AND np.tenant_id = v_store.tenant_id),
      'level', jsonb_build_object(
        'id', v_level.id, 'name', v_level.name, 'position', v_level.position, 'can_hold_products', v_level.can_hold_products)
    ),
    'breadcrumbs', v_crumbs,
    'children', v_children,
    'products', jsonb_build_object(
      'items', v_items, 'page', v_page, 'limit', v_limit, 'total', v_total, 'include_descendants', v_include)
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_public_catalog_node(text, text, integer, integer, boolean, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_public_catalog_node(text, text, integer, integer, boolean, text) TO authenticated;
