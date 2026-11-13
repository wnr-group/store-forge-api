CREATE TABLE "template_engine_cutover" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"completed_at" timestamp with time zone,
	"verified_stores" integer,
	"resync_counts" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_engine_cutover_singleton_check" CHECK ("template_engine_cutover"."id"),
	CONSTRAINT "template_engine_cutover_status_check" CHECK ("template_engine_cutover"."status" in ('pending', 'complete')),
	CONSTRAINT "template_engine_cutover_complete_check" CHECK ("template_engine_cutover"."status" <> 'complete' or ("template_engine_cutover"."completed_at" is not null and "template_engine_cutover"."verified_stores" is not null and "template_engine_cutover"."verified_stores" >= 0))
);
--> statement-breakpoint
ALTER TABLE "template_engine_cutover" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Cutover gate (option B): the marker starts PENDING, nobody but the privileged migration connection can touch it, and the only
-- way the app can read it is this function, which is true solely for a well-formed COMPLETE row (never for a missing row).
INSERT INTO public.template_engine_cutover (id, status) VALUES (true, 'pending') ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
REVOKE ALL ON public.template_engine_cutover FROM public, anon, authenticated;
--> statement-breakpoint
CREATE FUNCTION public.template_engine_cutover_complete()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(
    (SELECT c.status = 'complete' AND c.completed_at IS NOT NULL AND c.verified_stores IS NOT NULL
       FROM public.template_engine_cutover c WHERE c.id),
    false)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.template_engine_cutover_complete() FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.template_engine_cutover_complete() TO authenticated;
