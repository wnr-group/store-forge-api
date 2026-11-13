-- Custom migration: security for public.store_template_settings and template data in the public storefront.
--
-- store_template_settings holds one row per store (selected template + four optional customization values).
-- Everything is deny-by-default (see 0002 / 0006): anonymous visitors get no table access and read the
-- settings only through get_public_storefront(). Authenticated members can read their own tenant's row;
-- only Owner and Manager (store:manage) can insert or update, and only the five customization columns can
-- change. tenant_id, store_id and updated_at are immutable to the app, and rows are never deleted by it
-- (they go away with their store through the composite foreign key).

REVOKE ALL ON public.store_template_settings FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON public.store_template_settings TO authenticated;
--> statement-breakpoint
GRANT INSERT (store_id, tenant_id, template_key, accent_color, hero_heading, hero_subheading, hero_image_path)
  ON public.store_template_settings TO authenticated;
--> statement-breakpoint
GRANT UPDATE (template_key, accent_color, hero_heading, hero_subheading, hero_image_path)
  ON public.store_template_settings TO authenticated;
--> statement-breakpoint

CREATE POLICY store_template_settings_select_members ON public.store_template_settings
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint
-- The EXISTS repeats the composite foreign key as defence in depth: the store must belong to the same tenant.
CREATE POLICY store_template_settings_insert_admins ON public.store_template_settings
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_tenant_role(tenant_id, array['owner', 'admin'])
    AND EXISTS (
      SELECT 1 FROM public.stores s
      WHERE s.id = store_template_settings.store_id AND s.tenant_id = store_template_settings.tenant_id
    )
  );
--> statement-breakpoint
CREATE POLICY store_template_settings_update_admins ON public.store_template_settings
  FOR UPDATE TO authenticated
  USING (public.has_tenant_role(tenant_id, array['owner', 'admin']))
  WITH CHECK (
    public.has_tenant_role(tenant_id, array['owner', 'admin'])
    AND EXISTS (
      SELECT 1 FROM public.stores s
      WHERE s.id = store_template_settings.store_id AND s.tenant_id = store_template_settings.tenant_id
    )
  );
--> statement-breakpoint

CREATE TRIGGER store_template_settings_set_updated_at
  BEFORE UPDATE ON public.store_template_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Same function as 0009 plus one extra key, "template": NULL when the store has no settings row, otherwise
-- { key, accent_color, hero_heading, hero_subheading, hero_image_path }. Return type (jsonb), signature,
-- ownership and privileges are unchanged. CREATE OR REPLACE takes its attributes from this statement, so
-- STABLE, SECURITY DEFINER and the empty search_path are restated on purpose. No tenant_id, store_id or
-- updated_at is ever returned.
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
                 ORDER BY i.is_primary DESC, i.position, i.id LIMIT 1) AS image_path
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
REVOKE ALL ON FUNCTION public.get_public_storefront(text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_public_storefront(text) TO authenticated;
