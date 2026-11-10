CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "categories_tenant_id_slug_key" UNIQUE("tenant_id","slug"),
	CONSTRAINT "categories_name_check" CHECK (char_length(btrim("categories"."name")) between 1 and 80),
	CONSTRAINT "categories_slug_check" CHECK (char_length("categories"."slug") between 2 and 80 and "categories"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "categories_description_check" CHECK ("categories"."description" is null or char_length("categories"."description") <= 1000),
	CONSTRAINT "categories_parent_check" CHECK ("categories"."parent_id" is null or "categories"."parent_id" <> "categories"."id")
);
--> statement-breakpoint
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "collection_products" (
	"tenant_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_products_pkey" PRIMARY KEY("collection_id","product_id")
);
--> statement-breakpoint
ALTER TABLE "collection_products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"image_path" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collections_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "collections_tenant_id_slug_key" UNIQUE("tenant_id","slug"),
	CONSTRAINT "collections_name_check" CHECK (char_length(btrim("collections"."name")) between 1 and 80),
	CONSTRAINT "collections_slug_check" CHECK (char_length("collections"."slug") between 2 and 80 and "collections"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "collections_description_check" CHECK ("collections"."description" is null or char_length("collections"."description") <= 1000),
	CONSTRAINT "collections_status_check" CHECK ("collections"."status" in ('draft', 'active')),
	CONSTRAINT "collections_image_path_check" CHECK ("collections"."image_path" is null or "collections"."image_path" like "collections"."tenant_id"::text || '/collections/' || "collections"."id"::text || '/%')
);
--> statement-breakpoint
ALTER TABLE "collections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"delta" integer NOT NULL,
	"quantity_after" integer NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_adjustments_delta_check" CHECK ("inventory_adjustments"."delta" <> 0),
	CONSTRAINT "inventory_adjustments_quantity_after_check" CHECK ("inventory_adjustments"."quantity_after" >= 0),
	CONSTRAINT "inventory_adjustments_reason_check" CHECK ("inventory_adjustments"."reason" in ('restock', 'correction', 'return', 'damage', 'sale', 'other')),
	CONSTRAINT "inventory_adjustments_note_check" CHECK ("inventory_adjustments"."note" is null or char_length("inventory_adjustments"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "product_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"alt_text" text,
	"position" integer DEFAULT 0 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_images_storage_path_key" UNIQUE("storage_path"),
	CONSTRAINT "product_images_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "product_images_path_check" CHECK ("product_images"."storage_path" like "product_images"."tenant_id"::text || '/' || "product_images"."product_id"::text || '/%' and "product_images"."storage_path" !~ '\.\.'),
	CONSTRAINT "product_images_mime_check" CHECK ("product_images"."mime_type" in ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "product_images_size_check" CHECK ("product_images"."size_bytes" between 1 and 10485760),
	CONSTRAINT "product_images_alt_check" CHECK ("product_images"."alt_text" is null or char_length("product_images"."alt_text") <= 300)
);
--> statement-breakpoint
ALTER TABLE "product_images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "product_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"values" text[] NOT NULL,
	CONSTRAINT "product_options_product_id_name_key" UNIQUE("product_id","name"),
	CONSTRAINT "product_options_name_check" CHECK (char_length(btrim("product_options"."name")) between 1 and 40),
	CONSTRAINT "product_options_values_check" CHECK (cardinality("product_options"."values") between 1 and 50)
);
--> statement-breakpoint
ALTER TABLE "product_options" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"title" text NOT NULL,
	"options" jsonb NOT NULL,
	"sku" text,
	"price_minor" bigint DEFAULT 0 NOT NULL,
	"compare_at_price_minor" bigint,
	"quantity" integer DEFAULT 0 NOT NULL,
	"image_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_variants_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "product_variants_product_id_options_key" UNIQUE("product_id","options"),
	CONSTRAINT "product_variants_title_check" CHECK (char_length(btrim("product_variants"."title")) between 1 and 200),
	CONSTRAINT "product_variants_sku_check" CHECK ("product_variants"."sku" is null or char_length("product_variants"."sku") between 1 and 64),
	CONSTRAINT "product_variants_price_check" CHECK ("product_variants"."price_minor" between 0 and 100000000000),
	CONSTRAINT "product_variants_compare_at_check" CHECK ("product_variants"."compare_at_price_minor" is null or "product_variants"."compare_at_price_minor" between 0 and 100000000000),
	CONSTRAINT "product_variants_quantity_check" CHECK ("product_variants"."quantity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "product_variants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"category_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"short_description" text,
	"product_type" text,
	"sku" text,
	"price_minor" bigint DEFAULT 0 NOT NULL,
	"compare_at_price_minor" bigint,
	"cost_minor" bigint,
	"has_variants" boolean DEFAULT false NOT NULL,
	"track_inventory" boolean DEFAULT true NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"low_stock_threshold" integer DEFAULT 5 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "products_tenant_id_slug_key" UNIQUE("tenant_id","slug"),
	CONSTRAINT "products_name_check" CHECK (char_length(btrim("products"."name")) between 1 and 200),
	CONSTRAINT "products_slug_check" CHECK (char_length("products"."slug") between 2 and 80 and "products"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "products_description_check" CHECK ("products"."description" is null or char_length("products"."description") <= 20000),
	CONSTRAINT "products_short_description_check" CHECK ("products"."short_description" is null or char_length("products"."short_description") <= 300),
	CONSTRAINT "products_product_type_check" CHECK ("products"."product_type" is null or char_length("products"."product_type") <= 80),
	CONSTRAINT "products_sku_check" CHECK ("products"."sku" is null or char_length("products"."sku") between 1 and 64),
	CONSTRAINT "products_price_check" CHECK ("products"."price_minor" between 0 and 100000000000),
	CONSTRAINT "products_compare_at_check" CHECK ("products"."compare_at_price_minor" is null or "products"."compare_at_price_minor" between 0 and 100000000000),
	CONSTRAINT "products_cost_check" CHECK ("products"."cost_minor" is null or "products"."cost_minor" between 0 and 100000000000),
	CONSTRAINT "products_quantity_check" CHECK ("products"."quantity" >= 0),
	CONSTRAINT "products_low_stock_check" CHECK ("products"."low_stock_threshold" >= 0),
	CONSTRAINT "products_status_check" CHECK ("products"."status" in ('draft', 'active'))
);
--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"phone" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "customers_email_check" CHECK (char_length("customers"."email") between 3 and 254 and position('@' in "customers"."email") > 1),
	CONSTRAINT "customers_full_name_check" CHECK (char_length(btrim("customers"."full_name")) between 1 and 120),
	CONSTRAINT "customers_phone_check" CHECK ("customers"."phone" is null or char_length("customers"."phone") between 4 and 32),
	CONSTRAINT "customers_notes_check" CHECK ("customers"."notes" is null or char_length("customers"."notes") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid,
	"variant_id" uuid,
	"name" text NOT NULL,
	"sku" text,
	"quantity" integer NOT NULL,
	"unit_price_minor" bigint NOT NULL,
	"total_minor" bigint NOT NULL,
	CONSTRAINT "order_items_quantity_check" CHECK ("order_items"."quantity" > 0),
	CONSTRAINT "order_items_amounts_check" CHECK ("order_items"."unit_price_minor" >= 0 and "order_items"."total_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid,
	"order_number" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"currency" text NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"total_minor" bigint NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "orders_tenant_id_order_number_key" UNIQUE("tenant_id","order_number"),
	CONSTRAINT "orders_status_check" CHECK ("orders"."status" in ('pending', 'paid', 'fulfilled', 'cancelled', 'refunded')),
	CONSTRAINT "orders_currency_check" CHECK ("orders"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "orders_amounts_check" CHECK ("orders"."subtotal_minor" >= 0 and "orders"."total_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_products" ADD CONSTRAINT "collection_products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_products" ADD CONSTRAINT "collection_products_collection_fk" FOREIGN KEY ("tenant_id","collection_id") REFERENCES "public"."collections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_products" ADD CONSTRAINT "collection_products_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_image_id_product_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."product_images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "categories_parent_id_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "collection_products_product_id_idx" ON "collection_products" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "inventory_adjustments_product_idx" ON "inventory_adjustments" USING btree ("product_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inventory_adjustments_tenant_created_idx" ON "inventory_adjustments" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "product_images_one_primary_idx" ON "product_images" USING btree ("product_id") WHERE "product_images"."is_primary";--> statement-breakpoint
CREATE INDEX "product_images_product_id_idx" ON "product_images" USING btree ("product_id","position");--> statement-breakpoint
CREATE INDEX "product_options_product_id_idx" ON "product_options" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_tenant_id_sku_key" ON "product_variants" USING btree ("tenant_id","sku") WHERE "product_variants"."sku" is not null;--> statement-breakpoint
CREATE INDEX "product_variants_product_id_idx" ON "product_variants" USING btree ("product_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "products_tenant_id_sku_key" ON "products" USING btree ("tenant_id","sku") WHERE "products"."sku" is not null;--> statement-breakpoint
CREATE INDEX "products_tenant_status_idx" ON "products" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "products_tenant_created_idx" ON "products" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "products_category_id_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_tenant_id_email_key" ON "customers" USING btree ("tenant_id",lower("email"));--> statement-breakpoint
CREATE INDEX "customers_tenant_created_idx" ON "customers" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "order_items_order_id_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_product_id_idx" ON "order_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "orders_tenant_placed_idx" ON "orders" USING btree ("tenant_id","placed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_customer_id_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_contact_email_check" CHECK ("stores"."contact_email" is null or (char_length("stores"."contact_email") <= 254 and position('@' in "stores"."contact_email") > 1));--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_contact_phone_check" CHECK ("stores"."contact_phone" is null or char_length("stores"."contact_phone") between 4 and 32);--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_logo_path_check" CHECK ("stores"."logo_url" is null or "stores"."logo_url" like "stores"."tenant_id"::text || '/store/%');