CREATE TABLE "template_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"template_kind" text NOT NULL,
	"product_id" uuid,
	"collection_id" uuid,
	"resource_type" text GENERATED ALWAYS AS (case when product_id is not null then 'product' else 'collection' end) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_assignments_store_product_key" UNIQUE("store_id","product_id"),
	CONSTRAINT "template_assignments_store_collection_key" UNIQUE("store_id","collection_id"),
	CONSTRAINT "template_assignments_one_resource_check" CHECK (num_nonnulls("template_assignments"."product_id", "template_assignments"."collection_id") = 1),
	CONSTRAINT "template_assignments_kind_matches_resource_check" CHECK ("template_assignments"."template_kind" = case when "template_assignments"."product_id" is not null then 'product' else 'collection' end)
);
--> statement-breakpoint
ALTER TABLE "template_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"document" jsonb NOT NULL,
	"source" text NOT NULL,
	"rolled_back_from" uuid,
	"published_by" uuid,
	"label" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_versions_template_id_id_key" UNIQUE("template_id","id"),
	CONSTRAINT "template_versions_template_id_version_number_key" UNIQUE("template_id","version_number"),
	CONSTRAINT "template_versions_version_number_check" CHECK ("template_versions"."version_number" >= 1),
	CONSTRAINT "template_versions_source_check" CHECK ("template_versions"."source" in ('publish', 'rollback', 'migration')),
	CONSTRAINT "template_versions_rollback_source_check" CHECK (("template_versions"."source" = 'rollback') = ("template_versions"."rolled_back_from" is not null)),
	CONSTRAINT "template_versions_label_check" CHECK ("template_versions"."label" is null or char_length("template_versions"."label") <= 80),
	CONSTRAINT "template_versions_document_check" CHECK (jsonb_typeof("template_versions"."document") = 'object'
      and coalesce(jsonb_typeof("template_versions"."document" -> 'schemaVersion') = 'number' and ("template_versions"."document" ->> 'schemaVersion') ~ '^[1-9][0-9]*$', false)
      and octet_length("template_versions"."document"::text) <= 262144)
);
--> statement-breakpoint
ALTER TABLE "template_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"draft" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"published_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_tenant_store_id_key" UNIQUE("tenant_id","store_id","id"),
	CONSTRAINT "templates_tenant_store_id_kind_key" UNIQUE("tenant_id","store_id","id","kind"),
	CONSTRAINT "templates_kind_check" CHECK ("templates"."kind" in ('index', 'product', 'collection', 'theme_settings', 'group_header', 'group_footer', 'group_announcement')),
	CONSTRAINT "templates_status_check" CHECK ("templates"."status" in ('active', 'archived')),
	CONSTRAINT "templates_name_check" CHECK (char_length(btrim("templates"."name")) between 1 and 80),
	CONSTRAINT "templates_revision_check" CHECK ("templates"."revision" >= 1),
	CONSTRAINT "templates_default_kind_check" CHECK (not "templates"."is_default" or "templates"."kind" in ('index', 'product', 'collection')),
	CONSTRAINT "templates_default_active_check" CHECK (not "templates"."is_default" or "templates"."status" = 'active'),
	CONSTRAINT "templates_draft_check" CHECK (jsonb_typeof("templates"."draft") = 'object'
      and coalesce(jsonb_typeof("templates"."draft" -> 'schemaVersion') = 'number' and ("templates"."draft" ->> 'schemaVersion') ~ '^[1-9][0-9]*$', false)
      and octet_length("templates"."draft"::text) <= 262144)
);
--> statement-breakpoint
ALTER TABLE "templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "template_assignments" ADD CONSTRAINT "template_assignments_store_fk" FOREIGN KEY ("tenant_id","store_id") REFERENCES "public"."stores"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_assignments" ADD CONSTRAINT "template_assignments_template_fk" FOREIGN KEY ("tenant_id","store_id","template_id","template_kind") REFERENCES "public"."templates"("tenant_id","store_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_assignments" ADD CONSTRAINT "template_assignments_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_assignments" ADD CONSTRAINT "template_assignments_collection_fk" FOREIGN KEY ("tenant_id","collection_id") REFERENCES "public"."collections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_template_fk" FOREIGN KEY ("tenant_id","store_id","template_id") REFERENCES "public"."templates"("tenant_id","store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_rolled_back_from_fk" FOREIGN KEY ("template_id","rolled_back_from") REFERENCES "public"."template_versions"("template_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_store_fk" FOREIGN KEY ("tenant_id","store_id") REFERENCES "public"."stores"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_published_version_fk" FOREIGN KEY ("id","published_version_id") REFERENCES "public"."template_versions"("template_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "template_assignments_template_idx" ON "template_assignments" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "template_versions_template_idx" ON "template_versions" USING btree ("template_id","version_number" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "templates_one_default_idx" ON "templates" USING btree ("store_id","kind") WHERE "templates"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "templates_one_shared_idx" ON "templates" USING btree ("store_id","kind") WHERE "templates"."kind" in ('theme_settings', 'group_header', 'group_footer', 'group_announcement');--> statement-breakpoint
CREATE INDEX "templates_store_kind_status_idx" ON "templates" USING btree ("tenant_id","store_id","kind","status");
--> statement-breakpoint

-- Hand-written part of 0012 (the statements above are generated): privileges, RLS, triggers, status function.
--
-- Everything is deny-by-default (see 0002 / 0006): anonymous visitors get no table access and read published
-- templates only through the public functions in 0014. Members of the tenant can read (Staff included, D15);
-- only Owner and Manager (store:manage) can write, and only the columns granted below. The app role is a member
-- of `authenticated` only, so these grants are its grants.

REVOKE ALL ON public.templates, public.template_versions, public.template_assignments FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON public.templates, public.template_versions, public.template_assignments TO authenticated;
--> statement-breakpoint
-- kind, revision, published history and timestamps are never client-written. `revision` is bumped by the trigger below.
GRANT INSERT (tenant_id, store_id, kind, name, is_default, draft) ON public.templates TO authenticated;
--> statement-breakpoint
GRANT UPDATE (name, status, is_default, draft, published_version_id) ON public.templates TO authenticated;
--> statement-breakpoint
GRANT DELETE ON public.templates TO authenticated;
--> statement-breakpoint
-- Immutable history (D3, D16): INSERT only. version_number and published_by are set by the trigger below. No UPDATE, no DELETE.
GRANT INSERT (tenant_id, store_id, template_id, document, source, rolled_back_from, label) ON public.template_versions TO authenticated;
--> statement-breakpoint
-- template_kind is copied from the template by the trigger below, never supplied.
GRANT INSERT (tenant_id, store_id, template_id, product_id, collection_id) ON public.template_assignments TO authenticated;
--> statement-breakpoint
GRANT UPDATE (template_id) ON public.template_assignments TO authenticated;
--> statement-breakpoint
GRANT DELETE ON public.template_assignments TO authenticated;
--> statement-breakpoint

CREATE POLICY templates_select_members ON public.templates
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint
-- The EXISTS repeats the composite foreign key as defence in depth: the store must belong to the same tenant.
CREATE POLICY templates_insert_admins ON public.templates
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_tenant_role(tenant_id, array['owner', 'admin'])
    AND EXISTS (SELECT 1 FROM public.stores s WHERE s.id = templates.store_id AND s.tenant_id = templates.tenant_id)
  );
--> statement-breakpoint
CREATE POLICY templates_update_admins ON public.templates
  FOR UPDATE TO authenticated
  USING (public.has_tenant_role(tenant_id, array['owner', 'admin']))
  WITH CHECK (public.has_tenant_role(tenant_id, array['owner', 'admin']));
--> statement-breakpoint
-- A template that was ever published keeps its history: archive it instead (D16). Assignments also block deletion (FK).
CREATE POLICY templates_delete_never_published ON public.templates
  FOR DELETE TO authenticated
  USING (
    public.has_tenant_role(tenant_id, array['owner', 'admin'])
    AND NOT EXISTS (SELECT 1 FROM public.template_versions v WHERE v.template_id = templates.id)
  );
--> statement-breakpoint

CREATE POLICY template_versions_select_members ON public.template_versions
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint
CREATE POLICY template_versions_insert_admins ON public.template_versions
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_tenant_role(tenant_id, array['owner', 'admin'])
    AND EXISTS (
      SELECT 1 FROM public.templates t
      WHERE t.id = template_versions.template_id AND t.tenant_id = template_versions.tenant_id AND t.store_id = template_versions.store_id
    )
  );
--> statement-breakpoint

CREATE POLICY template_assignments_select_members ON public.template_assignments
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint
CREATE POLICY template_assignments_insert_admins ON public.template_assignments
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_tenant_role(tenant_id, array['owner', 'admin'])
    AND EXISTS (SELECT 1 FROM public.stores s WHERE s.id = template_assignments.store_id AND s.tenant_id = template_assignments.tenant_id)
  );
--> statement-breakpoint
CREATE POLICY template_assignments_update_admins ON public.template_assignments
  FOR UPDATE TO authenticated
  USING (public.has_tenant_role(tenant_id, array['owner', 'admin']))
  WITH CHECK (public.has_tenant_role(tenant_id, array['owner', 'admin']));
--> statement-breakpoint
CREATE POLICY template_assignments_delete_admins ON public.template_assignments
  FOR DELETE TO authenticated
  USING (public.has_tenant_role(tenant_id, array['owner', 'admin']));
--> statement-breakpoint

-- templates: updated_at always; revision +1 whenever the draft changes (optimistic concurrency, D3/D14).
CREATE FUNCTION public.templates_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.draft IS DISTINCT FROM OLD.draft THEN
    NEW.revision := OLD.revision + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER templates_before_update
  BEFORE UPDATE ON public.templates
  FOR EACH ROW EXECUTE FUNCTION public.templates_before_update();
--> statement-breakpoint

-- template_versions: strictly increasing version numbers (locking the template row serializes concurrent
-- publishes, D16) and the acting user, which the client cannot choose. The migration runs without a user, so it stays NULL.
CREATE FUNCTION public.template_versions_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public.templates t WHERE t.id = NEW.template_id FOR UPDATE;
  NEW.version_number := (SELECT coalesce(max(v.version_number), 0) + 1 FROM public.template_versions v WHERE v.template_id = NEW.template_id);
  NEW.published_by := auth.uid();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER template_versions_before_insert
  BEFORE INSERT ON public.template_versions
  FOR EACH ROW EXECUTE FUNCTION public.template_versions_before_insert();
--> statement-breakpoint

-- template_assignments: copy the kind of the chosen template (the composite FK then rejects a template that is not
-- in this store, and the kind CHECK rejects a product template on a collection), and keep updated_at.
CREATE FUNCTION public.template_assignments_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.template_kind := (
    SELECT t.kind FROM public.templates t
    WHERE t.id = NEW.template_id AND t.tenant_id = NEW.tenant_id AND t.store_id = NEW.store_id
  );
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER template_assignments_before_write
  BEFORE INSERT OR UPDATE ON public.template_assignments
  FOR EACH ROW EXECUTE FUNCTION public.template_assignments_before_write();
--> statement-breakpoint

-- Derived publication state (D3, D16): 'archived', 'draft' (never published or unpublished),
-- 'published' (draft equals the published document) or 'published_with_changes'. Runs as the caller, so RLS applies.
CREATE FUNCTION public.template_publication_state(p_template_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN t.status = 'archived' THEN 'archived'
    WHEN t.published_version_id IS NULL THEN 'draft'
    WHEN t.draft = v.document THEN 'published'
    ELSE 'published_with_changes'
  END
  FROM public.templates t
  LEFT JOIN public.template_versions v ON v.id = t.published_version_id AND v.template_id = t.id
  WHERE t.id = p_template_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.template_publication_state(uuid) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.template_publication_state(uuid) TO authenticated;
