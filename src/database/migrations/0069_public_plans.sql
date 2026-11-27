-- The subscription plans a visitor can see on the public site (the Kanova Store landing page).
--
-- Plans, their features and limits are visible only to Platform Admins (row level security). A plan is "published" when its status
-- is active, so this function hands anonymous callers just that: the active, restricted plans, with what each one costs and which
-- features and limits it has. Unrestricted plans (grandfathered or internal ones, such as the seeded Legacy plan) are never listed.
-- No ids, subscriber counts or audit data leave the database. A limit with no hard number is unlimited, so it is simply left out.

CREATE FUNCTION public.get_public_plans()
RETURNS TABLE (
  code text, name text, description text, currency text,
  monthly_price_minor bigint, yearly_price_minor bigint, trial_days integer, sort_order integer,
  features text[], limits jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    p.code, p.name, p.description, p.currency,
    p.monthly_price_minor, p.yearly_price_minor, p.trial_days, p.sort_order,
    COALESCE(
      (SELECT array_agg(f.feature_key ORDER BY f.feature_key) FROM public.plan_features f WHERE f.plan_id = p.id AND f.enabled),
      ARRAY[]::text[]
    ),
    COALESCE(
      (SELECT jsonb_object_agg(l.limit_key, l.hard_limit) FROM public.plan_limits l WHERE l.plan_id = p.id AND l.hard_limit IS NOT NULL),
      '{}'::jsonb
    )
  FROM public.plans p
  WHERE p.status = 'active' AND NOT p.is_unrestricted
  ORDER BY p.sort_order, p.monthly_price_minor, p.name;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_public_plans() FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_public_plans() TO authenticated;
