-- Custom migration: per-product presentation overrides (gallery layout, focal point, hidden blocks).
--
-- One row per customised product: a JSON `draft` (what the owner edits) and a JSON `published` document (what shoppers
-- see). A product without a row inherits the store's default theme and product page. Catalogue fields (name, price,
-- description, images) are never stored here. There is no version history: the row holds the draft and the live copy.
--
-- Same security model as the template engine (0012): deny-by-default, members of the tenant can read, only Owner and
-- Admin can write and only the columns granted below. Shoppers never touch this table; the public product function
-- (0033) reads `published` only. Privileges, RLS and triggers are hand-written; the CREATE TABLE mirrors the Drizzle model.

CREATE TABLE "product_presentations" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"draft" jsonb DEFAULT '{"schemaVersion": 1}'::jsonb NOT NULL,
	"published" jsonb,
	"revision" integer DEFAULT 1 NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_presentations_revision_check" CHECK ("revision" >= 1),
	CONSTRAINT "product_presentations_draft_check" CHECK (jsonb_typeof("draft") = 'object'
      and coalesce(jsonb_typeof("draft" -> 'schemaVersion') = 'number' and ("draft" ->> 'schemaVersion') ~ '^[1-9][0-9]*$', false)
      and octet_length("draft"::text) <= 8192),
	CONSTRAINT "product_presentations_published_check" CHECK ("published" is null or (jsonb_typeof("published") = 'object'
      and coalesce(jsonb_typeof("published" -> 'schemaVersion') = 'number' and ("published" ->> 'schemaVersion') ~ '^[1-9][0-9]*$', false)
      and octet_length("published"::text) <= 8192)),
	CONSTRAINT "product_presentations_published_pair_check" CHECK (("published" is null) = ("published_at" is null))
);
--> statement-breakpoint
ALTER TABLE "product_presentations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_presentations" ADD CONSTRAINT "product_presentations_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_presentations" ADD CONSTRAINT "product_presentations_store_fk" FOREIGN KEY ("tenant_id","store_id") REFERENCES "public"."stores"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_presentations" ADD CONSTRAINT "product_presentations_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_presentations_store_idx" ON "product_presentations" USING btree ("tenant_id","store_id");
--> statement-breakpoint

REVOKE ALL ON public.product_presentations FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON public.product_presentations TO authenticated;
--> statement-breakpoint
-- revision, published_at, published_by and timestamps are never client-written (triggers below).
GRANT INSERT (tenant_id, store_id, product_id, draft) ON public.product_presentations TO authenticated;
--> statement-breakpoint
GRANT UPDATE (draft, published) ON public.product_presentations TO authenticated;
--> statement-breakpoint
GRANT DELETE ON public.product_presentations TO authenticated;
--> statement-breakpoint

CREATE POLICY product_presentations_select_members ON public.product_presentations
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint
-- The EXISTS repeats the store foreign key as defence in depth: the store must belong to the same tenant.
CREATE POLICY product_presentations_insert_admins ON public.product_presentations
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_tenant_role(tenant_id, array['owner', 'admin'])
    AND EXISTS (SELECT 1 FROM public.stores s WHERE s.id = product_presentations.store_id AND s.tenant_id = product_presentations.tenant_id)
  );
--> statement-breakpoint
CREATE POLICY product_presentations_update_admins ON public.product_presentations
  FOR UPDATE TO authenticated
  USING (public.has_tenant_role(tenant_id, array['owner', 'admin']))
  WITH CHECK (public.has_tenant_role(tenant_id, array['owner', 'admin']));
--> statement-breakpoint
CREATE POLICY product_presentations_delete_admins ON public.product_presentations
  FOR DELETE TO authenticated
  USING (public.has_tenant_role(tenant_id, array['owner', 'admin']));
--> statement-breakpoint

-- updated_at always; revision +1 whenever the draft changes (optimistic concurrency, same rule as templates);
-- the publish stamp (time and acting user) whenever `published` changes, so the client cannot choose them.
CREATE FUNCTION public.product_presentations_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.draft IS DISTINCT FROM OLD.draft THEN
    NEW.revision := OLD.revision + 1;
  END IF;
  IF NEW.published IS DISTINCT FROM OLD.published THEN
    NEW.published_at := CASE WHEN NEW.published IS NULL THEN NULL ELSE now() END;
    NEW.published_by := CASE WHEN NEW.published IS NULL THEN NULL ELSE auth.uid() END;
  ELSE
    NEW.published_at := OLD.published_at;
    NEW.published_by := OLD.published_by;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER product_presentations_before_update
  BEFORE UPDATE ON public.product_presentations
  FOR EACH ROW EXECUTE FUNCTION public.product_presentations_before_update();
--> statement-breakpoint

-- A new row always starts at revision 1, unpublished, whatever the client sent.
CREATE FUNCTION public.product_presentations_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.revision := 1;
  NEW.published := NULL;
  NEW.published_at := NULL;
  NEW.published_by := NULL;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER product_presentations_before_insert
  BEFORE INSERT ON public.product_presentations
  FOR EACH ROW EXECUTE FUNCTION public.product_presentations_before_insert();
