-- Custom migration: Catalog Hierarchy (part 1 of 2: tables, integrity rules, security).
--
-- A store owner can describe their catalogue as a configurable hierarchy, e.g. Brand > Vehicle > Variant > Part category,
-- with any number of named levels, and place products on nodes of it. A product can sit on many nodes (no copies of the
-- product). Categories and collections are NOT touched: this is a separate structure.
--
--   * products.part_number: nullable, NOT unique (the SKU stays the stable product identifier).
--   * catalog_hierarchies: one per organization for now (the unique index below), but the tables carry hierarchy_id
--     everywhere so allowing several later is a matter of dropping that one index.
--   * catalog_levels: the named levels of a hierarchy, numbered 1..n without gaps. can_hold_products says whether nodes of
--     that level may carry products.
--   * catalog_nodes: the tree. A root node sits on level 1; a child sits on the level right after its parent's level. The
--     path of ancestors (path_ids) and the depth are kept by a trigger, never by the client.
--   * catalog_node_products: the many-to-many link between nodes and products.
--
-- Integrity that the database itself enforces (not only the API):
--   * every row carries tenant_id and points at its parents through composite (tenant_id, ...) foreign keys, so a row can
--     never reference another organization's row, even for a privileged writer;
--   * a node's level must be exactly one below its parent's level; a root must be on level 1; no cycles; level and
--     hierarchy of a node never change (a move changes only the parent);
--   * reordering levels is accepted only if every existing parent/child relation stays valid (checked when the transaction
--     commits, so a swap of two level numbers inside one transaction works) and levels stay numbered 1..n;
--   * products can only be linked to nodes whose level has can_hold_products, and that flag cannot be switched off while
--     products are linked to nodes of the level.
--
-- Security follows the other catalogue tables (0006/0018): row level security with member read and owner/admin/staff
-- write, an extra RESTRICTIVE policy that needs the Products module (read / write), and column-level grants (the client
-- can never write tenant_id, path_ids or depth after creation). Public reads are in migration 0073.

ALTER TABLE "products" ADD COLUMN "part_number" text;
--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_part_number_check"
  CHECK ("part_number" IS NULL OR char_length("part_number") BETWEEN 1 AND 64);
--> statement-breakpoint
CREATE INDEX "products_tenant_part_number_idx" ON "products" USING btree ("tenant_id", "part_number") WHERE "part_number" IS NOT NULL;
--> statement-breakpoint
GRANT UPDATE ("part_number") ON public.products TO authenticated;
--> statement-breakpoint

-- Tables -------------------------------------------------------------------------------------------------------------
CREATE TABLE "catalog_hierarchies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "catalog_hierarchies_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "catalog_hierarchies_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 80),
  CONSTRAINT "catalog_hierarchies_status_check" CHECK ("status" IN ('draft', 'active'))
);
--> statement-breakpoint
-- One hierarchy per organization for now. Dropping this index is all it takes to allow several.
CREATE UNIQUE INDEX "catalog_hierarchies_one_per_tenant_idx" ON "catalog_hierarchies" USING btree ("tenant_id");
--> statement-breakpoint

CREATE TABLE "catalog_levels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "hierarchy_id" uuid NOT NULL,
  "name" text NOT NULL,
  "position" integer NOT NULL,
  "can_hold_products" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "catalog_levels_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "catalog_levels_tenant_hierarchy_id_key" UNIQUE ("tenant_id", "hierarchy_id", "id"),
  -- Deferrable so one statement (or one transaction) can renumber the levels; checked at the end of the statement.
  CONSTRAINT "catalog_levels_position_key" UNIQUE ("hierarchy_id", "position") DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT "catalog_levels_hierarchy_fk" FOREIGN KEY ("tenant_id", "hierarchy_id")
    REFERENCES "catalog_hierarchies"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "catalog_levels_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 60),
  -- Technical safety limit: at most 20 levels.
  CONSTRAINT "catalog_levels_position_check" CHECK ("position" BETWEEN 1 AND 20)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_levels_name_key" ON "catalog_levels" USING btree ("hierarchy_id", lower("name"));
--> statement-breakpoint

