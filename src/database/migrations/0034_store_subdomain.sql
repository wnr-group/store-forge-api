-- Custom migration: tenants.public_id stays immutable. (The stores.subdomain column itself is in 0035.)
--
-- Until now this held only because no role was granted UPDATE on the column and no function touched it. This trigger
-- makes it a database rule that also binds the table owner and service-role code, which matters now that every store
-- address is derived from it.
CREATE FUNCTION public.tenants_public_id_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'tenants.public_id is immutable' USING errcode = '23514';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.tenants_public_id_immutable() FROM public, anon, authenticated;
--> statement-breakpoint
CREATE TRIGGER tenants_public_id_immutable
  BEFORE UPDATE OF "public_id" ON "tenants"
  FOR EACH ROW
  WHEN (OLD."public_id" IS DISTINCT FROM NEW."public_id")
  EXECUTE FUNCTION public.tenants_public_id_immutable();
