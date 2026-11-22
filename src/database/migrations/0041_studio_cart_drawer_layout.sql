-- Update get_public_template_layout to include group_cart_drawer and support page kinds.
CREATE OR REPLACE FUNCTION public.get_public_template_layout(p_slug text, p_kind text, p_resource_slug text DEFAULT NULL)
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
  IF p_slug IS NULL OR NOT public.is_valid_store_slug(p_slug) OR p_kind IS NULL OR p_kind NOT IN ('index', 'product', 'collection', 'page') THEN
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
    ELSIF p_kind = 'page' THEN
      SELECT t.id INTO v_resource_id FROM public.templates t
      WHERE t.tenant_id = v_store.tenant_id AND t.store_id = v_store.id AND t.kind = 'page' AND t.page_slug = p_resource_slug AND t.status = 'active';
    END IF;
  END IF;

  IF v_resource_id IS NOT NULL THEN
    IF p_kind = 'page' THEN
      SELECT jsonb_build_object('name', t.name, 'version_number', v.version_number, 'document', v.document) INTO v_template
      FROM public.templates t
      JOIN public.template_versions v ON v.id = t.published_version_id AND v.template_id = t.id
      WHERE t.id = v_resource_id;
      IF v_template IS NOT NULL THEN
        v_source := 'page';
      END IF;
    ELSE
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
  END IF;

  IF v_template IS NULL AND p_kind <> 'page' THEN
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
      ),
      'cart_drawer', (
        SELECT v.document FROM public.templates t
        JOIN public.template_versions v ON v.id = t.published_version_id AND v.template_id = t.id
        WHERE t.tenant_id = v_store.tenant_id AND t.store_id = v_store.id AND t.kind = 'group_cart_drawer' AND t.status = 'active'
      )
    )
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_public_template_layout(text, text, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_public_template_layout(text, text, text) TO authenticated;
