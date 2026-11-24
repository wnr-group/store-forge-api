-- Custom migration: per-tenant entitlement overrides, entitlement and usage reads, and the platform-wide limit report.
--
--   * tenant_feature_overrides / tenant_limit_overrides: a Platform Admin can switch one feature on or off, or set one limit,
--     for a single tenant, whatever its plan says. A limit override row with both numbers NULL means "unlimited for this tenant".
--     Platform Admins only (RLS + grants), like the plan tables.
--   * tenant_entitlements(): everything the API needs to work out what a tenant may use (its subscription, its plan's features and
--     limits, and the overrides), in ONE call. The API merges it; this function decides who may ask: members of the tenant (suspended
--     tenants are invisible) and Platform Admins.
--   * tenant_usage_counts(): the tenant's current numbers for the limits that can be counted.
--   * platform_limit_usage_page(): the same numbers for all tenants, filtered by how close they are to their limits.
--   * tenant_has_feature(): the same effective-feature rule, for other SQL functions (not callable by the API). The public storefront
--     tracking function uses it so a plan that does not include an integration stops serving it without anyone switching it off.
--   * The audit log accepts the entity type 'entitlement'.
--
-- Rule (also in modules/entitlements/entitlements.service.ts, which a test keeps in step): an override wins; otherwise an unrestricted
-- plan allows every feature and has no limits; otherwise the plan's own rows apply (no feature row = off, no limit row = unlimited).
-- Entitlements apply only while the subscription is trialing (and the trial has not ended), active or past_due.

CREATE TABLE "tenant_feature_overrides" (
	"tenant_id" uuid NOT NULL,
	"feature_key" text NOT NULL,
	"enabled" boolean NOT NULL,
	"note" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_feature_overrides_pkey" PRIMARY KEY ("tenant_id", "feature_key"),
	CONSTRAINT "tenant_feature_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
	CONSTRAINT "tenant_feature_overrides_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL,
	CONSTRAINT "tenant_feature_overrides_key_check" CHECK ("feature_key" ~ '^[a-z][a-z0-9_]{1,48}$'),
	CONSTRAINT "tenant_feature_overrides_note_check" CHECK ("note" is null or char_length("note") <= 200)
);
--> statement-breakpoint
CREATE TABLE "tenant_limit_overrides" (
	"tenant_id" uuid NOT NULL,
	"limit_key" text NOT NULL,
	"soft_limit" bigint,
	"hard_limit" bigint,
	"note" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_limit_overrides_pkey" PRIMARY KEY ("tenant_id", "limit_key"),
	CONSTRAINT "tenant_limit_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
	CONSTRAINT "tenant_limit_overrides_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL,
	CONSTRAINT "tenant_limit_overrides_key_check" CHECK ("limit_key" ~ '^[a-z][a-z0-9_]{1,48}$'),
	CONSTRAINT "tenant_limit_overrides_values_check" CHECK (("soft_limit" is null or "soft_limit" >= 0) and ("hard_limit" is null or "hard_limit" >= 0) and ("soft_limit" is null or "hard_limit" is null or "soft_limit" <= "hard_limit")),
	CONSTRAINT "tenant_limit_overrides_note_check" CHECK ("note" is null or char_length("note") <= 200)
);
--> statement-breakpoint
ALTER TABLE "tenant_feature_overrides" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_limit_overrides" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.tenant_feature_overrides, public.tenant_limit_overrides FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_feature_overrides, public.tenant_limit_overrides TO authenticated;
--> statement-breakpoint
CREATE POLICY tenant_feature_overrides_platform_admin ON public.tenant_feature_overrides FOR ALL TO authenticated
  USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
--> statement-breakpoint
CREATE POLICY tenant_limit_overrides_platform_admin ON public.tenant_limit_overrides FOR ALL TO authenticated
  USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
--> statement-breakpoint

