-- Custom migration: store pages (About, Contact, Shipping policy...).
--
-- Content pages of a storefront, written by the merchant and shown at /<slug> on the store's own address. One row
-- belongs to one store of one tenant (composite foreign key), so a page can never point at another tenant's store.
-- Only `published` pages are visible to shoppers, through the two narrow SECURITY DEFINER functions below (same
-- pattern as get_public_storefront, 0009/0011). The body is plain text; the storefront renders it as text, never HTML.

CREATE TABLE "store_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_pages_store_slug_key" UNIQUE("store_id", "slug"),
	CONSTRAINT "store_pages_title_check" CHECK (char_length(btrim("title")) between 1 and 120),
	CONSTRAINT "store_pages_slug_check" CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
	-- Routes that already mean something on a store address; a page may not shadow them.
	CONSTRAINT "store_pages_slug_reserved_check" CHECK ("slug" not in ('products', 'collections', 'search', 'cart', 'checkout', 'login', 'dashboard', 'admin', 'api', 'pages', 's', 'no-workspace', 'account')),
	CONSTRAINT "store_pages_body_check" CHECK (char_length("body") <= 20000),
	CONSTRAINT "store_pages_status_check" CHECK ("status" in ('draft', 'published'))
);
--> statement-breakpoint
ALTER TABLE "store_pages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "store_pages" ADD CONSTRAINT "store_pages_store_fk" FOREIGN KEY ("tenant_id","store_id") REFERENCES "public"."stores"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "store_pages_tenant_store_idx" ON "store_pages" USING btree ("tenant_id", "store_id", "status");--> statement-breakpoint

REVOKE ALL ON public.store_pages FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, DELETE ON public.store_pages TO authenticated;
--> statement-breakpoint
GRANT INSERT (tenant_id, store_id, title, slug, body, status) ON public.store_pages TO authenticated;
--> statement-breakpoint
GRANT UPDATE (title, slug, body, status) ON public.store_pages TO authenticated;
--> statement-breakpoint

CREATE POLICY store_pages_select_members ON public.store_pages
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint
CREATE POLICY store_pages_insert_admins ON public.store_pages
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_tenant_role(tenant_id, array['owner', 'admin'])
    AND EXISTS (SELECT 1 FROM public.stores s WHERE s.id = store_pages.store_id AND s.tenant_id = store_pages.tenant_id)
  );
--> statement-breakpoint
CREATE POLICY store_pages_update_admins ON public.store_pages
  FOR UPDATE TO authenticated
  USING (public.has_tenant_role(tenant_id, array['owner', 'admin']))
  WITH CHECK (public.has_tenant_role(tenant_id, array['owner', 'admin']));
--> statement-breakpoint
CREATE POLICY store_pages_delete_admins ON public.store_pages
  FOR DELETE TO authenticated
  USING (public.has_tenant_role(tenant_id, array['owner', 'admin']));
--> statement-breakpoint

-- Same per-module gate as the other storefront design tables (0025): changing pages needs write access to Store settings.
CREATE POLICY store_pages_perm_insert ON public.store_pages AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.has_module_access(tenant_id, 'settings', 'write'));
--> statement-breakpoint
CREATE POLICY store_pages_perm_update ON public.store_pages AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.has_module_access(tenant_id, 'settings', 'write'))
  WITH CHECK (public.has_module_access(tenant_id, 'settings', 'write'));
--> statement-breakpoint
CREATE POLICY store_pages_perm_delete ON public.store_pages AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.has_module_access(tenant_id, 'settings', 'write'));
--> statement-breakpoint

CREATE TRIGGER store_pages_set_updated_at
  BEFORE UPDATE ON public.store_pages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Published pages of a store (title and address only), for menus and the sitemap. NULL for an unknown, inactive or
-- suspended store, exactly like the other public functions.
CREATE FUNCTION public.get_public_pages(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_store record;
BEGIN
  IF p_slug IS NULL OR NOT public.is_valid_store_slug(p_slug) THEN
    RETURN NULL;
  END IF;

  SELECT s.id, s.tenant_id INTO v_store
  FROM public.stores s
  JOIN public.tenants t ON t.id = s.tenant_id
  WHERE s.slug = p_slug AND s.status = 'active' AND t.status = 'active';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('title', x.title, 'slug', x.slug) ORDER BY x.title, x.slug)
    FROM (
      SELECT g.title, g.slug
      FROM public.store_pages g
      WHERE g.tenant_id = v_store.tenant_id AND g.store_id = v_store.id AND g.status = 'published'
      ORDER BY g.title, g.slug
      LIMIT 100
    ) x
  ), '[]'::jsonb);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_public_pages(text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_public_pages(text) TO authenticated;
--> statement-breakpoint

-- One published page with the public store details. NULL when the store or the page is not available.
CREATE FUNCTION public.get_public_page(p_slug text, p_page_slug text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_store record;
  v_page record;
BEGIN
  IF p_slug IS NULL OR NOT public.is_valid_store_slug(p_slug) OR p_page_slug IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT s.id, s.tenant_id, s.name, s.slug, s.description, s.logo_url, s.currency INTO v_store
  FROM public.stores s
  JOIN public.tenants t ON t.id = s.tenant_id
  WHERE s.slug = p_slug AND s.status = 'active' AND t.status = 'active';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT g.title, g.slug, g.body, g.updated_at INTO v_page
  FROM public.store_pages g
  WHERE g.tenant_id = v_store.tenant_id AND g.store_id = v_store.id AND g.slug = p_page_slug AND g.status = 'published';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'store', jsonb_build_object(
      'name', v_store.name, 'slug', v_store.slug, 'description', v_store.description,
      'logo_path', v_store.logo_url, 'currency', v_store.currency
    ),
    'page', jsonb_build_object('title', v_page.title, 'slug', v_page.slug, 'body', v_page.body, 'updated_at', v_page.updated_at)
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_public_page(text, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_public_page(text, text) TO authenticated;
