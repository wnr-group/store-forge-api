-- Custom migration: stores.subdomain, the store's public host label {store slug}-{tenant public_id} ("urban-nest-zqkod2"),
-- plus a public lookup that resolves a host label to its store.
--
-- The address of a storefront is built from the STORE's slug (stores.slug, globally unique) and the owning tenant's
-- public_id. It is not tenants.slug: that one can differ (a collision suffix at provisioning) and a tenant may own
-- several stores, so only a store-level label addresses exactly one store.
--
-- A generated column cannot read another table, so the value is kept by a BEFORE INSERT OR UPDATE trigger that always
-- recomputes it. Nothing can set it by hand (whatever is written is overwritten), a slug rename changes it in the same
-- statement, and tenants.public_id is immutable (guarded by 0034), so it cannot drift. Existing rows are filled in step 3.
--
-- Failure behaviour: the migrator runs this file in one transaction. NOT NULL, UNIQUE and the format check would fail
-- and change nothing if a row were missed or two labels clashed. A clash is impossible by construction: public ids hold
-- no hyphen, so the label splits uniquely at its last hyphen back into (slug, public id), and stores.slug is unique.
--
-- custom_domain is separate future work; nothing here touches the host format used today.

-- 1. Column (nullable until every existing row has a value). ------------------------------------------------------
ALTER TABLE "stores" ADD COLUMN "subdomain" text;
--> statement-breakpoint

-- 2. Maintenance trigger. SECURITY DEFINER only so it can read tenants.public_id under RLS; it returns only the row
-- being written and takes no input but that row. Not callable by anyone.
CREATE FUNCTION public.stores_set_subdomain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  SELECT NEW.slug || '-' || t.public_id INTO NEW.subdomain
  FROM public.tenants t
  WHERE t.id = NEW.tenant_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stores_set_subdomain() FROM public, anon, authenticated;
--> statement-breakpoint
CREATE TRIGGER stores_set_subdomain
  BEFORE INSERT OR UPDATE ON "stores"
  FOR EACH ROW
  EXECUTE FUNCTION public.stores_set_subdomain();
--> statement-breakpoint

-- 3. Backfill every existing store (the trigger above only fires for new writes). -----------------------------------
UPDATE public.stores s SET subdomain = s.slug || '-' || t.public_id
FROM public.tenants t
WHERE t.id = s.tenant_id;
--> statement-breakpoint

-- 4. Constraints. NOT NULL fails (and rolls everything back) if any row was missed. Format: a DNS label. -----------
ALTER TABLE "stores" ALTER COLUMN "subdomain" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_subdomain_key" UNIQUE ("subdomain");
--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_subdomain_check" CHECK ("subdomain" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$');
--> statement-breakpoint

-- 5. Public lookup: host label -> the store's slug and its tenant's public id. Same visibility rule as
-- get_public_storefront() and get_public_store_public_id() (0030): only an ACTIVE store of an ACTIVE tenant answers,
-- so an unknown, inactive or suspended store all look the same (no row). Returns no ids and nothing else.
CREATE FUNCTION public.get_public_store_by_subdomain(p_subdomain text)
RETURNS TABLE (slug text, public_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT s.slug, t.public_id
  FROM public.stores s
  JOIN public.tenants t ON t.id = s.tenant_id
  WHERE p_subdomain IS NOT NULL
    AND p_subdomain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
    AND s.subdomain = p_subdomain
    AND s.status = 'active'
    AND t.status = 'active';
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_public_store_by_subdomain(text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_public_store_by_subdomain(text) TO authenticated;
