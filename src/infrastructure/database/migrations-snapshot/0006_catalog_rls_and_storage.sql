-- Custom migration: privileges, RLS policies, triggers and the product-image bucket
-- for the catalog / customer / order tables created in 0005.
--
-- Roles:  owner/admin/staff may create and edit catalog data, stock and customers;
--         only owner/admin may delete. Orders are read-only (no checkout yet).
-- Same conventions as 0002: policies call the SECURITY DEFINER helpers instead of
-- querying memberships, and UPDATE is granted per column so tenant_id/id can never change.

-- Privileges --------------------------------------------------------------------
REVOKE ALL ON
  public.categories, public.collections, public.products, public.product_images,
  public.product_options, public.product_variants, public.collection_products,
  public.inventory_adjustments, public.customers, public.orders, public.order_items
  FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON
  public.categories, public.collections, public.products, public.product_images,
  public.product_options, public.product_variants, public.collection_products,
  public.customers
  TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.inventory_adjustments TO authenticated;
--> statement-breakpoint
GRANT SELECT ON public.orders, public.order_items TO authenticated;
--> statement-breakpoint
GRANT UPDATE (parent_id, name, slug, description) ON public.categories TO authenticated;
--> statement-breakpoint
GRANT UPDATE (name, slug, description, image_path, status) ON public.collections TO authenticated;
--> statement-breakpoint
GRANT UPDATE (
  category_id, name, slug, description, short_description, product_type, sku, price_minor,
  compare_at_price_minor, cost_minor, has_variants, track_inventory, quantity,
  low_stock_threshold, status
) ON public.products TO authenticated;
--> statement-breakpoint
GRANT UPDATE (alt_text, position, is_primary) ON public.product_images TO authenticated;
--> statement-breakpoint
GRANT UPDATE (name, position, values) ON public.product_options TO authenticated;
--> statement-breakpoint
GRANT UPDATE (
  title, options, sku, price_minor, compare_at_price_minor, quantity, image_id, is_active, position
) ON public.product_variants TO authenticated;
--> statement-breakpoint
GRANT UPDATE (position) ON public.collection_products TO authenticated;
--> statement-breakpoint
GRANT UPDATE (email, full_name, phone, notes) ON public.customers TO authenticated;
--> statement-breakpoint
-- Store settings: the two new contact columns join the existing admin-only update grant.
GRANT UPDATE (contact_email, contact_phone) ON public.stores TO authenticated;
--> statement-breakpoint

-- updated_at triggers -------------------------------------------------------------
CREATE TRIGGER categories_set_updated_at BEFORE UPDATE ON public.categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER collections_set_updated_at BEFORE UPDATE ON public.collections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER products_set_updated_at BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER product_variants_set_updated_at BEFORE UPDATE ON public.product_variants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER customers_set_updated_at BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- categories ------------------------------------------------------------------------
CREATE POLICY categories_select_members ON public.categories
  FOR SELECT TO authenticated USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint
CREATE POLICY categories_insert_editors ON public.categories
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff'])
    AND (parent_id IS NULL OR EXISTS (
      SELECT 1 FROM public.categories p WHERE p.id = categories.parent_id AND p.tenant_id = categories.tenant_id))
  );
