-- Custom migration: the Theme Store.
--
-- The template engine (0010-0016) already stores drafts, immutable published versions and rollbacks per store.
-- This migration adds only what a theme store needs on top of it:
--   * themes        - the GLOBAL catalogue. One row per theme, shared by every tenant, read-only for the app.
--   * store_themes  - which theme a store applied (and which catalogue version it started from).
-- Applying a theme copies the theme's documents into the store's own `templates` drafts, so tenants never share
-- mutable rows and commerce data is never touched. The catalogue rows are written by `npm run db:seed:themes`
-- (privileged connection), never by the API.

CREATE TABLE "themes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"industry" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"preview_image" text,
	"status" text DEFAULT 'published' NOT NULL,
	-- { "<template kind>": <template document> }: index, product, collection, theme_settings, group_header, group_footer, group_announcement
	"documents" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "themes_slug_key" UNIQUE("slug"),
	CONSTRAINT "themes_slug_check" CHECK ("slug" ~ '^[a-z][a-z0-9-]{1,39}$'),
	CONSTRAINT "themes_name_check" CHECK (char_length(btrim("name")) between 1 and 60),
	CONSTRAINT "themes_description_check" CHECK (char_length("description") <= 500),
	CONSTRAINT "themes_industry_check" CHECK ("industry" in ('fashion', 'electronics', 'beauty', 'home', 'grocery', 'general')),
	CONSTRAINT "themes_version_check" CHECK ("version" >= 1),
	CONSTRAINT "themes_preview_image_check" CHECK ("preview_image" is null or char_length("preview_image") <= 500),
	CONSTRAINT "themes_status_check" CHECK ("status" in ('draft', 'published', 'archived')),
	CONSTRAINT "themes_documents_check" CHECK (jsonb_typeof("documents") = 'object' and octet_length("documents"::text) <= 1048576)
);
--> statement-breakpoint
ALTER TABLE "themes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "themes_status_industry_idx" ON "themes" USING btree ("status", "industry");--> statement-breakpoint

CREATE TABLE "store_themes" (
	"store_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"theme_id" uuid NOT NULL,
	"theme_version" integer NOT NULL,
	"applied_by" uuid,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_themes_theme_version_check" CHECK ("theme_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "store_themes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "store_themes" ADD CONSTRAINT "store_themes_store_fk" FOREIGN KEY ("tenant_id","store_id") REFERENCES "public"."stores"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_themes" ADD CONSTRAINT "store_themes_theme_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_themes" ADD CONSTRAINT "store_themes_applied_by_users_id_fk" FOREIGN KEY ("applied_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "store_themes_tenant_idx" ON "store_themes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "store_themes_theme_idx" ON "store_themes" USING btree ("theme_id");--> statement-breakpoint

-- Privileges: deny by default (see 0002 / 0006).
REVOKE ALL ON public.themes, public.store_themes FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON public.themes TO authenticated;
--> statement-breakpoint
GRANT SELECT ON public.store_themes TO authenticated;
--> statement-breakpoint
-- applied_by / applied_at / updated_at are set by the trigger below, never by the client.
GRANT INSERT (tenant_id, store_id, theme_id, theme_version) ON public.store_themes TO authenticated;
--> statement-breakpoint
GRANT UPDATE (theme_id, theme_version) ON public.store_themes TO authenticated;
--> statement-breakpoint

-- The catalogue is global: any signed-in user may read everything that is not a draft (archived themes stay
-- readable so a store that applied one can still show it). The app role has no write access at all.
CREATE POLICY themes_select_visible ON public.themes
  FOR SELECT TO authenticated
  USING (status <> 'draft');
--> statement-breakpoint

CREATE POLICY store_themes_select_members ON public.store_themes
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint
CREATE POLICY store_themes_insert_admins ON public.store_themes
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_tenant_role(tenant_id, array['owner', 'admin'])
    AND EXISTS (SELECT 1 FROM public.stores s WHERE s.id = store_themes.store_id AND s.tenant_id = store_themes.tenant_id)
  );
--> statement-breakpoint
CREATE POLICY store_themes_update_admins ON public.store_themes
  FOR UPDATE TO authenticated
  USING (public.has_tenant_role(tenant_id, array['owner', 'admin']))
  WITH CHECK (public.has_tenant_role(tenant_id, array['owner', 'admin']));
--> statement-breakpoint

-- Restrictive per-module gate (see 0018): a member needs write access to Store settings to change anything about
-- the storefront design. Reading stays open to every member (settings is never below read). The existing
-- role policies on the template tables are untouched; these are ANDed with them.
DO $perm$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['templates', 'template_versions', 'template_assignments', 'store_themes']
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (public.has_module_access(tenant_id, %L, ''write''))',
      tbl || '_perm_insert', tbl, 'settings');
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated USING (public.has_module_access(tenant_id, %L, ''write'')) WITH CHECK (public.has_module_access(tenant_id, %L, ''write''))',
      tbl || '_perm_update', tbl, 'settings', 'settings');
    IF tbl <> 'template_versions' THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated USING (public.has_module_access(tenant_id, %L, ''write''))',
        tbl || '_perm_delete', tbl, 'settings');
    END IF;
  END LOOP;
END
$perm$;
--> statement-breakpoint

CREATE FUNCTION public.store_themes_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.applied_by := auth.uid();
  NEW.applied_at := now();
  NEW.updated_at := now();
  -- Only a published theme, at its current version, can be applied.
  IF NOT EXISTS (SELECT 1 FROM public.themes t WHERE t.id = NEW.theme_id AND t.status = 'published' AND t.version = NEW.theme_version) THEN
    RAISE EXCEPTION 'THEME_NOT_AVAILABLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER store_themes_before_write
  BEFORE INSERT OR UPDATE ON public.store_themes
  FOR EACH ROW EXECUTE FUNCTION public.store_themes_before_write();
