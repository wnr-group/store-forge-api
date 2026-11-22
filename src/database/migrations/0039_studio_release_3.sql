-- Custom migration: Studio Release 3 (Reusable Sections, Review Workflow, Change Ledger, Discard Audit).
--
-- Security model:
--  * Every tenant table carries tenant_id and composite foreign key (tenant_id, store_id) -> stores(tenant_id, id).
--  * RLS enabled with deny-by-default.
--  * draft_discard_audit is append-only (triggers reject UPDATE, DELETE, TRUNCATE for every role).
--  * Capability 'discard' required for discard operations.

-- 1. Reusable Sections -------------------------------------------------------------------------------------------
CREATE TABLE "reusable_sections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "store_id" uuid NOT NULL,
  "component_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "current_version_id" uuid,
  "status" text DEFAULT 'active' NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "reusable_sections_name_check" CHECK (char_length("name") between 1 and 100),
  CONSTRAINT "reusable_sections_status_check" CHECK ("status" IN ('active', 'archived')),
  CONSTRAINT "reusable_sections_store_fkey" FOREIGN KEY ("tenant_id", "store_id") REFERENCES "stores"("tenant_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE "reusable_sections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.reusable_sections FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reusable_sections TO authenticated;
--> statement-breakpoint

CREATE POLICY reusable_sections_select ON public.reusable_sections
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint

CREATE POLICY reusable_sections_write ON public.reusable_sections
  FOR ALL TO authenticated
  USING (public.has_module_access(tenant_id, 'design', 'write'))
  WITH CHECK (public.has_module_access(tenant_id, 'design', 'write'));
--> statement-breakpoint

-- 2. Reusable Section Versions (Immutable) -----------------------------------------------------------------------
CREATE TABLE "reusable_section_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "reusable_id" uuid NOT NULL REFERENCES "reusable_sections"("id") ON DELETE CASCADE,
  "version_number" integer NOT NULL,
  "content" jsonb NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "reusable_section_versions_version_check" CHECK ("version_number" >= 1),
  CONSTRAINT "reusable_section_versions_unique" UNIQUE ("reusable_id", "version_number")
);
--> statement-breakpoint
ALTER TABLE "reusable_section_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.reusable_section_versions FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.reusable_section_versions TO authenticated;
--> statement-breakpoint

CREATE POLICY reusable_section_versions_select ON public.reusable_section_versions
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.reusable_sections rs WHERE rs.id = reusable_section_versions.reusable_id AND public.is_tenant_member(rs.tenant_id)));
--> statement-breakpoint

CREATE POLICY reusable_section_versions_insert ON public.reusable_section_versions
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.reusable_sections rs WHERE rs.id = reusable_section_versions.reusable_id AND public.has_module_access(rs.tenant_id, 'design', 'write')));
--> statement-breakpoint