CREATE TABLE "catalog_nodes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "hierarchy_id" uuid NOT NULL,
  "level_id" uuid NOT NULL,
  "parent_id" uuid,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text,
  "position" integer DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "seo_title" text,
  "seo_description" text,
  -- Maintained by trigger: ids from the root down to (and including) this node, and the number of them.
  "path_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  "depth" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "catalog_nodes_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "catalog_nodes_tenant_hierarchy_id_key" UNIQUE ("tenant_id", "hierarchy_id", "id"),
  CONSTRAINT "catalog_nodes_hierarchy_fk" FOREIGN KEY ("tenant_id", "hierarchy_id")
    REFERENCES "catalog_hierarchies"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "catalog_nodes_level_fk" FOREIGN KEY ("tenant_id", "hierarchy_id", "level_id")
    REFERENCES "catalog_levels"("tenant_id", "hierarchy_id", "id"),
  -- No ON DELETE action: the API deletes a whole subtree in one statement, and nothing may orphan a node by accident.
  CONSTRAINT "catalog_nodes_parent_fk" FOREIGN KEY ("tenant_id", "hierarchy_id", "parent_id")
    REFERENCES "catalog_nodes"("tenant_id", "hierarchy_id", "id"),
  CONSTRAINT "catalog_nodes_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  CONSTRAINT "catalog_nodes_slug_check" CHECK (char_length("slug") BETWEEN 1 AND 80 AND "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT "catalog_nodes_description_check" CHECK ("description" IS NULL OR char_length("description") <= 2000),
  CONSTRAINT "catalog_nodes_position_check" CHECK ("position" BETWEEN 0 AND 1000000),
  CONSTRAINT "catalog_nodes_status_check" CHECK ("status" IN ('draft', 'active')),
  CONSTRAINT "catalog_nodes_seo_title_check" CHECK ("seo_title" IS NULL OR char_length("seo_title") <= 70),
  CONSTRAINT "catalog_nodes_seo_description_check" CHECK ("seo_description" IS NULL OR char_length("seo_description") <= 160),
  CONSTRAINT "catalog_nodes_parent_check" CHECK ("parent_id" IS NULL OR "parent_id" <> "id"),
  CONSTRAINT "catalog_nodes_path_check" CHECK ("depth" BETWEEN 1 AND 20 AND cardinality("path_ids") = "depth" AND "path_ids"["depth"] = "id")
);
--> statement-breakpoint
-- Slugs are unique among siblings (a NULL parent is "the roots", which a plain unique constraint would not catch).
CREATE UNIQUE INDEX "catalog_nodes_root_slug_key" ON "catalog_nodes" USING btree ("hierarchy_id", "slug") WHERE "parent_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_nodes_child_slug_key" ON "catalog_nodes" USING btree ("parent_id", "slug") WHERE "parent_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "catalog_nodes_children_idx" ON "catalog_nodes" USING btree ("tenant_id", "hierarchy_id", "parent_id", "position", "name");
--> statement-breakpoint
CREATE INDEX "catalog_nodes_level_idx" ON "catalog_nodes" USING btree ("level_id");
--> statement-breakpoint
CREATE INDEX "catalog_nodes_path_ids_idx" ON "catalog_nodes" USING gin ("path_ids");
--> statement-breakpoint

CREATE TABLE "catalog_node_products" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "node_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "catalog_node_products_pkey" PRIMARY KEY ("node_id", "product_id"),
  CONSTRAINT "catalog_node_products_node_fk" FOREIGN KEY ("tenant_id", "node_id")
    REFERENCES "catalog_nodes"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "catalog_node_products_product_fk" FOREIGN KEY ("tenant_id", "product_id")
    REFERENCES "products"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "catalog_node_products_position_check" CHECK ("position" BETWEEN 0 AND 1000000)
);
--> statement-breakpoint
CREATE INDEX "catalog_node_products_node_idx" ON "catalog_node_products" USING btree ("tenant_id", "node_id", "position");
--> statement-breakpoint
CREATE INDEX "catalog_node_products_product_idx" ON "catalog_node_products" USING btree ("product_id");
--> statement-breakpoint

ALTER TABLE "catalog_hierarchies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog_levels" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog_nodes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog_node_products" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Integrity triggers -------------------------------------------------------------------------------------------------
-- These run SECURITY DEFINER with an empty search_path so the checks see every row of the hierarchy whatever the caller's
-- row level security allows; they only ever raise an error or fill in the node's own path, never return data.
-- Errors are plain codes (CATALOG_...) that the API maps to messages.

