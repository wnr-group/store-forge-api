-- Custom data migration: V1 store_template_settings -> the template engine (decisions D17, D18).
--
-- For every store that has a V1 settings row and no default homepage template yet, create one default `index`
-- template from the matching preset with the V1 values applied, publish it as version 1 (source 'migration',
-- published_by NULL), and start the draft equal to it. Stores without a V1 row get nothing: the app falls back
-- to the built-in classic preset without any write. The V1 table and its rows are left untouched (rollback).
--
-- The document below is a FROZEN schemaVersion 1 snapshot of the classic/spotlight preset structure. Later
-- preset changes in code must not alter migrated stores. tests/db/templates-migration.test.ts checks that this
-- SQL and applyLegacyToPreset() in lib/templates/presets.ts agree.
--
-- Idempotent: the NOT EXISTS skips stores that already have a default homepage template, so a re-run creates
-- no second template and no second version. Unknown V1 template keys map to classic, as the V1 resolver did.
-- Atomic: the Drizzle migrator runs this file in one transaction.

DO $$
DECLARE
  r record;
  v_key text;
  v_accent text;
  v_doc jsonb;
  v_template_id uuid;
  v_version_id uuid;
BEGIN
  FOR r IN
    SELECT ts.tenant_id, ts.store_id, ts.template_key, ts.accent_color, ts.hero_heading, ts.hero_subheading, ts.hero_image_path
    FROM public.store_template_settings ts
    WHERE NOT EXISTS (
      SELECT 1 FROM public.templates t
      WHERE t.store_id = ts.store_id AND t.kind = 'index' AND t.is_default
    )
    ORDER BY ts.store_id
  LOOP
    v_key := CASE WHEN r.template_key = 'spotlight' THEN 'spotlight' ELSE 'classic' END;
    v_accent := nullif(btrim(r.accent_color), '');

    v_doc := jsonb_build_object(
      'schemaVersion', 1,
      'layout', v_key,
      'sections', jsonb_build_object(
        'hero', jsonb_build_object(
          'type', 'hero',
          'settings', jsonb_strip_nulls(jsonb_build_object(
            'variant', v_key,
            'heading', nullif(btrim(r.hero_heading), ''),
            'subheading', nullif(btrim(r.hero_subheading), ''),
            'image', CASE WHEN nullif(btrim(r.hero_image_path), '') IS NULL THEN NULL
                          ELSE jsonb_build_object('path', btrim(r.hero_image_path), 'alt', '') END,
            'accentColor', v_accent
          )),
          'blocks', '{}'::jsonb,
          'block_order', '[]'::jsonb
        ),
        'products', jsonb_build_object(
          'type', 'product-grid',
          'settings', jsonb_strip_nulls(jsonb_build_object('accentColor', v_accent)),
          'blocks', '{}'::jsonb,
          'block_order', '[]'::jsonb
        )
      ),
      'order', jsonb_build_array('hero', 'products')
    );

    INSERT INTO public.templates (tenant_id, store_id, kind, name, is_default, draft)
    VALUES (r.tenant_id, r.store_id, 'index', CASE WHEN v_key = 'spotlight' THEN 'Spotlight' ELSE 'Classic' END, true, v_doc)
    RETURNING id INTO v_template_id;

    INSERT INTO public.template_versions (tenant_id, store_id, template_id, document, source)
    VALUES (r.tenant_id, r.store_id, v_template_id, v_doc, 'migration')
    RETURNING id INTO v_version_id;

    UPDATE public.templates SET published_version_id = v_version_id WHERE id = v_template_id;
  END LOOP;
END
$$;