-- 3. Draft Review Requests (Exact Revision Review) ----------------------------------------------------------------
CREATE TABLE "draft_review_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "store_id" uuid NOT NULL,
  "fingerprint" text NOT NULL,
  "items" jsonb NOT NULL,
  "submitted_by" uuid NOT NULL,
  "submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cleared_at" timestamp with time zone,
  "cleared_reason" text,
  CONSTRAINT "draft_review_requests_fingerprint_check" CHECK (char_length("fingerprint") = 64),
  CONSTRAINT "draft_review_requests_store_fkey" FOREIGN KEY ("tenant_id", "store_id") REFERENCES "stores"("tenant_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE "draft_review_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.draft_review_requests FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.draft_review_requests TO authenticated;
--> statement-breakpoint

CREATE POLICY draft_review_requests_select ON public.draft_review_requests
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint

CREATE POLICY draft_review_requests_insert ON public.draft_review_requests
  FOR INSERT TO authenticated
  WITH CHECK (public.has_module_access(tenant_id, 'design', 'write'));
--> statement-breakpoint

CREATE POLICY draft_review_requests_update ON public.draft_review_requests
  FOR UPDATE TO authenticated
  USING (public.has_module_access(tenant_id, 'design', 'write'))
  WITH CHECK (public.has_module_access(tenant_id, 'design', 'write'));
--> statement-breakpoint

-- 4. Change Ledger (Autosave Batch Attribution) ------------------------------------------------------------------
CREATE TABLE "change_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "store_id" uuid NOT NULL,
  "editor_id" uuid NOT NULL,
  "document_type" text NOT NULL,
  "document_id" text NOT NULL,
  "node_id" text NOT NULL,
  "change_kind" text NOT NULL,
  "before_hash" text,
  "after_hash" text NOT NULL,
  "draft_revision" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  CONSTRAINT "change_ledger_doc_type_check" CHECK ("document_type" IN ('template', 'presentation', 'reusable_section')),
  CONSTRAINT "change_ledger_change_kind_check" CHECK ("change_kind" IN ('insert', 'update', 'delete', 'reorder', 'style', 'display')),
  CONSTRAINT "change_ledger_store_fkey" FOREIGN KEY ("tenant_id", "store_id") REFERENCES "stores"("tenant_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE "change_ledger" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.change_ledger FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.change_ledger TO authenticated;
--> statement-breakpoint

CREATE POLICY change_ledger_select ON public.change_ledger
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint

CREATE POLICY change_ledger_insert ON public.change_ledger
  FOR INSERT TO authenticated
  WITH CHECK (public.has_module_access(tenant_id, 'design', 'write'));
--> statement-breakpoint

CREATE POLICY change_ledger_update ON public.change_ledger
  FOR UPDATE TO authenticated
  USING (public.has_module_access(tenant_id, 'design', 'write'))
  WITH CHECK (public.has_module_access(tenant_id, 'design', 'write'));
--> statement-breakpoint

CREATE INDEX "change_ledger_node_idx" ON public.change_ledger ("tenant_id", "store_id", "document_type", "document_id", "node_id");
--> statement-breakpoint

-- 5. Draft Discard Audit (Append-only) ---------------------------------------------------------------------------
CREATE TABLE "draft_discard_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "store_id" uuid NOT NULL,
  "acting_user_id" uuid NOT NULL,
  "affected_user_id" uuid NOT NULL,
  "document_type" text NOT NULL,
  "document_id" text NOT NULL,
  "node_id" text NOT NULL,
  "discarded_revisions" integer[] NOT NULL,
  "reason" text NOT NULL,
  "before_hash" text,
  "after_hash" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "draft_discard_audit_store_fkey" FOREIGN KEY ("tenant_id", "store_id") REFERENCES "stores"("tenant_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE "draft_discard_audit" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.draft_discard_audit FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.draft_discard_audit TO authenticated;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.draft_discard_audit_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'discard_audit_immutable' USING errcode = '42501';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.draft_discard_audit_guard() FROM public, anon, authenticated;
--> statement-breakpoint

CREATE TRIGGER draft_discard_audit_no_change
  BEFORE UPDATE OR DELETE ON public.draft_discard_audit
  FOR EACH ROW EXECUTE FUNCTION public.draft_discard_audit_guard();
--> statement-breakpoint

CREATE TRIGGER draft_discard_audit_no_truncate
  BEFORE TRUNCATE ON public.draft_discard_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.studio_no_truncate();
--> statement-breakpoint

CREATE POLICY draft_discard_audit_select ON public.draft_discard_audit
  FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'design', 'read'));
--> statement-breakpoint

CREATE POLICY draft_discard_audit_insert ON public.draft_discard_audit
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.tenant_id = draft_discard_audit.tenant_id
        AND m.user_id = (SELECT auth.uid())
        AND m.status = 'active'
        AND ('discard' = ANY(m.capabilities) OR m.role = 'owner')
    )
  );
--> statement-breakpoint
