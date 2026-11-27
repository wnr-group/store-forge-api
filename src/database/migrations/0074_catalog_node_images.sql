-- Catalog hierarchy: one optional image per item (see docs/CATALOG_HIERARCHY.md).
-- Additive only: two nullable columns, their checks, one index, one column grant, and the two public catalog functions of
-- migration 0073 re-created (CREATE OR REPLACE, same signatures and return types) so shoppers get the image of each item.
-- Migrations 0072 and 0073 are NOT touched.

-- 1. Columns ------------------------------------------------------------------------------------------------------------
-- `image_path` is a file in the `products` bucket: `{tenant_id}/catalog/{node_id}/{file}` (same layout idea as collections).
ALTER TABLE "catalog_nodes" ADD COLUMN "image_path" text;
--> statement-breakpoint
ALTER TABLE "catalog_nodes" ADD COLUMN "image_alt" text;
--> statement-breakpoint

-- 2. Checks -------------------------------------------------------------------------------------------------------------
-- The path is tied to THIS item and THIS organization, so an item can never point at another item's or organization's file.
ALTER TABLE "catalog_nodes" ADD CONSTRAINT "catalog_nodes_image_path_check" CHECK (
  "image_path" IS NULL OR (
    "image_path" LIKE "tenant_id"::text || '/catalog/' || "id"::text || '/%'
    AND "image_path" !~ '\.\.'
    AND char_length("image_path") <= 300
  )
);
--> statement-breakpoint
-- Alt text only makes sense with an image, and is 1..200 characters when present.
ALTER TABLE "catalog_nodes" ADD CONSTRAINT "catalog_nodes_image_alt_check" CHECK (
  "image_alt" IS NULL OR (
    "image_path" IS NOT NULL AND char_length(btrim("image_alt")) BETWEEN 1 AND 200
  )
);
--> statement-breakpoint

-- 3. Index for "is this file still used by an item?" (storage clean-up) ---------------------------------------------------
CREATE INDEX "catalog_nodes_image_path_idx" ON "catalog_nodes" USING btree ("tenant_id", "image_path") WHERE "image_path" IS NOT NULL;
--> statement-breakpoint

-- 4. Column grant -------------------------------------------------------------------------------------------------------
-- UPDATE on catalog_nodes is limited to named columns since 0072; INSERT is table-wide and needs nothing.
GRANT UPDATE ("image_path", "image_alt") ON public.catalog_nodes TO authenticated;
--> statement-breakpoint

-- 5. Public tree: 0073 body plus image_path / image_alt on every item. ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_public_catalog_tree(p_slug text, p_max_depth integer DEFAULT NULL)
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
           n.seo_title, n.seo_description, n.image_path, n.image_alt, n.slug::text AS spath
    FROM public.catalog_nodes n
    WHERE n.tenant_id = v_store.tenant_id AND n.hierarchy_id = v_h.id AND n.parent_id IS NULL AND n.status = 'active'
    UNION ALL
    SELECT c.id, c.parent_id, c.level_id, c.name, c.slug, c.description, c.position, c.depth,
           c.seo_title, c.seo_description, c.image_path, c.image_alt, t.spath || '/' || c.slug
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
               'image_path', x.image_path, 'image_alt', x.image_alt,
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

-- 6. Public node page: 0073 body plus image_path / image_alt on the item and on each child. --------------------------------
CREATE OR REPLACE FUNCTION public.get_public_catalog_node(
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
      SELECT n.id, n.parent_id, n.level_id, n.name, n.slug, n.description, n.position, n.depth, n.seo_title, n.seo_description,
             n.image_path, n.image_alt INTO v_node
      FROM public.catalog_nodes n
      WHERE n.tenant_id = v_store.tenant_id AND n.hierarchy_id = v_h.id AND n.parent_id IS NULL
        AND n.slug = v_segments[i] AND n.status = 'active';
    ELSE
      SELECT n.id, n.parent_id, n.level_id, n.name, n.slug, n.description, n.position, n.depth, n.seo_title, n.seo_description,
             n.image_path, n.image_alt INTO v_node
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
           'image_path', c.image_path, 'image_alt', c.image_alt,
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
    SELECT k.id, k.name, k.slug, k.description, k.position, k.level_id, k.depth, k.image_path, k.image_alt
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
      'image_path', v_node.image_path, 'image_alt', v_node.image_alt,
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