ALTER TABLE "admin_audit_logs" DROP CONSTRAINT "admin_audit_logs_entity_type_check";
--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_entity_type_check" CHECK ("entity_type" in ('organization', 'store', 'team_member', 'platform_admin', 'support_note', 'platform_settings', 'plan', 'subscription', 'entitlement'));
--> statement-breakpoint

-- Raw entitlement inputs for one tenant ------------------------------------------------------------------------------------
-- NULL when the tenant has no subscription. Callable by a member of that tenant or a Platform Admin; nobody else.
CREATE FUNCTION public.tenant_entitlements(p_tenant uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT (public.is_tenant_member(p_tenant) OR public.is_platform_admin()) OR session_user = 'authenticator' THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  SELECT jsonb_build_object(
    'subscription', jsonb_build_object(
      'status', s.status,
      'billing_interval', s.billing_interval,
      'trial_ends_at', s.trial_ends_at,
      'current_period_end', s.current_period_end,
      'plan_id', p.id, 'plan_code', p.code, 'plan_name', p.name, 'is_unrestricted', p.is_unrestricted),
    'features', coalesce((SELECT jsonb_object_agg(f.feature_key, f.enabled) FROM public.plan_features f WHERE f.plan_id = p.id), '{}'::jsonb),
    'limits', coalesce((SELECT jsonb_object_agg(l.limit_key, jsonb_build_object('soft', l.soft_limit, 'hard', l.hard_limit))
                        FROM public.plan_limits l WHERE l.plan_id = p.id), '{}'::jsonb),
    'feature_overrides', coalesce((SELECT jsonb_object_agg(o.feature_key, o.enabled)
                                   FROM public.tenant_feature_overrides o WHERE o.tenant_id = s.tenant_id), '{}'::jsonb),
    'limit_overrides', coalesce((SELECT jsonb_object_agg(o.limit_key, jsonb_build_object('soft', o.soft_limit, 'hard', o.hard_limit))
                                 FROM public.tenant_limit_overrides o WHERE o.tenant_id = s.tenant_id), '{}'::jsonb)
  ) INTO v_result
  FROM public.tenant_subscriptions s
  JOIN public.plans p ON p.id = s.plan_id
  WHERE s.tenant_id = p_tenant;
  RETURN v_result;
END;
$$;
--> statement-breakpoint

-- Current numbers for the limits that can be counted; p_keys limits the work to the keys asked for (NULL = all but storage). Storage
-- is measured only when named (it reads Supabase Storage) and is NULL when it cannot be measured. Orders are those placed since the start of the current UTC month.
CREATE FUNCTION public.tenant_usage_counts(p_tenant uuid, p_keys text[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_tenant_member(p_tenant) OR public.is_platform_admin()) OR session_user = 'authenticator' THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  RETURN jsonb_build_object(
    'products', CASE WHEN p_keys IS NULL OR 'products' = ANY (p_keys) THEN
      (SELECT count(*) FROM public.products x WHERE x.tenant_id = p_tenant) END,
    'staff_accounts', CASE WHEN p_keys IS NULL OR 'staff_accounts' = ANY (p_keys) THEN
      (SELECT count(*) FROM public.memberships m WHERE m.tenant_id = p_tenant AND m.role <> 'owner' AND m.status = 'active') END,
    'orders_per_month', CASE WHEN p_keys IS NULL OR 'orders_per_month' = ANY (p_keys) THEN
      (SELECT count(*) FROM public.orders o
       WHERE o.tenant_id = p_tenant AND o.placed_at >= date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc') END,
    'storage_bytes', CASE WHEN p_keys IS NOT NULL AND 'storage_bytes' = ANY (p_keys) THEN public.tenant_storage_bytes(p_tenant) END
  );
END;
$$;
--> statement-breakpoint

-- The effective-feature rule for other SQL functions. Not granted to the API.
CREATE FUNCTION public.tenant_has_feature(p_tenant uuid, p_feature text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce((
    SELECT (s.status IN ('active', 'past_due') OR (s.status = 'trialing' AND (s.trial_ends_at IS NULL OR s.trial_ends_at > now())))
       AND coalesce(
         (SELECT o.enabled FROM public.tenant_feature_overrides o WHERE o.tenant_id = s.tenant_id AND o.feature_key = p_feature),
         p.is_unrestricted OR coalesce((SELECT f.enabled FROM public.plan_features f WHERE f.plan_id = p.id AND f.feature_key = p_feature), false))
    FROM public.tenant_subscriptions s JOIN public.plans p ON p.id = s.plan_id
    WHERE s.tenant_id = p_tenant), false)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.tenant_has_feature(uuid, text) FROM public, anon, authenticated;
--> statement-breakpoint

-- The storefront learns about an integration only while the tenant's plan includes it.
CREATE OR REPLACE FUNCTION public.public_tracking_config(p_tenant uuid)
RETURNS TABLE (provider_code text, config jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT i.provider_code, i.config
  FROM public.marketing_integrations i
  WHERE i.tenant_id = p_tenant AND p_tenant = public.pinned_tenant_id()
    AND i.enabled AND i.validation_status = 'valid'
    AND public.tenant_has_feature(p_tenant, CASE i.provider_code
      WHEN 'ga4' THEN 'google_analytics'
      WHEN 'meta_pixel' THEN 'meta_pixel'
      ELSE i.provider_code END)
  ORDER BY i.provider_code
$$;
--> statement-breakpoint

-- Platform-wide limit report -----------------------------------------------------------------------------------------------
-- One page of tenants with used / soft / hard for the limits that can be counted cheaply (products, staff, orders this month);
-- storage is left to the single-tenant view because measuring it reads Storage. p_filter: all | attention (warning or reached) |
-- warning (close, none reached) | reached (at or over a hard limit). "Close" = at or past a soft limit, or at 80% of a hard limit.
CREATE FUNCTION public.platform_limit_usage_page(
  p_search text DEFAULT NULL, p_filter text DEFAULT 'all', p_limit integer DEFAULT 20, p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid, name text, slug text, status text,
  plan_code text, plan_name text, subscription_status text, is_unrestricted boolean,
  products_used bigint, products_soft bigint, products_hard bigint,
  staff_used bigint, staff_soft bigint, staff_hard bigint,
  orders_used bigint, orders_soft bigint, orders_hard bigint,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_pattern text;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_filter IS NULL OR p_filter NOT IN ('all', 'attention', 'warning', 'reached') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  v_pattern := CASE
    WHEN nullif(btrim(p_search), '') IS NULL THEN NULL
    ELSE '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  END;

  RETURN QUERY
  WITH base AS (
    SELECT t.id, t.name, t.slug, t.status, t.created_at,
           p.code AS plan_code, p.name AS plan_name, s.status AS sub_status, p.is_unrestricted, p.id AS plan_id,
           (SELECT count(*) FROM public.products x WHERE x.tenant_id = t.id) AS pu,
           (SELECT count(*) FROM public.memberships m WHERE m.tenant_id = t.id AND m.role <> 'owner' AND m.status = 'active') AS su,
           (SELECT count(*) FROM public.orders o WHERE o.tenant_id = t.id
              AND o.placed_at >= date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc') AS ou
    FROM public.tenants t
    JOIN public.tenant_subscriptions s ON s.tenant_id = t.id
    JOIN public.plans p ON p.id = s.plan_id
    WHERE v_pattern IS NULL OR t.name ILIKE v_pattern OR t.slug ILIKE v_pattern OR t.id::text ILIKE v_pattern
  ),
  eff AS (
    SELECT b.*,
      CASE WHEN po.tenant_id IS NOT NULL THEN po.soft_limit WHEN b.is_unrestricted THEN NULL ELSE pp.soft_limit END AS ps,
      CASE WHEN po.tenant_id IS NOT NULL THEN po.hard_limit WHEN b.is_unrestricted THEN NULL ELSE pp.hard_limit END AS ph,
      CASE WHEN so.tenant_id IS NOT NULL THEN so.soft_limit WHEN b.is_unrestricted THEN NULL ELSE sp.soft_limit END AS ss,
      CASE WHEN so.tenant_id IS NOT NULL THEN so.hard_limit WHEN b.is_unrestricted THEN NULL ELSE sp.hard_limit END AS sh,
      CASE WHEN oo.tenant_id IS NOT NULL THEN oo.soft_limit WHEN b.is_unrestricted THEN NULL ELSE op.soft_limit END AS os,
      CASE WHEN oo.tenant_id IS NOT NULL THEN oo.hard_limit WHEN b.is_unrestricted THEN NULL ELSE op.hard_limit END AS oh
    FROM base b
    LEFT JOIN public.plan_limits pp ON pp.plan_id = b.plan_id AND pp.limit_key = 'products'
    LEFT JOIN public.tenant_limit_overrides po ON po.tenant_id = b.id AND po.limit_key = 'products'
    LEFT JOIN public.plan_limits sp ON sp.plan_id = b.plan_id AND sp.limit_key = 'staff_accounts'
    LEFT JOIN public.tenant_limit_overrides so ON so.tenant_id = b.id AND so.limit_key = 'staff_accounts'
    LEFT JOIN public.plan_limits op ON op.plan_id = b.plan_id AND op.limit_key = 'orders_per_month'
    LEFT JOIN public.tenant_limit_overrides oo ON oo.tenant_id = b.id AND oo.limit_key = 'orders_per_month'
  ),
  flagged AS (
    SELECT e.*,
      (e.ph IS NOT NULL AND e.pu >= e.ph) OR (e.sh IS NOT NULL AND e.su >= e.sh) OR (e.oh IS NOT NULL AND e.ou >= e.oh) AS any_reached,
      (NOT (e.ph IS NOT NULL AND e.pu >= e.ph) AND ((e.ps IS NOT NULL AND e.pu >= e.ps) OR (e.ph IS NOT NULL AND e.pu * 5 >= e.ph * 4)))
      OR (NOT (e.sh IS NOT NULL AND e.su >= e.sh) AND ((e.ss IS NOT NULL AND e.su >= e.ss) OR (e.sh IS NOT NULL AND e.su * 5 >= e.sh * 4)))
      OR (NOT (e.oh IS NOT NULL AND e.ou >= e.oh) AND ((e.os IS NOT NULL AND e.ou >= e.os) OR (e.oh IS NOT NULL AND e.ou * 5 >= e.oh * 4))) AS any_warning
    FROM eff e
  ),
  picked AS (
    SELECT f.*, count(*) OVER () AS total_count
    FROM flagged f
    WHERE p_filter = 'all'
       OR (p_filter = 'attention' AND (f.any_reached OR f.any_warning))
       OR (p_filter = 'warning' AND f.any_warning)
       OR (p_filter = 'reached' AND f.any_reached)
  )
  SELECT k.id, k.name, k.slug, k.status, k.plan_code, k.plan_name, k.sub_status, k.is_unrestricted,
         k.pu, k.ps, k.ph, k.su, k.ss, k.sh, k.ou, k.os, k.oh, k.total_count
  FROM picked k
  ORDER BY k.any_reached DESC, k.any_warning DESC, lower(k.name), k.id
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 100)
  OFFSET greatest(coalesce(p_offset, 0), 0);
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.tenant_entitlements(uuid) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.tenant_usage_counts(uuid, text[]) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_limit_usage_page(text, text, integer, integer) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.tenant_entitlements(uuid) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.tenant_usage_counts(uuid, text[]) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_limit_usage_page(text, text, integer, integer) TO authenticated;
