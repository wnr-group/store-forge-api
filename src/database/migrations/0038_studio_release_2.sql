-- Custom migration: Studio Release 2 (Reviews, Recommendations, Cart Drawer Slot, Web Vitals, Studio Settings).
--
-- Security model:
--  * Every tenant table carries tenant_id and composite foreign key (tenant_id, store_id) -> stores(tenant_id, id).
--  * RLS enabled with deny-by-default.
--  * Policies enforce products module for reviews/recommendations, and design module for studio settings.
--  * verified_purchase is constrained to false in Release 2 (AC-REV-10).

-- 1. Extend templates kind check with group_cart_drawer -----------------------------------------------------------
ALTER TABLE "templates" DROP CONSTRAINT IF EXISTS "templates_kind_check";
--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_kind_check" CHECK (
  kind IN ('index', 'product', 'collection', 'theme_settings', 'group_header', 'group_footer', 'group_announcement', 'group_cart_drawer')
);
--> statement-breakpoint

-- 2. Store Studio Settings ---------------------------------------------------------------------------------------
CREATE TABLE "store_studio_settings" (
  "store_id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "review_disclosure_text" text DEFAULT 'Feedback collected by the store.' NOT NULL,
  "review_disclosure_language" text DEFAULT 'en' NOT NULL,
  "updated_by" uuid NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "store_studio_settings_disclosure_text_check" CHECK (char_length("review_disclosure_text") between 1 and 500),
  CONSTRAINT "store_studio_settings_lang_check" CHECK ("review_disclosure_language" ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  CONSTRAINT "store_studio_settings_store_fkey" FOREIGN KEY ("tenant_id", "store_id") REFERENCES "stores"("tenant_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE "store_studio_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.store_studio_settings FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.store_studio_settings TO authenticated;
--> statement-breakpoint

CREATE POLICY store_studio_settings_select ON public.store_studio_settings
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint

CREATE POLICY store_studio_settings_write ON public.store_studio_settings
  FOR ALL TO authenticated
  USING (public.has_module_access(tenant_id, 'design', 'write'))
  WITH CHECK (public.has_module_access(tenant_id, 'design', 'write'));
--> statement-breakpoint

-- 3. Product Reviews ---------------------------------------------------------------------------------------------
CREATE TABLE "product_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "store_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "author_name" text NOT NULL,
  "rating" integer NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "status" text DEFAULT 'published' NOT NULL,
  "source" text DEFAULT 'merchant_entered' NOT NULL,
  "origin_label" text,
  "verified_purchase" boolean DEFAULT false NOT NULL,
  "import_id" uuid,
  "created_by" uuid NOT NULL,
  "updated_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "product_reviews_author_name_check" CHECK (char_length("author_name") between 1 and 80),
  CONSTRAINT "product_reviews_rating_check" CHECK ("rating" between 1 and 5),
  CONSTRAINT "product_reviews_title_check" CHECK (char_length("title") between 1 and 120),
  CONSTRAINT "product_reviews_body_check" CHECK (char_length("body") between 1 and 5000),
  CONSTRAINT "product_reviews_status_check" CHECK ("status" IN ('published', 'unpublished')),
  CONSTRAINT "product_reviews_source_check" CHECK ("source" IN ('merchant_entered', 'imported')),
  CONSTRAINT "product_reviews_origin_label_check" CHECK ("origin_label" IS NULL OR char_length("origin_label") <= 60),
  CONSTRAINT "product_reviews_verified_purchase_check" CHECK ("verified_purchase" = false),
  CONSTRAINT "product_reviews_store_fkey" FOREIGN KEY ("tenant_id", "store_id") REFERENCES "stores"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "product_reviews_product_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE "product_reviews" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.product_reviews FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_reviews TO authenticated;
--> statement-breakpoint

CREATE POLICY product_reviews_member_select ON public.product_reviews
  FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'products', 'read'));
--> statement-breakpoint

CREATE POLICY product_reviews_member_insert ON public.product_reviews
  FOR INSERT TO authenticated
  WITH CHECK (public.has_module_access(tenant_id, 'products', 'write'));
--> statement-breakpoint

CREATE POLICY product_reviews_member_update ON public.product_reviews
  FOR UPDATE TO authenticated
  USING (public.has_module_access(tenant_id, 'products', 'write'))
  WITH CHECK (public.has_module_access(tenant_id, 'products', 'write'));
--> statement-breakpoint

CREATE POLICY product_reviews_member_delete ON public.product_reviews
  FOR DELETE TO authenticated
  USING (public.has_module_access(tenant_id, 'products', 'write'));
--> statement-breakpoint

CREATE INDEX "product_reviews_product_status_idx" ON public.product_reviews ("tenant_id", "product_id", "status", "reviewed_at" DESC);
--> statement-breakpoint
CREATE INDEX "product_reviews_store_idx" ON public.product_reviews ("tenant_id", "store_id", "reviewed_at" DESC);
--> statement-breakpoint

-- 4. Review Imports ----------------------------------------------------------------------------------------------
CREATE TABLE "review_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "store_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "file_name" text NOT NULL,
  "rows_total" integer NOT NULL,
  "rows_imported" integer NOT NULL,
  "status" text NOT NULL,
  "attestation_id" uuid NOT NULL REFERENCES "attestations"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "review_imports_status_check" CHECK ("status" IN ('success', 'partial', 'failed')),
  CONSTRAINT "review_imports_store_fkey" FOREIGN KEY ("tenant_id", "store_id") REFERENCES "stores"("tenant_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE "review_imports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.review_imports FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.review_imports TO authenticated;
--> statement-breakpoint

CREATE POLICY review_imports_select ON public.review_imports
  FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'products', 'read'));
--> statement-breakpoint

