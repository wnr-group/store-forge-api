-- Custom migration: store SEO metadata. A store owner can set a meta title and a meta description for the storefront's
-- home page; the public storefront function returns both (null when not set, and the frontend falls back to the store name
-- and description).
--
--   * stores.meta_title (max 70 characters) and stores.meta_description (max 160 characters), both nullable. Existing rows
--     get NULL; nothing is backfilled.
--   * The app role may update the two columns (column-level grant, like the other store settings). Row access is still
--     decided by the existing stores RLS policies, so only an admin of the owning organization can change them.
--   * get_public_storefront() is redefined from its latest definition (0027) with two more keys. Same signature, same
--     visibility rule (active store of an active organization), same privileges: CREATE OR REPLACE keeps the grants, and
--     STABLE, SECURITY DEFINER and the empty search_path are restated on purpose.

ALTER TABLE "stores" ADD COLUMN "meta_title" text;
--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "meta_description" text;
--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_meta_title_check"
  CHECK ("meta_title" IS NULL OR char_length("meta_title") <= 70);
--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_meta_description_check"
  CHECK ("meta_description" IS NULL OR char_length("meta_description") <= 160);
--> statement-breakpoint
GRANT UPDATE (meta_title, meta_description) ON public.stores TO authenticated;
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

  SELECT s.id, s.tenant_id, s.name, s.slug, s.description, s.logo_url, s.currency, s.meta_title, s.meta_description
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
    'meta_title', v_store.meta_title,
    'meta_description', v_store.meta_description,
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
