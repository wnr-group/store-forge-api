CREATE TABLE "store_template_settings" (
	"store_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"accent_color" text,
	"hero_heading" text,
	"hero_subheading" text,
	"hero_image_path" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_template_settings_template_key_check" CHECK ("store_template_settings"."template_key" ~ '^[a-z][a-z0-9-]{1,39}$'),
	CONSTRAINT "store_template_settings_accent_color_check" CHECK ("store_template_settings"."accent_color" is null or "store_template_settings"."accent_color" ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "store_template_settings_hero_heading_check" CHECK ("store_template_settings"."hero_heading" is null or char_length(btrim("store_template_settings"."hero_heading")) between 1 and 80),
	CONSTRAINT "store_template_settings_hero_subheading_check" CHECK ("store_template_settings"."hero_subheading" is null or char_length(btrim("store_template_settings"."hero_subheading")) between 1 and 200),
	CONSTRAINT "store_template_settings_hero_image_path_check" CHECK ("store_template_settings"."hero_image_path" is null or ("store_template_settings"."hero_image_path" like "store_template_settings"."tenant_id"::text || '/store/%' and "store_template_settings"."hero_image_path" !~ '\.\.'))
);
--> statement-breakpoint
ALTER TABLE "store_template_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Statement order fixed by hand (drizzle-kit emitted the FK first): the composite FK below needs this unique constraint to exist.
ALTER TABLE "stores" ADD CONSTRAINT "stores_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "store_template_settings" ADD CONSTRAINT "store_template_settings_store_fk" FOREIGN KEY ("tenant_id","store_id") REFERENCES "public"."stores"("tenant_id","id") ON DELETE cascade ON UPDATE no action;