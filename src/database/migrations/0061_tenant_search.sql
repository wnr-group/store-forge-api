-- Custom migration: Platform Admin tenant search covers name, slug, tenant id, public id, owner e-mail and store domain.
--
-- platform_list_tenants_page() previously matched only name and slug. It now also matches:
--   * the tenant id (any part of its text form, so a pasted id or its first characters work),
--   * the tenant's public id,
--   * the owner's e-mail address,
--   * any store sub-domain of the tenant (the "domain" a shopper visits).
-- Same signature and result shape, so callers and grants are unchanged. LIKE wildcards in the input are still escaped.

CREATE OR REPLACE FUNCTION public.platform_list_tenants_page(
  p_search text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_sort text DEFAULT 'created_desc',
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid, name text, slug text, status text, contact_phone text, address text, created_at timestamptz,
  store_id uuid, store_name text, store_slug text,
  owner_id uuid, owner_name text, owner_email text, member_count bigint, total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_pattern text;
  v_limit integer;
  v_offset integer;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF p_sort IS NULL OR p_sort NOT IN ('created_desc', 'created_asc', 'name_asc', 'name_desc') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset := greatest(coalesce(p_offset, 0), 0);
  v_pattern := CASE
    WHEN nullif(btrim(p_search), '') IS NULL THEN NULL
    ELSE '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  END;

  RETURN QUERY
  WITH filtered AS (
    SELECT t.id, t.name, t.slug, t.status, t.contact_phone, t.address, t.created_at,
           count(*) OVER () AS total_count,
           row_number() OVER (
             ORDER BY
               CASE WHEN p_sort = 'name_asc' THEN lower(t.name) END ASC,
               CASE WHEN p_sort = 'name_desc' THEN lower(t.name) END DESC,
               CASE WHEN p_sort = 'created_asc' THEN t.created_at END ASC,
               CASE WHEN p_sort = 'created_desc' THEN t.created_at END DESC,
               t.id
           ) AS ord
    FROM public.tenants t
    WHERE (p_status IS NULL OR t.status = p_status)
      AND (
        v_pattern IS NULL
        OR t.name ILIKE v_pattern
        OR t.slug ILIKE v_pattern
        OR t.public_id ILIKE v_pattern
        OR t.id::text ILIKE v_pattern
        OR EXISTS (
          SELECT 1 FROM public.memberships om
          JOIN auth.users ou ON ou.id = om.user_id
          WHERE om.tenant_id = t.id AND om.role = 'owner' AND ou.email::text ILIKE v_pattern)
        OR EXISTS (
          SELECT 1 FROM public.stores ss WHERE ss.tenant_id = t.id AND ss.subdomain ILIKE v_pattern)
      )
  ),
  page AS (
    SELECT * FROM filtered f WHERE f.ord > v_offset AND f.ord <= v_offset + v_limit
  )
  SELECT pg.id, pg.name, pg.slug, pg.status, pg.contact_phone, pg.address, pg.created_at,
         s.id, s.name, s.slug,
         o.user_id, p.full_name, u.email::text,
         (SELECT count(*) FROM public.memberships mm WHERE mm.tenant_id = pg.id),
         pg.total_count
  FROM page pg
  LEFT JOIN LATERAL (
    SELECT s0.id, s0.name, s0.slug FROM public.stores s0
    WHERE s0.tenant_id = pg.id ORDER BY s0.created_at, s0.id LIMIT 1) s ON true
  LEFT JOIN LATERAL (
    SELECT m0.user_id FROM public.memberships m0
    WHERE m0.tenant_id = pg.id AND m0.role = 'owner' ORDER BY m0.created_at, m0.id LIMIT 1) o ON true
  LEFT JOIN public.profiles p ON p.id = o.user_id
  LEFT JOIN auth.users u ON u.id = o.user_id
  ORDER BY pg.ord;
END;
$$;
