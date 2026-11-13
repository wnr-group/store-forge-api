-- Migration 0015: explicit cross-store and cross-tenant template assignment error (Option A, R6, AC-DB-011)
CREATE OR REPLACE FUNCTION public.template_assignments_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  SELECT t.kind INTO NEW.template_kind
  FROM public.templates t
  WHERE t.id = NEW.template_id
    AND t.tenant_id = NEW.tenant_id
    AND t.store_id = NEW.store_id;

  IF NEW.template_kind IS NULL THEN
    RAISE EXCEPTION 'template does not belong to this store'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;
