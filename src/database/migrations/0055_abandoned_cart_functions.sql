-- Custom migration: the write paths of abandoned-cart tracking (phase 3 of docs/MARKETING_ANALYTICS_PLAN.md).
--
-- `abandoned_carts` has no INSERT/UPDATE/DELETE grant for anyone: rows change only through these SECURITY DEFINER functions.
--   * checkpoint_abandoned_cart(): the storefront saves (or refreshes) the cart of a shopper who gave an email. One row per browser
--     cart (tenant + SHA-256 of the cart id). Granted to the tenant-pinned checkout role only, and refuses any other tenant.
--   * open_cart_recovery(): a shopper follows a recovery link. Finds the cart by the SHA-256 of the token, counts the click and returns
--     what is needed to rebuild the cart. A cart that was already bought, or is older than the recovery window, is not returned.
--   * mark_cart_converted(): an order was placed. A cart that had not yet counted as abandoned is deleted (the shopper never left, there
--     is nothing to recover); one that had is marked recovered and linked to the order.
--   * delete_abandoned_cart(): the owner erases a cart record (a customer's request, or housekeeping).
-- Whether a cart counts as abandoned is not stored: it is "no activity for the tenant's threshold" (tenant_marketing_settings, 60 minutes
-- until saved), worked out when read, so changing the threshold applies to carts already waiting. `abandoned_at` / the 'abandoned' and
-- 'expired' statuses are reserved for a future sweep that sends reminders.

CREATE FUNCTION public.checkpoint_abandoned_cart(
  p_tenant uuid, p_id uuid, p_cart_key_hash text, p_token_hash text, p_email text, p_phone text, p_name text,
  p_consent boolean, p_items jsonb, p_item_count integer, p_value bigint, p_currency text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_email text := lower(trim(p_email));
  v_customer uuid;
  v_id uuid;
BEGIN
  IF p_tenant IS DISTINCT FROM public.pinned_tenant_id() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT id INTO v_customer FROM public.customers WHERE tenant_id = p_tenant AND lower(email) = v_email LIMIT 1;
  INSERT INTO public.abandoned_carts (id, tenant_id, cart_key_hash, recovery_token_hash, customer_id, email, phone, customer_name,
      marketing_consent, items, item_count, cart_value_minor, currency)
    VALUES (p_id, p_tenant, p_cart_key_hash, p_token_hash, v_customer, v_email, p_phone, p_name, p_consent, p_items, p_item_count, p_value, p_currency)
  ON CONFLICT (tenant_id, cart_key_hash) DO UPDATE SET
    customer_id = EXCLUDED.customer_id, email = EXCLUDED.email, phone = EXCLUDED.phone, customer_name = EXCLUDED.customer_name,
    marketing_consent = EXCLUDED.marketing_consent, items = EXCLUDED.items, item_count = EXCLUDED.item_count,
    cart_value_minor = EXCLUDED.cart_value_minor, currency = EXCLUDED.currency,
    -- The shopper is back: the cart is live again (a cart that was recovered starts a new shopping session).
    status = 'active', last_activity_at = now(), abandoned_at = NULL, recovered_at = NULL, recovered_order_id = NULL, updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.checkpoint_abandoned_cart(uuid, uuid, text, text, text, text, text, boolean, jsonb, integer, bigint, text)
  FROM public, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.checkpoint_abandoned_cart(uuid, uuid, text, text, text, text, text, boolean, jsonb, integer, bigint, text)
  TO storeforge_checkout;
--> statement-breakpoint

CREATE FUNCTION public.open_cart_recovery(p_tenant uuid, p_token_hash text)
RETURNS TABLE (items jsonb, email text, customer_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_days integer;
  v_id uuid;
BEGIN
  IF p_tenant IS DISTINCT FROM public.pinned_tenant_id() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT coalesce((SELECT recovery_link_days FROM public.tenant_marketing_settings WHERE tenant_id = p_tenant), 14) INTO v_days;
  SELECT c.id INTO v_id FROM public.abandoned_carts c
    WHERE c.tenant_id = p_tenant AND c.recovery_token_hash = p_token_hash AND c.status <> 'recovered'
      AND c.last_activity_at > now() - make_interval(days => v_days)
    FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.abandoned_carts SET recovery_clicks = recovery_clicks + 1, updated_at = now() WHERE id = v_id;
  RETURN QUERY SELECT c.items, c.email, c.customer_name FROM public.abandoned_carts c WHERE c.id = v_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.open_cart_recovery(uuid, text) FROM public, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.open_cart_recovery(uuid, text) TO storeforge_checkout;
--> statement-breakpoint

CREATE FUNCTION public.mark_cart_converted(p_tenant uuid, p_order_number integer, p_cart_key_hash text, p_email text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order uuid;
  v_threshold integer;
  v_email text := nullif(lower(trim(p_email)), '');
  v_count integer := 0;
BEGIN
  IF p_tenant IS DISTINCT FROM public.pinned_tenant_id() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT id INTO v_order FROM public.orders WHERE tenant_id = p_tenant AND order_number = p_order_number;
  IF v_order IS NULL THEN RETURN 0; END IF;
  SELECT coalesce((SELECT abandonment_threshold_minutes FROM public.tenant_marketing_settings WHERE tenant_id = p_tenant), 60) INTO v_threshold;

  -- Carts that had not counted as abandoned yet: the shopper never left, so there is nothing worth keeping.
  DELETE FROM public.abandoned_carts
    WHERE tenant_id = p_tenant AND status = 'active' AND last_activity_at > now() - make_interval(mins => v_threshold)
      AND (cart_key_hash = p_cart_key_hash OR (v_email IS NOT NULL AND email = v_email));
  -- Carts that had: the shopper came back and bought.
  UPDATE public.abandoned_carts
    SET status = 'recovered', recovered_at = now(), recovered_order_id = v_order, updated_at = now()
    WHERE tenant_id = p_tenant AND status <> 'recovered'
      AND (cart_key_hash = p_cart_key_hash OR (v_email IS NOT NULL AND email = v_email));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mark_cart_converted(uuid, integer, text, text) FROM public, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mark_cart_converted(uuid, integer, text, text) TO storeforge_checkout;
--> statement-breakpoint

CREATE FUNCTION public.delete_abandoned_cart(p_tenant uuid, p_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.has_module_access(p_tenant, 'orders', 'write') OR session_user = 'authenticator' THEN RETURN 'forbidden'; END IF;
  DELETE FROM public.abandoned_carts WHERE tenant_id = p_tenant AND id = p_id;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  RETURN 'ok';
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.delete_abandoned_cart(uuid, uuid) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.delete_abandoned_cart(uuid, uuid) TO authenticated;
