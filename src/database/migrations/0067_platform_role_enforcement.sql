-- Custom migration: the database enforces the platform role matrix itself (defence in depth).
--
-- Until now every platform_* function and every platform table asked only "is this person ANY platform staff member?"
-- (is_platform_admin()). The API decides what each role may do, but a mistake there (a route without the right permission) would
-- have let a Billing or Support admin reach a function meant for operators. From here the database refuses it too:
--
--   operator roles (super_admin, admin): tenants, stores, team and ownership, plans, subscriptions, entitlements, audit log, monitoring
--   billing roles  (super_admin, billing_admin): invoices, payments, refunds, billing runs and settings
--
-- platform_list_audit() is deliberately NOT in the list: the per-organization activity route lets Support read one organization's history
-- (tenants:read), so the function stays open to all staff and the API keeps the general audit log (audit:read) to operators.
-- Reads that every role needs (tenant lists, usage, a tenant's subscription and plan name) stay open to all staff; the API still decides
-- which of them each role sees. Function BODIES are not rewritten by hand: the existing definitions are re-created with the one check
-- swapped, so nothing else about them can change, and the migration fails loudly if a function is missing or does not contain the check.

CREATE FUNCTION public.platform_role_in(p_roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT session_user <> 'authenticator'
    AND EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = (SELECT auth.uid()) AND pa.role = ANY (p_roles));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_role_in(text[]) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_role_in(text[]) TO authenticated;
--> statement-breakpoint

-- Functions: swap `public.is_platform_admin()` for the role check ----------------------------------------------------------------------
DO $migration$
DECLARE
  v_name text;
  v_oid oid;
  v_def text;
  v_new text;
  v_check text;
  v_found boolean;
  v_operator text := 'public.platform_role_in(ARRAY[''super_admin'', ''admin''])';
  v_billing text := 'public.platform_role_in(ARRAY[''super_admin'', ''billing_admin''])';
BEGIN
  FOR v_name, v_check IN
    SELECT n, c FROM (VALUES
      ('platform_provision_tenant', v_operator), ('platform_set_tenant_status', v_operator), ('platform_update_tenant', v_operator),
      ('platform_update_store', v_operator), ('platform_add_member', v_operator),
      ('platform_set_member_status', v_operator), ('platform_remove_member', v_operator), ('platform_assign_owner', v_operator),
      ('platform_delete_tenant', v_operator), ('platform_assign_plan', v_operator),
      ('platform_audit_admins', v_operator), ('platform_list_admins', v_operator),
      ('platform_issue_invoice', v_billing), ('platform_void_invoice', v_billing), ('platform_record_manual_payment', v_billing),
      ('platform_refund_begin', v_billing), ('platform_refund_finish', v_billing), ('platform_run_billing', v_billing)
    ) AS t(n, c)
  LOOP
    v_found := false;
    -- Every overload of the name, so none can be left on the old check.
    FOR v_oid IN
      SELECT p.oid FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = v_name
    LOOP
      v_found := true;
      v_def := pg_get_functiondef(v_oid);
      IF position('public.is_platform_admin()' IN v_def) = 0 THEN
        RAISE EXCEPTION 'migration 0067: function % does not contain public.is_platform_admin()', v_name;
      END IF;
      v_new := replace(v_def, 'public.is_platform_admin()', v_check);
      EXECUTE v_new;
    END LOOP;
    IF NOT v_found THEN
      RAISE EXCEPTION 'migration 0067: function % does not exist', v_name;
    END IF;
  END LOOP;
END
$migration$;
--> statement-breakpoint

-- Tables: reads for staff who need them, writes for the roles that may change them ----------------------------------------------------
-- Plans, features and limits: every staff role may read (a Support admin shows a tenant's plan name); operators change them.
DROP POLICY plans_platform_admin ON public.plans;
--> statement-breakpoint
DROP POLICY plan_features_platform_admin ON public.plan_features;
--> statement-breakpoint
DROP POLICY plan_limits_platform_admin ON public.plan_limits;
--> statement-breakpoint
CREATE POLICY plans_read ON public.plans FOR SELECT TO authenticated USING (public.is_platform_admin());
--> statement-breakpoint
CREATE POLICY plans_write ON public.plans FOR ALL TO authenticated
  USING (public.platform_role_in(ARRAY['super_admin', 'admin'])) WITH CHECK (public.platform_role_in(ARRAY['super_admin', 'admin']));
--> statement-breakpoint
CREATE POLICY plan_features_read ON public.plan_features FOR SELECT TO authenticated USING (public.is_platform_admin());
--> statement-breakpoint
CREATE POLICY plan_features_write ON public.plan_features FOR ALL TO authenticated
  USING (public.platform_role_in(ARRAY['super_admin', 'admin'])) WITH CHECK (public.platform_role_in(ARRAY['super_admin', 'admin']));
--> statement-breakpoint
CREATE POLICY plan_limits_read ON public.plan_limits FOR SELECT TO authenticated USING (public.is_platform_admin());
--> statement-breakpoint
CREATE POLICY plan_limits_write ON public.plan_limits FOR ALL TO authenticated
  USING (public.platform_role_in(ARRAY['super_admin', 'admin'])) WITH CHECK (public.platform_role_in(ARRAY['super_admin', 'admin']));
--> statement-breakpoint

DROP POLICY tenant_feature_overrides_platform_admin ON public.tenant_feature_overrides;
--> statement-breakpoint
DROP POLICY tenant_limit_overrides_platform_admin ON public.tenant_limit_overrides;
--> statement-breakpoint
CREATE POLICY tenant_feature_overrides_read ON public.tenant_feature_overrides FOR SELECT TO authenticated USING (public.is_platform_admin());
--> statement-breakpoint
CREATE POLICY tenant_feature_overrides_write ON public.tenant_feature_overrides FOR ALL TO authenticated
  USING (public.platform_role_in(ARRAY['super_admin', 'admin'])) WITH CHECK (public.platform_role_in(ARRAY['super_admin', 'admin']));
--> statement-breakpoint
CREATE POLICY tenant_limit_overrides_read ON public.tenant_limit_overrides FOR SELECT TO authenticated USING (public.is_platform_admin());
--> statement-breakpoint
CREATE POLICY tenant_limit_overrides_write ON public.tenant_limit_overrides FOR ALL TO authenticated
  USING (public.platform_role_in(ARRAY['super_admin', 'admin'])) WITH CHECK (public.platform_role_in(ARRAY['super_admin', 'admin']));
--> statement-breakpoint

-- Billing: super admin, Platform Admin and Billing Admin read; billing roles change the settings.
DROP POLICY billing_settings_platform_admin ON public.billing_settings;
--> statement-breakpoint
CREATE POLICY billing_settings_read ON public.billing_settings FOR SELECT TO authenticated
  USING (public.platform_role_in(ARRAY['super_admin', 'admin', 'billing_admin']));
--> statement-breakpoint
CREATE POLICY billing_settings_write ON public.billing_settings FOR UPDATE TO authenticated
  USING (public.platform_role_in(ARRAY['super_admin', 'billing_admin'])) WITH CHECK (public.platform_role_in(ARRAY['super_admin', 'billing_admin']));
--> statement-breakpoint
DROP POLICY billing_invoices_read ON public.billing_invoices;
--> statement-breakpoint
CREATE POLICY billing_invoices_read ON public.billing_invoices FOR SELECT TO authenticated
  USING (public.platform_role_in(ARRAY['super_admin', 'admin', 'billing_admin']) OR public.has_tenant_role(tenant_id, ARRAY['owner']));
--> statement-breakpoint
DROP POLICY billing_payments_read ON public.billing_payments;
--> statement-breakpoint
CREATE POLICY billing_payments_read ON public.billing_payments FOR SELECT TO authenticated
  USING (public.platform_role_in(ARRAY['super_admin', 'admin', 'billing_admin']) OR public.has_tenant_role(tenant_id, ARRAY['owner']));
--> statement-breakpoint
DROP POLICY billing_refunds_read ON public.billing_refunds;
--> statement-breakpoint
CREATE POLICY billing_refunds_read ON public.billing_refunds FOR SELECT TO authenticated
  USING (public.platform_role_in(ARRAY['super_admin', 'admin', 'billing_admin']) OR public.has_tenant_role(tenant_id, ARRAY['owner']));
--> statement-breakpoint
DROP POLICY billing_webhook_events_read ON public.billing_webhook_events;
--> statement-breakpoint
CREATE POLICY billing_webhook_events_read ON public.billing_webhook_events FOR SELECT TO authenticated
  USING (public.platform_role_in(ARRAY['super_admin', 'admin', 'billing_admin']));
--> statement-breakpoint

-- Monitoring data: operators only (monitoring:read).
DROP POLICY platform_error_events_read ON public.platform_error_events;
--> statement-breakpoint
CREATE POLICY platform_error_events_read ON public.platform_error_events FOR SELECT TO authenticated
  USING (public.platform_role_in(ARRAY['super_admin', 'admin']));
--> statement-breakpoint
DROP POLICY platform_job_runs_read ON public.platform_job_runs;
--> statement-breakpoint
CREATE POLICY platform_job_runs_read ON public.platform_job_runs FOR SELECT TO authenticated
  USING (public.platform_role_in(ARRAY['super_admin', 'admin']));
