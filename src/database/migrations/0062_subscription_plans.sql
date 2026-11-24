-- Custom migration: subscription plans, plan features and limits, and one subscription per tenant.
--
--   * plans / plan_features / plan_limits: configured by Platform Admins. Which capabilities exist is defined in code
--     (common/constants/plan-catalog.ts); which plan includes which, and every number, is data.
--   * tenant_subscriptions: exactly one row per tenant. A trigger gives every NEW tenant the default plan, so no creation path
--     can leave a tenant without a subscription; platform_assign_plan() moves a tenant to another plan.
--   * A seeded "Legacy" plan (unrestricted: every feature, no limits) is the default and is given to every EXISTING tenant, so
--     nothing changes for current merchants until an admin moves them.
--   * The tables are reachable only by Platform Admins (RLS + grants). A tenant never reads them directly.
--   * The audit log accepts the new entity types 'plan' and 'subscription'.

-- Plans ------------------------------------------------------------------------------------------------------------
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"monthly_price_minor" bigint DEFAULT 0 NOT NULL,
	"yearly_price_minor" bigint DEFAULT 0 NOT NULL,
	"trial_days" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_unrestricted" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL,
	CONSTRAINT "plans_code_check" CHECK ("code" ~ '^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]$'),
	CONSTRAINT "plans_name_check" CHECK (char_length(btrim("name")) between 2 and 60),
	CONSTRAINT "plans_description_check" CHECK ("description" is null or char_length("description") <= 500),
	CONSTRAINT "plans_status_check" CHECK ("status" in ('active', 'inactive')),
	CONSTRAINT "plans_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "plans_prices_check" CHECK ("monthly_price_minor" between 0 and 100000000000 and "yearly_price_minor" between 0 and 100000000000),
	CONSTRAINT "plans_trial_days_check" CHECK ("trial_days" between 0 and 365),
	CONSTRAINT "plans_default_active_check" CHECK (not "is_default" or "status" = 'active')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "plans_code_key" ON "plans" USING btree ("code");
--> statement-breakpoint
CREATE UNIQUE INDEX "plans_one_default_idx" ON "plans" USING btree ("is_default") WHERE "is_default";
--> statement-breakpoint
CREATE TRIGGER plans_set_updated_at BEFORE UPDATE ON public.plans FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE "plan_features" (
	"plan_id" uuid NOT NULL,
	"feature_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "plan_features_pkey" PRIMARY KEY ("plan_id", "feature_key"),
	CONSTRAINT "plan_features_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE,
	CONSTRAINT "plan_features_key_check" CHECK ("feature_key" ~ '^[a-z][a-z0-9_]{1,48}$')
);
--> statement-breakpoint

CREATE TABLE "plan_limits" (
	"plan_id" uuid NOT NULL,
	"limit_key" text NOT NULL,
	"soft_limit" bigint,
	"hard_limit" bigint,
	CONSTRAINT "plan_limits_pkey" PRIMARY KEY ("plan_id", "limit_key"),
	CONSTRAINT "plan_limits_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE,
	CONSTRAINT "plan_limits_key_check" CHECK ("limit_key" ~ '^[a-z][a-z0-9_]{1,48}$'),
	CONSTRAINT "plan_limits_values_check" CHECK (("soft_limit" is null or "soft_limit" >= 0) and ("hard_limit" is null or "hard_limit" >= 0) and ("soft_limit" is null or "hard_limit" is null or "soft_limit" <= "hard_limit"))
);
--> statement-breakpoint

