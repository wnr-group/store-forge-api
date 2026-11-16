-- Custom migration: a short, random, unique public identifier for every tenant (tenants.public_id).
--
-- It will become the suffix of the tenant's public address, {slug}-{public_id}.store-forge.com. Nothing reads it for
-- routing yet; this migration only stores it. The internal tenant id (uuid primary key) is unchanged, and no row is
-- deleted or recreated, so every relationship, product, order and membership stays exactly as it was.
--
-- Steps (all inside the migrator's single transaction: a failure at any step changes nothing):
--   1. add the column as NULLable, 2. fill it for every existing tenant with a unique random value,
--   3. add the NOT NULL, UNIQUE and format constraints, 4. let platform_provision_tenant() store a value for new tenants.
--
-- New tenants get their value from the API (Node crypto) through the new optional p_public_id argument; when it is
-- omitted the function falls back to the SQL generator below, so older callers keep working. The value is never part of
-- an editable column: authenticated users only hold UPDATE on tenants (name, slug), and platform_update_tenant() does
-- not touch it, so it cannot change after creation.

-- 1. Column (nullable until every existing row has a value). ------------------------------------------------------
ALTER TABLE "tenants" ADD COLUMN "public_id" text;
--> statement-breakpoint

-- Random 6-character id from [a-z0-9]. gen_random_uuid() is cryptographically random; its first 6 bytes carry no
-- version/variant bits, so each byte is fully random. Internal helper: no caller can run it directly.
CREATE FUNCTION public.generate_tenant_public_id()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_alphabet constant text := 'abcdefghijklmnopqrstuvwxyz0123456789';
  v_bytes    bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  v_id       text := '';
  i          integer;
BEGIN
  FOR i IN 0..5 LOOP
    v_id := v_id || substr(v_alphabet, (get_byte(v_bytes, i) % 36) + 1, 1);
  END LOOP;
  RETURN v_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.generate_tenant_public_id() FROM public, anon, authenticated;
--> statement-breakpoint

-- 2. Backfill every existing tenant, retrying on a collision with an already assigned value. ----------------------
DO $$
DECLARE
  v_tenant_id uuid;
  v_candidate text;
BEGIN
  FOR v_tenant_id IN SELECT id FROM public.tenants WHERE public_id IS NULL ORDER BY created_at, id LOOP
    LOOP
      v_candidate := public.generate_tenant_public_id();
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.public_id = v_candidate);
    END LOOP;
    UPDATE public.tenants SET public_id = v_candidate WHERE id = v_tenant_id;
  END LOOP;
END;
$$;
--> statement-breakpoint

-- 3. Constraints. Setting NOT NULL fails (and rolls everything back) if any row was missed. -----------------------
ALTER TABLE "tenants" ALTER COLUMN "public_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_public_id_key" UNIQUE ("public_id");
--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_public_id_check" CHECK ("public_id" ~ '^[a-z0-9]{5,8}$');
--> statement-breakpoint