-- A node: the level rules, the cycle rule, and the path / depth.
CREATE FUNCTION public.catalog_nodes_before_write() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_level_pos integer;
  v_parent record;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.level_id <> OLD.level_id OR NEW.hierarchy_id <> OLD.hierarchy_id OR NEW.tenant_id <> OLD.tenant_id) THEN
    RAISE EXCEPTION 'CATALOG_NODE_LEVEL_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  -- One structural change per hierarchy at a time, so two concurrent moves can never create a cycle together.
  PERFORM pg_advisory_xact_lock(hashtextextended('catalog_hierarchy:' || NEW.hierarchy_id::text, 0));

  SELECT l.position INTO v_level_pos
  FROM public.catalog_levels l
  WHERE l.id = NEW.level_id AND l.hierarchy_id = NEW.hierarchy_id AND l.tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CATALOG_LEVEL_NOT_FOUND' USING ERRCODE = '23503';
  END IF;

  IF NEW.parent_id IS NULL THEN
    IF v_level_pos <> 1 THEN
      RAISE EXCEPTION 'CATALOG_NODE_LEVEL_MISMATCH' USING ERRCODE = '23514';
    END IF;
    NEW.path_ids := ARRAY[NEW.id];
    NEW.depth := 1;
  ELSE
    SELECT p.path_ids, p.depth, pl.position AS level_pos INTO v_parent
    FROM public.catalog_nodes p
    JOIN public.catalog_levels pl ON pl.id = p.level_id
    WHERE p.id = NEW.parent_id AND p.tenant_id = NEW.tenant_id AND p.hierarchy_id = NEW.hierarchy_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CATALOG_PARENT_NOT_FOUND' USING ERRCODE = '23503';
    END IF;
    IF NEW.id = ANY (v_parent.path_ids) THEN
      RAISE EXCEPTION 'CATALOG_NODE_CYCLE' USING ERRCODE = '23514';
    END IF;
    IF v_level_pos <> v_parent.level_pos + 1 THEN
      RAISE EXCEPTION 'CATALOG_NODE_LEVEL_MISMATCH' USING ERRCODE = '23514';
    END IF;
    NEW.path_ids := v_parent.path_ids || NEW.id;
    NEW.depth := v_parent.depth + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER catalog_nodes_before_write
  BEFORE INSERT OR UPDATE OF parent_id, level_id, hierarchy_id, tenant_id ON public.catalog_nodes
  FOR EACH ROW EXECUTE FUNCTION public.catalog_nodes_before_write();
--> statement-breakpoint

-- After a node moved, its descendants get the new path (the node itself already has it).
CREATE FUNCTION public.catalog_nodes_after_move() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    UPDATE public.catalog_nodes d
    SET path_ids = NEW.path_ids || d.path_ids[array_position(d.path_ids, NEW.id) + 1 : cardinality(d.path_ids)],
        depth = NEW.depth + (cardinality(d.path_ids) - array_position(d.path_ids, NEW.id))
    WHERE d.hierarchy_id = NEW.hierarchy_id
      AND d.tenant_id = NEW.tenant_id
      AND NEW.id = ANY (d.path_ids)
      AND d.id <> NEW.id;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER catalog_nodes_after_move
  AFTER UPDATE OF parent_id ON public.catalog_nodes
  FOR EACH ROW EXECUTE FUNCTION public.catalog_nodes_after_move();
--> statement-breakpoint

-- Levels: numbered 1..n without gaps, and the order may only change when every existing parent/child relation stays valid.
-- A deferred constraint trigger, so renumbering several levels inside one transaction is judged on the final result.
CREATE FUNCTION public.catalog_levels_integrity() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_hierarchy uuid := coalesce(NEW.hierarchy_id, OLD.hierarchy_id);
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.catalog_levels WHERE hierarchy_id = v_hierarchy
    HAVING count(*) > 0 AND max(position) <> count(*)
  ) THEN
    RAISE EXCEPTION 'CATALOG_LEVEL_NUMBERING' USING ERRCODE = '23514';
  END IF;

  IF TG_OP <> 'DELETE' THEN
    IF EXISTS (
      -- nodes on this level: a root must be on level 1, any other node must be right below its parent
      SELECT 1
      FROM public.catalog_nodes n
      LEFT JOIN public.catalog_nodes p ON p.id = n.parent_id
      LEFT JOIN public.catalog_levels pl ON pl.id = p.level_id
      WHERE n.level_id = NEW.id
        AND ((n.parent_id IS NULL AND NEW.position <> 1) OR (n.parent_id IS NOT NULL AND NEW.position <> pl.position + 1))
    ) OR EXISTS (
      -- children of nodes on this level: they must be right below it
      SELECT 1
      FROM public.catalog_nodes p
      JOIN public.catalog_nodes c ON c.parent_id = p.id
      JOIN public.catalog_levels cl ON cl.id = c.level_id
      WHERE p.level_id = NEW.id AND cl.position <> NEW.position + 1
    ) THEN
      RAISE EXCEPTION 'CATALOG_LEVEL_ORDER_BLOCKED' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER catalog_levels_integrity
  AFTER INSERT OR UPDATE OF position OR DELETE ON public.catalog_levels
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.catalog_levels_integrity();
--> statement-breakpoint

