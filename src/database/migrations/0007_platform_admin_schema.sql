CREATE TABLE "platform_admins" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_admins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_status_check" CHECK ("memberships"."status" in ('active', 'disabled'));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_status_check" CHECK ("tenants"."status" in ('active', 'suspended'));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_contact_phone_check" CHECK ("tenants"."contact_phone" is null or char_length("tenants"."contact_phone") between 4 and 32);--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_address_check" CHECK ("tenants"."address" is null or char_length("tenants"."address") <= 300);