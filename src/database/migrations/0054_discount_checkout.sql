-- Custom migration: what the public checkout needs to apply and record a discount code (phase 2 of docs/MARKETING_ANALYTICS_PLAN.md).
--
-- * The pinned checkout role may read the tenant's campaigns and collection membership (to decide a code's scope and campaign state).
-- * discount_usage(): how often a code is in use, and by one customer. "In use" means the order is not cancelled or failed, so a
--   code whose order never completed is available again. `discount_codes.redemption_count` is NOT used for limits: it is the number
--   of redemptions ever recorded (a statistic), kept by redeem_discount().
-- * redeem_discount(): the only write path of redemptions. It locks the code row, re-checks active, window and both limits under the
--   lock (so two simultaneous orders cannot both take the last use) and records the redemption. It refuses any tenant but the pinned
--   one and is executable by the checkout role alone. The checkout calls it inside the order transaction: a refusal rolls the order back.

GRANT SELECT ON "promotional_campaigns", "collection_products" TO storeforge_checkout;
--> statement-breakpoint
CREATE POLICY pc_checkout_pinned ON public.promotional_campaigns FOR SELECT TO storeforge_checkout
  USING (tenant_id = public.pinned_tenant_id());
--> statement-breakpoint
CREATE POLICY collection_products_checkout_pinned ON public.collection_products FOR SELECT TO storeforge_checkout
  USING (tenant_id = public.pinned_tenant_id());
--> statement-breakpoint

CREATE FUNCTION public.discount_usage(p_tenant uuid, p_discount uuid, p_customer_key text)
RETURNS TABLE (in_use integer, by_customer integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT count(*)::integer,
         (count(*) FILTER (WHERE r.customer_key = p_customer_key))::integer
  FROM public.discount_redemptions r
  JOIN public.orders o ON o.tenant_id = r.tenant_id AND o.id = r.order_id
  WHERE r.tenant_id = p_tenant AND p_tenant = public.pinned_tenant_id() AND r.discount_id = p_discount
    AND o.status NOT IN ('cancelled', 'failed')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.discount_usage(uuid, uuid, text) FROM public, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.discount_usage(uuid, uuid, text) TO storeforge_checkout;
--> statement-breakpoint

CREATE FUNCTION public.redeem_discount(p_tenant uuid, p_discount uuid, p_order uuid, p_customer_key text, p_amount bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  d public.discount_codes%ROWTYPE;
  v_in_use integer;
  v_by_customer integer;
BEGIN
  IF p_tenant IS DISTINCT FROM public.pinned_tenant_id() THEN RETURN 'forbidden'; END IF;
  IF p_amount < 0 OR p_customer_key IS NULL OR char_length(p_customer_key) NOT BETWEEN 1 AND 320 THEN RETURN 'invalid'; END IF;
  -- The order must be this tenant's own.
  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE tenant_id = p_tenant AND id = p_order) THEN RETURN 'invalid'; END IF;

  SELECT * INTO d FROM public.discount_codes WHERE tenant_id = p_tenant AND id = p_discount FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF NOT d.is_active THEN RETURN 'inactive'; END IF;
  IF d.starts_at IS NOT NULL AND d.starts_at > now() THEN RETURN 'not_started'; END IF;
  IF d.expires_at IS NOT NULL AND d.expires_at <= now() THEN RETURN 'expired'; END IF;

  SELECT count(*)::integer, (count(*) FILTER (WHERE r.customer_key = p_customer_key))::integer
    INTO v_in_use, v_by_customer
  FROM public.discount_redemptions r
  JOIN public.orders o ON o.tenant_id = r.tenant_id AND o.id = r.order_id
  WHERE r.tenant_id = p_tenant AND r.discount_id = p_discount AND o.status NOT IN ('cancelled', 'failed');
  IF d.usage_limit IS NOT NULL AND v_in_use >= d.usage_limit THEN RETURN 'usage_limit'; END IF;
  IF d.per_customer_limit IS NOT NULL AND v_by_customer >= d.per_customer_limit THEN RETURN 'customer_limit'; END IF;

  INSERT INTO public.discount_redemptions (tenant_id, discount_id, order_id, code, customer_key, discount_minor)
    VALUES (p_tenant, p_discount, p_order, d.code, p_customer_key, p_amount);
  UPDATE public.discount_codes SET redemption_count = redemption_count + 1 WHERE tenant_id = p_tenant AND id = p_discount;
  RETURN 'ok';
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.redeem_discount(uuid, uuid, uuid, text, bigint) FROM public, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.redeem_discount(uuid, uuid, uuid, text, bigint) TO storeforge_checkout;