-- 4. Organization creation stores the id. The old 7-argument signature is replaced (not overloaded) so that calls with
-- fewer arguments still resolve to exactly one function. Behaviour is otherwise identical to 0022: idempotent for the
-- same owner and store address, atomic, Platform Admin only. The only additions: the optional p_public_id, and a
-- 'public_id_taken' error (instead of 'slug_taken') when that value collides, so the caller can retry with a new one.
DROP FUNCTION public.platform_provision_tenant(uuid, text, text, text, text, text, text);
--> statement-breakpoint
CREATE FUNCTION public.platform_provision_tenant(
  p_owner_id           uuid,
  p_tenant_name        text,
  p_store_name         text,
  p_store_slug         text,
  p_store_description  text DEFAULT NULL,
  p_contact_phone      text DEFAULT NULL,
  p_address            text DEFAULT NULL,
  p_public_id          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_name text := btrim(coalesce(p_tenant_name, ''));
  v_store_name  text := btrim(coalesce(p_store_name, ''));
  v_description text := nullif(btrim(coalesce(p_store_description, '')), '');
  v_phone       text := nullif(btrim(coalesce(p_contact_phone, '')), '');
  v_address     text := nullif(btrim(coalesce(p_address, '')), '');
  v_public_id   text := p_public_id;
  v_tenant_id   uuid;
  v_store_id    uuid;
  v_tenant_slug text;
  v_currency    text := 'INR';
  v_timezone    text := 'Asia/Kolkata';
  v_status      text := 'active';
  v_constraint  text;
BEGIN
  IF (SELECT auth.uid()) IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;

  IF p_owner_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_owner_id) THEN
    RAISE EXCEPTION 'owner_not_found';
  END IF;

  IF char_length(v_tenant_name) NOT BETWEEN 2 AND 80
     OR char_length(v_store_name) NOT BETWEEN 2 AND 80
     OR char_length(coalesce(v_description, '')) > 500
     OR (v_phone IS NOT NULL AND char_length(v_phone) NOT BETWEEN 4 AND 32)
     OR char_length(coalesce(v_address, '')) > 300
     OR (v_public_id IS NOT NULL AND v_public_id !~ '^[a-z0-9]{5,8}$') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF NOT public.is_valid_store_slug(p_store_slug) THEN
    RAISE EXCEPTION 'invalid_slug';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 42));

  SELECT t.id, s.id INTO v_tenant_id, v_store_id
  FROM public.stores s
  JOIN public.tenants t ON t.id = s.tenant_id
  JOIN public.memberships m ON m.tenant_id = t.id
  WHERE s.slug = p_store_slug AND m.user_id = p_owner_id AND m.role = 'owner';

  IF v_store_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'tenant_id', v_tenant_id, 'store_id', v_store_id,
      'store_slug', p_store_slug, 'created', false);
  END IF;

  IF EXISTS (SELECT 1 FROM public.stores s WHERE s.slug = p_store_slug) THEN
    RAISE EXCEPTION 'slug_taken';
  END IF;

  v_tenant_slug := p_store_slug;
  IF EXISTS (SELECT 1 FROM public.tenants t WHERE t.slug = v_tenant_slug) THEN
    v_tenant_slug := left(p_store_slug, 31) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
  END IF;

  -- No value supplied: generate one here, retrying until it is free.
  IF v_public_id IS NULL THEN
    LOOP
      v_public_id := public.generate_tenant_public_id();
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.public_id = v_public_id);
    END LOOP;
  ELSIF EXISTS (SELECT 1 FROM public.tenants t WHERE t.public_id = v_public_id) THEN
    RAISE EXCEPTION 'public_id_taken';
  END IF;

  SELECT s.default_currency, s.default_timezone, s.default_store_status INTO v_currency, v_timezone, v_status
  FROM public.platform_settings s;

  BEGIN
    INSERT INTO public.tenants (name, slug, public_id, contact_phone, address, created_by)
    VALUES (v_tenant_name, v_tenant_slug, v_public_id, v_phone, v_address, p_owner_id)
    RETURNING id INTO v_tenant_id;

    INSERT INTO public.memberships (tenant_id, user_id, role)
    VALUES (v_tenant_id, p_owner_id, 'owner');

    INSERT INTO public.stores (tenant_id, name, slug, description, contact_phone, currency, timezone, status)
    VALUES (v_tenant_id, v_store_name, p_store_slug, v_description, v_phone, v_currency, v_timezone, v_status)
    RETURNING id INTO v_store_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'tenants_public_id_key' THEN
      RAISE EXCEPTION 'public_id_taken';
    END IF;
    RAISE EXCEPTION 'slug_taken';
  END;

  RETURN jsonb_build_object(
    'tenant_id', v_tenant_id, 'store_id', v_store_id,
    'store_slug', p_store_slug, 'created', true);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_provision_tenant(uuid, text, text, text, text, text, text, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_provision_tenant(uuid, text, text, text, text, text, text, text) TO authenticated;
