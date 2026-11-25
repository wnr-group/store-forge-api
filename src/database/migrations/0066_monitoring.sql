-- Custom migration: operational monitoring data (server errors and scheduled-job runs).
--
--   * platform_error_events: one row per unhandled server error (HTTP 5xx), written by the application's exception filter. It holds the
--     route TEMPLATE (never the URL with ids or the query string), the error class, a sanitised message (no values, ids, e-mail addresses
--     or tokens), the first stack frame and the request id. No request body, headers, user or tenant data is ever stored here.
--     Bounded on purpose: rows older than 14 days are removed, and at most 200 are recorded per minute so an outage cannot flood the table.
--   * platform_job_runs: each run of a scheduler route (/internal/jobs/*): when, how long, ok or failed, a small numeric summary or a
--     sanitised error. Rows older than 30 days are removed.
--   * Writing is done only by two SECURITY DEFINER functions that the application (and nobody on the REST path) can call; reading is for
--     Platform Admins (row level security). Nothing here is writable by a signed-in user.
-- When the database itself is down nothing can be recorded; the monitoring screen says so instead of showing a calm "0 errors".

CREATE TABLE "platform_error_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"method" text NOT NULL,
	"route" text NOT NULL,
	"status" integer NOT NULL,
	"error_name" text NOT NULL,
	"message" text NOT NULL,
	"source" text,
	"request_id" text,
	CONSTRAINT "platform_error_events_status_check" CHECK ("status" between 500 and 599),
	CONSTRAINT "platform_error_events_lengths_check" CHECK (char_length("method") <= 10 and char_length("route") <= 200 and char_length("error_name") <= 100 and char_length("message") <= 300 and ("source" is null or char_length("source") <= 150) and ("request_id" is null or char_length("request_id") <= 100))
);
--> statement-breakpoint
CREATE INDEX "platform_error_events_occurred_idx" ON "platform_error_events" USING btree ("occurred_at" DESC);
--> statement-breakpoint
CREATE INDEX "platform_error_events_issue_idx" ON "platform_error_events" USING btree ("route", "error_name", "occurred_at" DESC);
--> statement-breakpoint

CREATE TABLE "platform_job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"summary" jsonb,
	"error" text,
	CONSTRAINT "platform_job_runs_status_check" CHECK ("status" in ('ok', 'failed')),
	CONSTRAINT "platform_job_runs_job_check" CHECK ("job" ~ '^[a-z][a-z0-9-]{1,60}$'),
	CONSTRAINT "platform_job_runs_lengths_check" CHECK ("error" is null or char_length("error") <= 300),
	CONSTRAINT "platform_job_runs_summary_check" CHECK ("summary" is null or octet_length("summary"::text) <= 2000)
);
--> statement-breakpoint
CREATE INDEX "platform_job_runs_job_idx" ON "platform_job_runs" USING btree ("job", "started_at" DESC);
--> statement-breakpoint
CREATE INDEX "platform_job_runs_started_idx" ON "platform_job_runs" USING btree ("started_at" DESC);
--> statement-breakpoint

ALTER TABLE "platform_error_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "platform_job_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.platform_error_events, public.platform_job_runs FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON public.platform_error_events, public.platform_job_runs TO authenticated;
--> statement-breakpoint
CREATE POLICY platform_error_events_read ON public.platform_error_events FOR SELECT TO authenticated USING (public.is_platform_admin());
--> statement-breakpoint
CREATE POLICY platform_job_runs_read ON public.platform_job_runs FOR SELECT TO authenticated USING (public.is_platform_admin());
--> statement-breakpoint

-- Called by the application's exception filter, with no user. Returns whether a row was written.
CREATE FUNCTION public.monitoring_record_error(
  p_method text, p_route text, p_status integer, p_error_name text, p_message text, p_source text, p_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF session_user = 'authenticator' OR (SELECT auth.uid()) IS NOT NULL THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT BETWEEN 500 AND 599 THEN RETURN false; END IF;
  -- An outage can produce thousands of identical errors a minute: keep the table (and this function) cheap.
  IF (SELECT count(*) FROM public.platform_error_events WHERE occurred_at > now() - interval '1 minute') >= 200 THEN
    RETURN false;
  END IF;
  INSERT INTO public.platform_error_events (method, route, status, error_name, message, source, request_id)
  VALUES (left(coalesce(p_method, '?'), 10), left(coalesce(p_route, '?'), 200), p_status, left(coalesce(p_error_name, 'Error'), 100),
          left(coalesce(p_message, ''), 300), left(p_source, 150), left(p_request_id, 100));
  IF random() < 0.02 THEN
    DELETE FROM public.platform_error_events WHERE occurred_at < now() - interval '14 days';
  END IF;
  RETURN true;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION public.monitoring_record_job(
  p_job text, p_status text, p_started timestamptz, p_finished timestamptz, p_summary jsonb, p_error text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF session_user = 'authenticator' OR (SELECT auth.uid()) IS NOT NULL THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  INSERT INTO public.platform_job_runs (job, status, started_at, finished_at, duration_ms, summary, error)
  VALUES (p_job, p_status, p_started, p_finished,
          least(greatest(extract(epoch FROM (p_finished - p_started)) * 1000, 0), 2147483000)::integer,
          p_summary, left(p_error, 300));
  IF random() < 0.05 THEN
    DELETE FROM public.platform_job_runs WHERE started_at < now() - interval '30 days';
  END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.monitoring_record_error(text, text, integer, text, text, text, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.monitoring_record_job(text, text, timestamptz, timestamptz, jsonb, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.monitoring_record_error(text, text, integer, text, text, text, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.monitoring_record_job(text, text, timestamptz, timestamptz, jsonb, text) TO authenticated;