CREATE POLICY review_imports_insert ON public.review_imports
  FOR INSERT TO authenticated
  WITH CHECK (public.has_module_access(tenant_id, 'products', 'write'));
--> statement-breakpoint

-- 5. Product Recommendations (Merchant-picked) -------------------------------------------------------------------
CREATE TABLE "product_recommendations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "store_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "recommended_product_id" uuid NOT NULL,
  "relation_kind" text DEFAULT 'cross_sell' NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "product_recommendations_relation_kind_check" CHECK ("relation_kind" IN ('cross_sell', 'upsell', 'related')),
  CONSTRAINT "product_recommendations_not_self_check" CHECK ("product_id" <> "recommended_product_id"),
  CONSTRAINT "product_recommendations_unique" UNIQUE ("tenant_id", "product_id", "recommended_product_id"),
  CONSTRAINT "product_recommendations_store_fkey" FOREIGN KEY ("tenant_id", "store_id") REFERENCES "stores"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "product_recommendations_product_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "product_recommendations_rec_product_fkey" FOREIGN KEY ("tenant_id", "recommended_product_id") REFERENCES "products"("tenant_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE "product_recommendations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.product_recommendations FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_recommendations TO authenticated;
--> statement-breakpoint

CREATE POLICY product_recommendations_select ON public.product_recommendations
  FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'products', 'read'));
--> statement-breakpoint

CREATE POLICY product_recommendations_write ON public.product_recommendations
  FOR ALL TO authenticated
  USING (public.has_module_access(tenant_id, 'products', 'write'))
  WITH CHECK (public.has_module_access(tenant_id, 'products', 'write'));
--> statement-breakpoint

CREATE INDEX "product_recommendations_idx" ON public.product_recommendations ("tenant_id", "product_id", "position" ASC);
--> statement-breakpoint

-- 6. Web Vitals Daily Aggregates ---------------------------------------------------------------------------------
CREATE TABLE "web_vitals_daily" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL,
  "publish_id" uuid,
  "route_kind" text NOT NULL,
  "device_class" text NOT NULL,
  "metric" text NOT NULL,
  "day" date DEFAULT CURRENT_DATE NOT NULL,
  "bucket_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "sample_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "web_vitals_daily_route_kind_check" CHECK ("route_kind" IN ('home', 'product', 'collection', 'cart', 'content', 'landing')),
  CONSTRAINT "web_vitals_daily_device_class_check" CHECK ("device_class" IN ('mobile', 'tablet', 'desktop')),
  CONSTRAINT "web_vitals_daily_metric_check" CHECK ("metric" IN ('LCP', 'CLS', 'INP', 'FCP', 'TTFB')),
  CONSTRAINT "web_vitals_daily_unique" UNIQUE ("store_id", "publish_id", "route_kind", "device_class", "metric", "day")
);
--> statement-breakpoint
ALTER TABLE "web_vitals_daily" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.web_vitals_daily FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON public.web_vitals_daily TO authenticated;
--> statement-breakpoint

CREATE POLICY web_vitals_daily_select ON public.web_vitals_daily
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.stores s WHERE s.id = "web_vitals_daily"."store_id" AND public.is_tenant_member(s.tenant_id)));
--> statement-breakpoint

-- 7. Public functions for Storefront -----------------------------------------------------------------------------
-- Anonymous read function for published reviews (no personal data, only published status)
CREATE OR REPLACE FUNCTION public.get_public_product_reviews(
  p_store_slug text,
  p_product_slug text,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
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
  v_product_id uuid;
  v_disclosure text;
  v_lang text;
  v_total integer;
  v_avg_rating numeric(3, 2);
  v_reviews jsonb;
BEGIN
  SELECT s.id, s.tenant_id INTO v_store_id, v_tenant_id
  FROM public.stores s
  WHERE s.slug = p_store_slug AND s.status = 'active';

  IF v_store_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.id INTO v_product_id
  FROM public.products p
  WHERE p.tenant_id = v_tenant_id AND p.slug = p_product_slug AND p.status = 'active';

  IF v_product_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(ss.review_disclosure_text, 'Feedback collected by the store.'),
         COALESCE(ss.review_disclosure_language, 'en')
  INTO v_disclosure, v_lang
  FROM public.store_studio_settings ss
  WHERE ss.store_id = v_store_id;

  IF v_disclosure IS NULL THEN
    v_disclosure := 'Feedback collected by the store.';
    v_lang := 'en';
  END IF;

  SELECT COUNT(*), ROUND(AVG(pr.rating), 2)
  INTO v_total, v_avg_rating
  FROM public.product_reviews pr
  WHERE pr.tenant_id = v_tenant_id AND pr.product_id = v_product_id AND pr.status = 'published';

  SELECT jsonb_agg(
    jsonb_build_object(
      'id', pr.id,
      'authorName', pr.author_name,
      'rating', pr.rating,
      'title', pr.title,
      'body', pr.body,
      'reviewedAt', pr.reviewed_at,
      'source', pr.source,
      'originLabel', pr.origin_label,
      'verifiedPurchase', false
    )
  ) INTO v_reviews
  FROM (
    SELECT *
    FROM public.product_reviews
    WHERE tenant_id = v_tenant_id AND product_id = v_product_id AND status = 'published'
    ORDER BY reviewed_at DESC
    LIMIT LEAST(GREATEST(p_limit, 1), 50)
    OFFSET GREATEST(p_offset, 0)
  ) pr;

  RETURN jsonb_build_object(
    'disclosure', v_disclosure,
    'language', v_lang,
    'total', COALESCE(v_total, 0),
    'averageRating', COALESCE(v_avg_rating, 0),
    'reviews', COALESCE(v_reviews, '[]'::jsonb)
  );
END;
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.get_public_product_reviews(text, text, integer, integer) TO anon, authenticated;