-- Tenant subscriptions -------------------------------------------------------------------------------------------------
CREATE TABLE "tenant_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" text NOT NULL,
	"billing_interval" text DEFAULT 'monthly' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone DEFAULT now() NOT NULL,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
	CONSTRAINT "tenant_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT,
	CONSTRAINT "tenant_subscriptions_status_check" CHECK ("status" in ('trialing', 'active', 'past_due', 'canceled', 'expired')),
	CONSTRAINT "tenant_subscriptions_interval_check" CHECK ("billing_interval" in ('monthly', 'yearly'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_subscriptions_tenant_key" ON "tenant_subscriptions" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "tenant_subscriptions_plan_idx" ON "tenant_subscriptions" USING btree ("plan_id");
--> statement-breakpoint
CREATE INDEX "tenant_subscriptions_status_idx" ON "tenant_subscriptions" USING btree ("status");
--> statement-breakpoint
CREATE TRIGGER tenant_subscriptions_set_updated_at BEFORE UPDATE ON public.tenant_subscriptions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Access: Platform Admins only ----------------------------------------------------------------------------------------
ALTER TABLE "plans" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "plan_features" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "plan_limits" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.plans, public.plan_features, public.plan_limits, public.tenant_subscriptions FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.plans TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plan_features, public.plan_limits TO authenticated;
--> statement-breakpoint
-- Subscriptions are created by the trigger / platform_assign_plan() only; the API may read them and update them in place.
GRANT SELECT ON public.tenant_subscriptions TO authenticated;
--> statement-breakpoint
CREATE POLICY plans_platform_admin ON public.plans FOR ALL TO authenticated
  USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
--> statement-breakpoint
CREATE POLICY plan_features_platform_admin ON public.plan_features FOR ALL TO authenticated
  USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
--> statement-breakpoint
CREATE POLICY plan_limits_platform_admin ON public.plan_limits FOR ALL TO authenticated
  USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
--> statement-breakpoint
CREATE POLICY tenant_subscriptions_platform_admin_read ON public.tenant_subscriptions FOR SELECT TO authenticated
  USING (public.is_platform_admin());
--> statement-breakpoint

-- Applying a plan ---------------------------------------------------------------------------------------------------------
-- The one place that decides a subscription's status and dates, so the trigger and the admin action cannot disagree.
-- p_start_trial: begin a trial when the plan has one. Without a trial the subscription is active; a paid plan gets a
-- renewal date one billing interval ahead, a free plan has none. Not callable by the API (no grants).
CREATE FUNCTION public.apply_plan_to_tenant(p_tenant uuid, p_plan uuid, p_interval text, p_start_trial boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_plan public.plans%ROWTYPE;
  v_now timestamptz := now();
  v_price bigint;
  v_status text;
  v_trial_end timestamptz;
  v_end timestamptz;
BEGIN
  IF p_interval IS NULL OR p_interval NOT IN ('monthly', 'yearly') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  SELECT * INTO v_plan FROM public.plans WHERE id = p_plan;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_not_found';
  END IF;
  v_price := CASE WHEN p_interval = 'yearly' THEN v_plan.yearly_price_minor ELSE v_plan.monthly_price_minor END;
  IF coalesce(p_start_trial, false) AND v_plan.trial_days > 0 THEN
    v_status := 'trialing';
    v_trial_end := v_now + make_interval(days => v_plan.trial_days);
    v_end := v_trial_end;
  ELSE
    v_status := 'active';
    v_trial_end := NULL;
    v_end := CASE WHEN v_price > 0
      THEN v_now + CASE WHEN p_interval = 'yearly' THEN interval '1 year' ELSE interval '1 month' END
      ELSE NULL END;
  END IF;
  INSERT INTO public.tenant_subscriptions
    (tenant_id, plan_id, status, billing_interval, trial_ends_at, current_period_start, current_period_end)
  VALUES (p_tenant, p_plan, v_status, p_interval, v_trial_end, v_now, v_end)
  ON CONFLICT (tenant_id) DO UPDATE SET
    plan_id = EXCLUDED.plan_id,
    status = EXCLUDED.status,
    billing_interval = EXCLUDED.billing_interval,
    trial_ends_at = EXCLUDED.trial_ends_at,
    current_period_start = EXCLUDED.current_period_start,
    current_period_end = EXCLUDED.current_period_end,
    cancel_at_period_end = false,
    canceled_at = NULL;
END;
$$;
--> statement-breakpoint

-- Platform Admin action: put a tenant on an ACTIVE plan.
CREATE FUNCTION public.platform_assign_plan(p_tenant uuid, p_plan uuid, p_interval text, p_start_trial boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  PERFORM 1 FROM public.tenants t WHERE t.id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  SELECT p.status INTO v_status FROM public.plans p WHERE p.id = p_plan FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_not_found';
  END IF;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'plan_inactive';
  END IF;
  PERFORM public.apply_plan_to_tenant(p_tenant, p_plan, p_interval, p_start_trial);
END;
$$;
--> statement-breakpoint

-- Every new tenant starts on the default plan.
CREATE FUNCTION public.tenants_assign_default_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_plan uuid;
BEGIN
  SELECT p.id INTO v_plan FROM public.plans p WHERE p.is_default AND p.status = 'active';
  IF v_plan IS NOT NULL THEN
    PERFORM public.apply_plan_to_tenant(NEW.id, v_plan, 'monthly', true);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.apply_plan_to_tenant(uuid, uuid, text, boolean) FROM public, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.tenants_assign_default_plan() FROM public, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_assign_plan(uuid, uuid, text, boolean) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_assign_plan(uuid, uuid, text, boolean) TO authenticated;
--> statement-breakpoint

-- Seed the Legacy plan and give it to every existing tenant -----------------------------------------------------------------
INSERT INTO public.plans (code, name, description, status, is_default, is_unrestricted, sort_order)
VALUES ('legacy', 'Legacy', 'Tenants that existed before plans. Every feature, no limits. Edit or replace it from the admin dashboard.', 'active', true, true, 0);
--> statement-breakpoint
INSERT INTO public.tenant_subscriptions (tenant_id, plan_id, status, billing_interval)
SELECT t.id, p.id, 'active', 'monthly' FROM public.tenants t CROSS JOIN public.plans p WHERE p.code = 'legacy';
--> statement-breakpoint
CREATE TRIGGER tenants_assign_default_plan AFTER INSERT ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.tenants_assign_default_plan();
--> statement-breakpoint

-- Audit log: plans and subscriptions are auditable entities ---------------------------------------------------------------
ALTER TABLE "admin_audit_logs" DROP CONSTRAINT "admin_audit_logs_entity_type_check";
--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_entity_type_check" CHECK ("entity_type" in ('organization', 'store', 'team_member', 'platform_admin', 'support_note', 'platform_settings', 'plan', 'subscription'));
