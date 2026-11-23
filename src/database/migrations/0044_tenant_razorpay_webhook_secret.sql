-- Custom migration: the tenant's Razorpay webhook secret, encrypted at rest.
--
-- Same model as the Key Secret (0042): the webhook secret exists ONLY as AES-256-GCM ciphertext with its own IV, authentication
-- tag and key version (it can be saved later than the Key Secret, so it may use an older key version). All four columns are NULL
-- together (no webhook secret saved) or all set. The request role can never SELECT them; it may SELECT only
-- webhook_secret_updated_at, a non-secret timestamp whose NULL means "not configured", so the status needs no secret read.
-- Existing RLS policies already cover the new columns (row based, Owner only); only column privileges are extended.

ALTER TABLE "tenant_razorpay_config"
	ADD COLUMN "webhook_secret_ciphertext" text,
	ADD COLUMN "webhook_secret_iv" text,
	ADD COLUMN "webhook_secret_auth_tag" text,
	ADD COLUMN "webhook_secret_key_version" smallint,
	ADD COLUMN "webhook_secret_updated_at" timestamp with time zone,
	ADD CONSTRAINT "trc_webhook_all_or_none_check" CHECK (
		("webhook_secret_ciphertext" IS NULL AND "webhook_secret_iv" IS NULL AND "webhook_secret_auth_tag" IS NULL
			AND "webhook_secret_key_version" IS NULL AND "webhook_secret_updated_at" IS NULL)
		OR ("webhook_secret_ciphertext" IS NOT NULL AND "webhook_secret_iv" IS NOT NULL AND "webhook_secret_auth_tag" IS NOT NULL
			AND "webhook_secret_key_version" IS NOT NULL AND "webhook_secret_updated_at" IS NOT NULL)
	),
	ADD CONSTRAINT "trc_webhook_key_version_check" CHECK ("webhook_secret_key_version" IS NULL OR "webhook_secret_key_version" >= 1),
	ADD CONSTRAINT "trc_webhook_iv_check" CHECK ("webhook_secret_iv" IS NULL OR "webhook_secret_iv" ~ '^[A-Za-z0-9+/]{16}$'),
	ADD CONSTRAINT "trc_webhook_auth_tag_check" CHECK ("webhook_secret_auth_tag" IS NULL OR "webhook_secret_auth_tag" ~ '^[A-Za-z0-9+/]{22}==$'),
	ADD CONSTRAINT "trc_webhook_ciphertext_check" CHECK (
		"webhook_secret_ciphertext" IS NULL
		OR ("webhook_secret_ciphertext" ~ '^[A-Za-z0-9+/]+={0,2}$' AND char_length("webhook_secret_ciphertext") <= 2048)
	);
--> statement-breakpoint

GRANT SELECT (webhook_secret_updated_at) ON public.tenant_razorpay_config TO authenticated;
--> statement-breakpoint
GRANT INSERT (webhook_secret_ciphertext, webhook_secret_iv, webhook_secret_auth_tag, webhook_secret_key_version, webhook_secret_updated_at) ON public.tenant_razorpay_config TO authenticated;
--> statement-breakpoint
GRANT UPDATE (webhook_secret_ciphertext, webhook_secret_iv, webhook_secret_auth_tag, webhook_secret_key_version, webhook_secret_updated_at) ON public.tenant_razorpay_config TO authenticated;
