-- Custom migration: Studio Release 4 (SEO foundations and Section-based Landing Pages).
--
-- Security model:
--  * Landing page templates follow the same design:write / design:publish policies as other templates.
--  * Slug uniqueness is enforced per store for active/draft pages (kind = 'page').
--  * SEO columns on products and collections are bounded in length.
--  * get_public_landing_page is SECURITY DEFINER with search_path = '' and projects only published pages.

-- 1. Extend templates kind check with 'page' ----------------------------------------------------------------------
ALTER TABLE "templates" DROP CONSTRAINT IF EXISTS "templates_kind_check";
--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_kind_check" CHECK (
  kind IN ('index', 'product', 'collection', 'theme_settings', 'group_header', 'group_footer', 'group_announcement', 'group_cart_drawer', 'page')
);
--> statement-breakpoint

-- 2. Add page_slug to templates -----------------------------------------------------------------------------------
ALTER TABLE "templates" ADD COLUMN IF NOT EXISTS "page_slug" text;
--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_page_slug_check" CHECK (
  "page_slug" IS NULL OR "page_slug" ~ '^[a-z0-9][a-z0-9-]{0,62}$'
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_store_page_slug" ON "templates" ("tenant_id", "store_id", "page_slug")
  WHERE ("kind" = 'page' AND "status" <> 'archived');
--> statement-breakpoint

-- 3. SEO columns on products --------------------------------------------------------------------------------------
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "seo_title" text;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "seo_description" text;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "social_image_path" text;
--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_seo_title_check" CHECK (
  "seo_title" IS NULL OR char_length("seo_title") <= 70
);
--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_seo_description_check" CHECK (
  "seo_description" IS NULL OR char_length("seo_description") <= 160
);
--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_social_image_check" CHECK (
  "social_image_path" IS NULL OR char_length("social_image_path") <= 500
);
--> statement-breakpoint

-- 4. SEO columns on collections -----------------------------------------------------------------------------------
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "seo_title" text;
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "seo_description" text;
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "social_image_path" text;
--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_seo_title_check" CHECK (
  "seo_title" IS NULL OR char_length("seo_title") <= 70
);
--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_seo_description_check" CHECK (
  "seo_description" IS NULL OR char_length("seo_description") <= 160
);
--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_social_image_check" CHECK (
  "social_image_path" IS NULL OR char_length("social_image_path") <= 500
);
--> statement-breakpoint

-- 5. Public Landing Page Resolver ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_public_landing_page(
  p_store_slug text,
  p_page_slug text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_store_id uuid;
  v_tenant_id uuid;
  v_template_id uuid;
  v_version_id uuid;
  v_doc jsonb;
BEGIN
  SELECT s.id, s.tenant_id INTO v_store_id, v_tenant_id
  FROM public.stores s
  WHERE s.slug = p_store_slug AND s.status = 'active';

  IF v_store_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT t.id, t.published_version_id INTO v_template_id, v_version_id
  FROM public.templates t
  WHERE t.tenant_id = v_tenant_id
    AND t.store_id = v_store_id
    AND t.kind = 'page'
    AND t.page_slug = p_page_slug
    AND t.status = 'active';

  IF v_template_id IS NULL OR v_version_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT tv.document INTO v_doc
  FROM public.template_versions tv
  WHERE tv.id = v_version_id AND tv.template_id = v_template_id;

  RETURN jsonb_build_object(
    'pageSlug', p_page_slug,
    'templateId', v_template_id,
    'versionId', v_version_id,
    'document', v_doc
  );
END;
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.get_public_landing_page(text, text) TO anon, authenticated;
