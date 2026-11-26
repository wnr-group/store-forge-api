-- Custom migration: refund totals per order, for the sales reports (phase 4 of docs/MARKETING_ANALYTICS_PLAN.md).
--
-- `refunds` is readable by the Owner only (0048): it carries Razorpay ids, reasons and who asked. A member who may see orders and sales
-- figures would therefore see no refunds at all, and every net figure would be overstated for them. This function gives such members
-- exactly what an order already shows them (that it was refunded) and nothing else: the processed amount per order, no ids, no reasons.
-- It re-checks orders-read access on the tenant it is asked about, so it returns nothing for any other organization.

CREATE FUNCTION public.order_refund_totals(p_tenant uuid)
RETURNS TABLE (order_id uuid, refunded_minor bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT r.order_id, sum(r.amount_minor)::bigint
  FROM public.refunds r
  WHERE r.tenant_id = p_tenant AND r.status = 'processed'
    AND public.has_module_access(p_tenant, 'orders', 'read') AND session_user <> 'authenticator'
  GROUP BY r.order_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.order_refund_totals(uuid) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.order_refund_totals(uuid) TO authenticated;