--> statement-breakpoint
CREATE POLICY categories_update_editors ON public.categories
  FOR UPDATE TO authenticated
  USING (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']))
  WITH CHECK (
    public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff'])
    AND (parent_id IS NULL OR EXISTS (
      SELECT 1 FROM public.categories p WHERE p.id = categories.parent_id AND p.tenant_id = categories.tenant_id))
  );
--> statement-breakpoint
CREATE POLICY categories_delete_admins ON public.categories
  FOR DELETE TO authenticated USING (public.has_tenant_role(tenant_id, array['owner', 'admin']));
--> statement-breakpoint

-- collections -----------------------------------------------------------------------
CREATE POLICY collections_select_members ON public.collections
  FOR SELECT TO authenticated USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint
CREATE POLICY collections_insert_editors ON public.collections
  FOR INSERT TO authenticated WITH CHECK (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']));
--> statement-breakpoint
CREATE POLICY collections_update_editors ON public.collections
  FOR UPDATE TO authenticated
  USING (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']))
  WITH CHECK (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']));
--> statement-breakpoint
CREATE POLICY collections_delete_admins ON public.collections
  FOR DELETE TO authenticated USING (public.has_tenant_role(tenant_id, array['owner', 'admin']));
--> statement-breakpoint

-- products --------------------------------------------------------------------------
CREATE POLICY products_select_members ON public.products
  FOR SELECT TO authenticated USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint
CREATE POLICY products_insert_editors ON public.products
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff'])
    AND (category_id IS NULL OR EXISTS (
      SELECT 1 FROM public.categories c WHERE c.id = products.category_id AND c.tenant_id = products.tenant_id))
  );
--> statement-breakpoint
CREATE POLICY products_update_editors ON public.products
  FOR UPDATE TO authenticated
  USING (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']))
  WITH CHECK (
    public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff'])
    AND (category_id IS NULL OR EXISTS (
      SELECT 1 FROM public.categories c WHERE c.id = products.category_id AND c.tenant_id = products.tenant_id))
  );
--> statement-breakpoint
CREATE POLICY products_delete_admins ON public.products
  FOR DELETE TO authenticated USING (public.has_tenant_role(tenant_id, array['owner', 'admin']));
--> statement-breakpoint

-- product_images ----------------------------------------------------------------------
CREATE POLICY product_images_select_members ON public.product_images
  FOR SELECT TO authenticated USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint
CREATE POLICY product_images_insert_editors ON public.product_images
  FOR INSERT TO authenticated WITH CHECK (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']));
--> statement-breakpoint
CREATE POLICY product_images_update_editors ON public.product_images
  FOR UPDATE TO authenticated
  USING (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']))
  WITH CHECK (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']));
--> statement-breakpoint
CREATE POLICY product_images_delete_editors ON public.product_images
  FOR DELETE TO authenticated USING (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']));
--> statement-breakpoint

-- product_options ---------------------------------------------------------------------
CREATE POLICY product_options_select_members ON public.product_options
  FOR SELECT TO authenticated USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint
CREATE POLICY product_options_insert_editors ON public.product_options
  FOR INSERT TO authenticated WITH CHECK (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']));
--> statement-breakpoint
CREATE POLICY product_options_update_editors ON public.product_options
  FOR UPDATE TO authenticated
  USING (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']))
  WITH CHECK (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']));
--> statement-breakpoint
CREATE POLICY product_options_delete_editors ON public.product_options
  FOR DELETE TO authenticated USING (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']));
--> statement-breakpoint

-- product_variants (image, if any, must belong to the same product) ------------------------
CREATE POLICY product_variants_select_members ON public.product_variants
  FOR SELECT TO authenticated USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint
CREATE POLICY product_variants_insert_editors ON public.product_variants
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff'])
    AND (image_id IS NULL OR EXISTS (
      SELECT 1 FROM public.product_images i
      WHERE i.id = product_variants.image_id AND i.tenant_id = product_variants.tenant_id
        AND i.product_id = product_variants.product_id))
  );
--> statement-breakpoint
CREATE POLICY product_variants_update_editors ON public.product_variants
  FOR UPDATE TO authenticated
  USING (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']))
  WITH CHECK (
    public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff'])
    AND (image_id IS NULL OR EXISTS (
      SELECT 1 FROM public.product_images i
      WHERE i.id = product_variants.image_id AND i.tenant_id = product_variants.tenant_id
        AND i.product_id = product_variants.product_id))
  );
--> statement-breakpoint
CREATE POLICY product_variants_delete_editors ON public.product_variants
  FOR DELETE TO authenticated USING (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']));
--> statement-breakpoint

-- collection_products -----------------------------------------------------------------
CREATE POLICY collection_products_select_members ON public.collection_products
  FOR SELECT TO authenticated USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint
CREATE POLICY collection_products_insert_editors ON public.collection_products
  FOR INSERT TO authenticated WITH CHECK (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']));
--> statement-breakpoint
CREATE POLICY collection_products_update_editors ON public.collection_products
  FOR UPDATE TO authenticated
  USING (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']))
  WITH CHECK (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']));
--> statement-breakpoint
CREATE POLICY collection_products_delete_editors ON public.collection_products
  FOR DELETE TO authenticated USING (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']));
--> statement-breakpoint

-- inventory_adjustments: append-only ledger (no UPDATE / DELETE policy) ---------------------
CREATE POLICY inventory_adjustments_select_members ON public.inventory_adjustments
  FOR SELECT TO authenticated USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint
CREATE POLICY inventory_adjustments_insert_editors ON public.inventory_adjustments
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff'])
    AND created_by = (SELECT auth.uid())
  );
--> statement-breakpoint

-- customers ---------------------------------------------------------------------------
CREATE POLICY customers_select_members ON public.customers
  FOR SELECT TO authenticated USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint
CREATE POLICY customers_insert_editors ON public.customers
  FOR INSERT TO authenticated WITH CHECK (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']));
--> statement-breakpoint
CREATE POLICY customers_update_editors ON public.customers
  FOR UPDATE TO authenticated
  USING (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']))
  WITH CHECK (public.has_tenant_role(tenant_id, array['owner', 'admin', 'staff']));
--> statement-breakpoint
CREATE POLICY customers_delete_admins ON public.customers
  FOR DELETE TO authenticated USING (public.has_tenant_role(tenant_id, array['owner', 'admin']));
--> statement-breakpoint

-- orders / order_items: read-only for members ------------------------------------------
CREATE POLICY orders_select_members ON public.orders
  FOR SELECT TO authenticated USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint
CREATE POLICY order_items_select_members ON public.order_items
  FOR SELECT TO authenticated USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint

-- Storage ---------------------------------------------------------------------------------
-- Object paths are `{tenant_id}/...`. This helper extracts the tenant from the FIRST path
-- segment; it returns NULL for anything that is not a UUID, and has_tenant_role(NULL, ...)
-- is false, so malformed paths are denied rather than raising an error.
CREATE FUNCTION public.storage_path_tenant(p_name text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN split_part(p_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN split_part(p_name, '/', 1)::uuid
  END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.storage_path_tenant(text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.storage_path_tenant(text) TO authenticated;
--> statement-breakpoint

-- Write access to an object: owner/admin/staff for catalog media, owner/admin only for the
-- store's own assets (`{tenant_id}/store/...`), mirroring who may edit store settings.
CREATE FUNCTION public.can_write_storage_object(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT public.has_tenant_role(
    public.storage_path_tenant(p_name),
    CASE WHEN split_part(p_name, '/', 2) = 'store'
      THEN array['owner', 'admin']
      ELSE array['owner', 'admin', 'staff']
    END
  );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.can_write_storage_object(text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.can_write_storage_object(text) TO authenticated;
--> statement-breakpoint

-- Bucket + policies. Skipped where Supabase Storage does not exist (the PGlite test database).
-- Public READ of objects works through the bucket's `public` flag (storefront images); the
-- policies below govern listing and every WRITE, and require tenant membership by path.
DO $storage$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE 'storage.objects not found - skipping bucket and storage policies';
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('products', 'products', true, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
  ON CONFLICT (id) DO UPDATE
    SET public = true, file_size_limit = 5242880,
        allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

  DROP POLICY IF EXISTS products_objects_select ON storage.objects;
  DROP POLICY IF EXISTS products_objects_insert ON storage.objects;
  DROP POLICY IF EXISTS products_objects_update ON storage.objects;
  DROP POLICY IF EXISTS products_objects_delete ON storage.objects;

  CREATE POLICY products_objects_select ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'products' AND public.is_tenant_member(public.storage_path_tenant(name)));
  CREATE POLICY products_objects_insert ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'products' AND public.can_write_storage_object(name));
  CREATE POLICY products_objects_update ON storage.objects FOR UPDATE TO authenticated
    USING (bucket_id = 'products'
      AND public.has_tenant_role(public.storage_path_tenant(name), array['owner', 'admin', 'staff']))
    WITH CHECK (bucket_id = 'products' AND public.can_write_storage_object(name));
  CREATE POLICY products_objects_delete ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'products' AND public.can_write_storage_object(name));
END
$storage$;