-- A level that holds no products cannot be given any, and the flag cannot be switched off while products are linked.
CREATE FUNCTION public.catalog_levels_products_flag() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.can_hold_products AND NOT NEW.can_hold_products AND EXISTS (
    SELECT 1
    FROM public.catalog_nodes n
    JOIN public.catalog_node_products np ON np.node_id = n.id
    WHERE n.level_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'CATALOG_LEVEL_HAS_PRODUCTS' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER catalog_levels_products_flag
  BEFORE UPDATE OF can_hold_products ON public.catalog_levels
  FOR EACH ROW EXECUTE FUNCTION public.catalog_levels_products_flag();
--> statement-breakpoint

CREATE FUNCTION public.catalog_node_products_level_check() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.catalog_nodes n
    JOIN public.catalog_levels l ON l.id = n.level_id
    WHERE n.id = NEW.node_id AND n.tenant_id = NEW.tenant_id AND l.can_hold_products
  ) THEN
    RAISE EXCEPTION 'CATALOG_LEVEL_CANNOT_HOLD_PRODUCTS' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER catalog_node_products_level_check
  BEFORE INSERT ON public.catalog_node_products
  FOR EACH ROW EXECUTE FUNCTION public.catalog_node_products_level_check();
--> statement-breakpoint

REVOKE ALL ON FUNCTION
  public.catalog_nodes_before_write(), public.catalog_nodes_after_move(), public.catalog_levels_integrity(),
  public.catalog_levels_products_flag(), public.catalog_node_products_level_check()
  FROM public, anon, authenticated;
--> statement-breakpoint

CREATE TRIGGER catalog_hierarchies_set_updated_at BEFORE UPDATE ON public.catalog_hierarchies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER catalog_levels_set_updated_at BEFORE UPDATE ON public.catalog_levels
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER catalog_nodes_set_updated_at BEFORE UPDATE ON public.catalog_nodes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Grants: inserts are table-wide (like the other catalogue tables, 0006); updates are limited to the columns that belong to the
-- client (never tenant_id, hierarchy_id, level_id, path_ids or depth of an existing row).
REVOKE ALL ON public.catalog_hierarchies, public.catalog_levels, public.catalog_nodes, public.catalog_node_products
  FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON public.catalog_hierarchies, public.catalog_levels, public.catalog_nodes, public.catalog_node_products TO authenticated;
--> statement-breakpoint
GRANT INSERT ON public.catalog_hierarchies TO authenticated;
--> statement-breakpoint
GRANT UPDATE (name, status) ON public.catalog_hierarchies TO authenticated;
--> statement-breakpoint
GRANT INSERT ON public.catalog_levels TO authenticated;
--> statement-breakpoint
GRANT UPDATE (name, position, can_hold_products) ON public.catalog_levels TO authenticated;
--> statement-breakpoint
GRANT DELETE ON public.catalog_levels TO authenticated;
--> statement-breakpoint
-- INSERT is table-wide (Drizzle names every column in an INSERT, even the defaulted ones); path_ids and depth are always
-- overwritten by the trigger, so an inserted value can never stick.
GRANT INSERT ON public.catalog_nodes TO authenticated;
--> statement-breakpoint
GRANT UPDATE (parent_id, name, slug, description, position, status, seo_title, seo_description) ON public.catalog_nodes TO authenticated;
--> statement-breakpoint
GRANT DELETE ON public.catalog_nodes TO authenticated;
--> statement-breakpoint
GRANT INSERT ON public.catalog_node_products TO authenticated;
--> statement-breakpoint
GRANT UPDATE (position) ON public.catalog_node_products TO authenticated;
--> statement-breakpoint
GRANT DELETE ON public.catalog_node_products TO authenticated;
--> statement-breakpoint

-- Row level security: members read; owner / admin / staff write (the same roles as collection_products) ...
DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['catalog_hierarchies', 'catalog_levels', 'catalog_nodes', 'catalog_node_products'] LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_tenant_member(tenant_id))',
      t || '_select_members', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.has_tenant_role(tenant_id, array[''owner'', ''admin'', ''staff'']))',
      t || '_insert_editors', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.has_tenant_role(tenant_id, array[''owner'', ''admin'', ''staff''])) WITH CHECK (public.has_tenant_role(tenant_id, array[''owner'', ''admin'', ''staff'']))',
      t || '_update_editors', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.has_tenant_role(tenant_id, array[''owner'', ''admin'', ''staff'']))',
      t || '_delete_editors', t);
    -- ... and, on top, the member's Products permission (restrictive policies are ANDed with the ones above).
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (public.has_module_access(tenant_id, ''products'', ''read''))',
      t || '_perm_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (public.has_module_access(tenant_id, ''products'', ''write''))',
      t || '_perm_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated USING (public.has_module_access(tenant_id, ''products'', ''write'')) WITH CHECK (public.has_module_access(tenant_id, ''products'', ''write''))',
      t || '_perm_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated USING (public.has_module_access(tenant_id, ''products'', ''write''))',
      t || '_perm_delete', t);
  END LOOP;
END
$rls$;
