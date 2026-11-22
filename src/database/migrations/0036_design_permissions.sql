-- Custom migration: the `design` permission module (Studio) and the member capabilities `attest` / `discard`.
--
-- Model
--  * memberships.permissions gains a fifth module, `design`, with the levels none < read < write < publish
--    (publish implies write implies read). The existing modules keep their levels (none / read / write).
--  * memberships.capabilities text[] holds the independent capabilities 'attest' and 'discard'. They are NOT
--    levels: they are granted separately and never imply (or require) a design level. The Owner is implicit.
--  * Editing never publishes. The template tables (templates, template_versions, template_assignments,
--    store_themes) and product_presentations are gated by RESTRICTIVE policies (ANDed with the existing role
--    policies, which are untouched):
--      draft writes (insert / update / delete)            -> design:write
--      publishing (template_versions insert, changing templates.published_version_id or
--      product_presentations.published)                   -> design:publish
--    Before this migration the template tables needed settings:write and product_presentations had no module gate
--    at all (only the owner/admin role policies of 0032).
--  * Reads stay open to every member of the tenant at the database level (the collection-usage check reads the
--    templates as a products member); the API narrows them with design:view.
--  * public.migrate_design_permissions() converts existing members once (idempotent, with a before/after record).

-- 1. Validation: five modules, `design` takes `publish` too. -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_valid_member_permissions(p jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT jsonb_typeof(p) = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(p) e
      WHERE e.key NOT IN ('products', 'orders', 'customers', 'settings', 'design')
         OR jsonb_typeof(e.value) <> 'string'
         OR (e.key <> 'design' AND (e.value #>> '{}') NOT IN ('none', 'read', 'write'))
         OR (e.key = 'design' AND (e.value #>> '{}') NOT IN ('none', 'read', 'write', 'publish'))
    );
$$;
--> statement-breakpoint

-- 2. Capabilities column. ----------------------------------------------------------------------------------------
ALTER TABLE "memberships" ADD COLUMN "capabilities" text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_capabilities_check" CHECK ("memberships"."capabilities" <@ ARRAY['attest', 'discard']::text[]);
--> statement-breakpoint
GRANT UPDATE (capabilities) ON public.memberships TO authenticated;
--> statement-breakpoint

-- 3. Access check understands levels by rank. ---------------------------------------------------------------------
-- Same signature, same security properties as 0018. An unknown or 'none' requested level never matches.
CREATE OR REPLACE FUNCTION public.has_module_access(p_tenant_id uuid, p_module text, p_level text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.memberships m
    JOIN public.tenants t ON t.id = m.tenant_id
    WHERE m.tenant_id = p_tenant_id
      AND m.user_id = (SELECT auth.uid())
      AND m.status = 'active'
      AND t.status = 'active'
      AND (
        m.role = 'owner'
        OR (
          CASE p_level WHEN 'read' THEN 1 WHEN 'write' THEN 2 WHEN 'publish' THEN 3 ELSE 99 END
          <= CASE m.permissions ->> p_module WHEN 'read' THEN 1 WHEN 'write' THEN 2 WHEN 'publish' THEN 3 ELSE 0 END
        )
      )
  );
$$;
--> statement-breakpoint

-- Does the signed-in user hold a capability ('attest' / 'discard') in this tenant? The Owner holds both.
CREATE FUNCTION public.has_member_capability(p_tenant_id uuid, p_capability text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.memberships m
    JOIN public.tenants t ON t.id = m.tenant_id
    WHERE m.tenant_id = p_tenant_id
      AND m.user_id = (SELECT auth.uid())
      AND m.status = 'active'
      AND t.status = 'active'
      AND (m.role = 'owner' OR p_capability = ANY (m.capabilities))
  );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.has_member_capability(uuid, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.has_member_capability(uuid, text) TO authenticated;
--> statement-breakpoint

-- 4. Replace the settings:write gate on the template tables (0025) and add the missing one on product_presentations.
DO $perm$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['templates', 'template_versions', 'template_assignments', 'store_themes']
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', tbl || '_perm_insert', tbl);
    EXECUTE format('DROP POLICY %I ON public.%I', tbl || '_perm_update', tbl);
    IF tbl <> 'template_versions' THEN
      EXECUTE format('DROP POLICY %I ON public.%I', tbl || '_perm_delete', tbl);
    END IF;
  END LOOP;

  FOREACH tbl IN ARRAY ARRAY['templates', 'template_assignments', 'store_themes', 'product_presentations']
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (public.has_module_access(tenant_id, ''design'', ''write''))',
      tbl || '_perm_insert', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated USING (public.has_module_access(tenant_id, ''design'', ''write'')) WITH CHECK (public.has_module_access(tenant_id, ''design'', ''write''))',
      tbl || '_perm_update', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated USING (public.has_module_access(tenant_id, ''design'', ''write''))',
      tbl || '_perm_delete', tbl);
  END LOOP;
END
$perm$;
--> statement-breakpoint

-- A published version is the act of publishing: it needs design:publish. (History is insert-only: no UPDATE/DELETE grant.)
CREATE POLICY template_versions_perm_insert ON public.template_versions AS RESTRICTIVE
  FOR INSERT TO authenticated
  WITH CHECK (public.has_module_access(tenant_id, 'design', 'publish'));
--> statement-breakpoint

-- 5. Publishing through UPDATE. RLS cannot compare old and new values, so a trigger refuses a change of the
-- published pointer / published document unless the caller holds design:publish. It only judges the request role
-- (`authenticated`): privileged connections (migrations, seeds) and SECURITY DEFINER functions are not affected.
CREATE FUNCTION public.templates_design_publish_gate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user = 'authenticated'
     AND NEW.published_version_id IS DISTINCT FROM OLD.published_version_id
     AND NOT public.has_module_access(NEW.tenant_id, 'design', 'publish') THEN
    RAISE EXCEPTION 'design:publish is required to publish' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.product_presentations_design_publish_gate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user = 'authenticated'
     AND NEW.published IS DISTINCT FROM OLD.published
     AND NOT public.has_module_access(NEW.tenant_id, 'design', 'publish') THEN
    RAISE EXCEPTION 'design:publish is required to publish' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER templates_design_publish_gate
  BEFORE UPDATE ON public.templates
  FOR EACH ROW EXECUTE FUNCTION public.templates_design_publish_gate();
--> statement-breakpoint
CREATE TRIGGER product_presentations_design_publish_gate
  BEFORE UPDATE ON public.product_presentations
  FOR EACH ROW EXECUTE FUNCTION public.product_presentations_design_publish_gate();
--> statement-breakpoint

-- 6. Team read carries the capabilities. --------------------------------------------------------------------------
DROP FUNCTION public.list_tenant_team(uuid);
--> statement-breakpoint
CREATE FUNCTION public.list_tenant_team(p_tenant_id uuid)
RETURNS TABLE (user_id uuid, full_name text, email text, role text, status text, joined_at timestamptz, permissions jsonb, capabilities text[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public.is_platform_admin() OR public.has_tenant_role(p_tenant_id, array['owner'])) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  RETURN QUERY
  SELECT m.user_id, p.full_name, u.email::text, m.role, m.status, m.created_at, m.permissions, m.capabilities
  FROM public.memberships m
  JOIN auth.users u ON u.id = m.user_id
  LEFT JOIN public.profiles p ON p.id = m.user_id
  WHERE m.tenant_id = p_tenant_id
  ORDER BY (m.role = 'owner') DESC, m.created_at, m.id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_tenant_team(uuid) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_tenant_team(uuid) TO authenticated;
--> statement-breakpoint

-- 7. Conversion of existing members. ------------------------------------------------------------------------------
-- Record of what the conversion changed. Append-only (trigger), unreachable for the app roles (RLS on, no policy,
-- no grant). Rows are written only for memberships that were actually changed.
CREATE TABLE "design_permission_migration_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"membership_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"before_permissions" jsonb NOT NULL,
	"after_permissions" jsonb NOT NULL,
	"before_capabilities" text[] NOT NULL,
	"after_capabilities" text[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "design_permission_migration_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.design_permission_migration_log FROM public, anon, authenticated;
--> statement-breakpoint
CREATE INDEX "design_permission_migration_log_tenant_idx" ON "design_permission_migration_log" USING btree ("tenant_id");
--> statement-breakpoint
CREATE FUNCTION public.design_permission_migration_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'design_permission_migration_log is append-only' USING ERRCODE = '42501';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER design_permission_migration_log_append_only
  BEFORE UPDATE OR DELETE ON public.design_permission_migration_log
  FOR EACH ROW EXECUTE FUNCTION public.design_permission_migration_log_append_only();
--> statement-breakpoint

-- Mapping (applied only to non-owner memberships that have no `design` key yet, so a second run finds nothing to do
-- and can never overwrite a level the Owner chose afterwards):
--   settings write -> design publish   (nobody who could publish a design loses it)
--   settings read  -> design read      (keeps today's read access; settings never granted more)
--   settings none / missing -> design none
-- capability 'attest' is added ONLY to members whose permission set equals the Manager preset: products, customers
-- and settings write, orders read or write (orders is read-only in the product, the 0018 backfill stored write).
-- 'discard' is never granted by the conversion. Owners are implicit and are reported unchanged.
-- Returns one row per membership: what it was and what it is now, and whether this run changed it.
CREATE FUNCTION public.migrate_design_permissions()
RETURNS TABLE (
  membership_id uuid, tenant_id uuid, user_id uuid, role text,
  before_permissions jsonb, after_permissions jsonb,
  before_capabilities text[], after_capabilities text[],
  changed boolean
)
LANGUAGE plpgsql
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  r record;
  v_level text;
  v_perms jsonb;
  v_caps text[];
  v_run timestamptz := clock_timestamp();
BEGIN
  FOR r IN
    SELECT m.id, m.tenant_id, m.user_id, m.role, m.permissions, m.capabilities
    FROM public.memberships m
    ORDER BY m.tenant_id, m.created_at, m.id
    FOR UPDATE OF m
  LOOP
    v_perms := r.permissions;
    v_caps := r.capabilities;
    IF r.role <> 'owner' AND NOT (r.permissions ? 'design') THEN
      v_level := CASE r.permissions ->> 'settings' WHEN 'write' THEN 'publish' WHEN 'read' THEN 'read' ELSE 'none' END;
      v_perms := r.permissions || jsonb_build_object('design', v_level);
      IF r.permissions ->> 'products' = 'write'
         AND r.permissions ->> 'customers' = 'write'
         AND r.permissions ->> 'settings' = 'write'
         AND r.permissions ->> 'orders' IN ('read', 'write')
         AND NOT ('attest' = ANY (r.capabilities)) THEN
        v_caps := array_append(r.capabilities, 'attest');
      END IF;
      UPDATE public.memberships m SET permissions = v_perms, capabilities = v_caps WHERE m.id = r.id;
      INSERT INTO public.design_permission_migration_log
        (run_at, membership_id, tenant_id, user_id, before_permissions, after_permissions, before_capabilities, after_capabilities)
      VALUES (v_run, r.id, r.tenant_id, r.user_id, r.permissions, v_perms, r.capabilities, v_caps);
    END IF;
    membership_id := r.id; tenant_id := r.tenant_id; user_id := r.user_id; role := r.role;
    before_permissions := r.permissions; after_permissions := v_perms;
    before_capabilities := r.capabilities; after_capabilities := v_caps;
    changed := (v_perms IS DISTINCT FROM r.permissions OR v_caps IS DISTINCT FROM r.capabilities);
    RETURN NEXT;
  END LOOP;
END;
$$;
--> statement-breakpoint
-- Maintenance function: owner connection only. The app roles can neither call it nor read its log.
REVOKE ALL ON FUNCTION public.migrate_design_permissions() FROM public, anon, authenticated;
--> statement-breakpoint

-- Convert the members that exist now (the same migration transaction; the result is kept in the log table).
SELECT count(*) FROM public.migrate_design_permissions();
