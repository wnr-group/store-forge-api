# GST (Phase 10)

How StoreForge charges Indian GST at checkout, what it saves, and what it does not do.

## What an Owner sets up

1. **GST settings** (`PUT /tax/settings`, Owner or a member with write access to the store settings): the GSTIN, whether prices
   already include GST, the default rate, and whether delivery and cash-on-delivery charges are taxed (and at what rate).
   - The GSTIN is checked for shape and its check character. Its first two digits are the seller's **state**.
   - Turning GST on needs a valid GSTIN. **Until it is on, no tax is charged** (organizations that never set it up behave exactly as before).
2. **Per product** (`taxRateBps`, `hsnCode` on the product): a GST rate (0, 0.25, 3, 5, 12, 18, 28 or 40 per cent, stored in basis
   points, 1800 = 18%) and an HSN/SAC code (4, 6 or 8 digits). A product with no rate uses the default rate. `0` is a real rate
   (zero-rated), not "unset". StoreForge checks the rate is a real GST rate; **it does not classify products**: the Owner (or their
   accountant) chooses the correct rate and code.

## How tax is worked out

All on the server, inside the order transaction, from the database as it is at that moment. Nothing about price or tax comes from the browser.

- **Place of supply** is the delivery state. Same state as the seller: **CGST + SGST** (half each; **UTGST** instead of SGST for the
  union territories without a legislature: Chandigarh, Dadra & Nagar Haveli and Daman & Diu, Lakshadweep, Andaman & Nicobar, Ladakh).
  Any other state: **IGST**.
- **Each line is taxed on its own**: every item, the delivery charge and the cash-on-delivery charge (the last two at the charges
  rate, SAC 996812 "courier services"). The order's tax is the **sum of its lines**, never a separately rounded total; rounding is
  half-up in paise, and CGST always equals SGST.
- **Prices that include tax**: the tax is taken out of the price (`rate / (100% + rate)`); the order total does not change. Otherwise
  the tax is added on top.
- **Saved with the order, as it was**: `orders` carries the regime, CGST/SGST/IGST, the seller's GSTIN and state and the place of
  supply; `order_tax_lines` has one row per taxed line (taxable value, rate, split, HSN). Later changes to settings or products never
  rewrite an existing order. The database refuses an order whose tax is not CGST+SGST+IGST, or a line that does not add up.
- **Quote before ordering**: `POST /public/stores/:slug/checkout/quote` runs the same code for a cart, address, delivery option
  and payment method, so the storefront can show the real total. It is not a promise; the order is priced again when placed.

## Reports

`GET /tax/report?from=&to=` (needs orders read access): GST by rate for orders in a period (India dates, at most 366 days), split into
CGST, SGST and IGST, as the orders recorded it. Cancelled, failed and still-unpaid orders are excluded. The order detail and the
shopper's order view both show the line-by-line tax.

## Known limits (what this is not)

- **Not tax or legal advice, not an invoice.** There is no tax-invoice document or numbering yet, and no GSTR filing export.
- **Rates are the Owner's responsibility** (the allowed set can change with the law; it is one constant and one database check).
- **Refunds and returns do not adjust the saved tax** (no credit notes). A returned or cancelled order drops out of the report; a
  partly refunded one keeps its full tax.
- **One rate per product**, no cess, no composition-scheme or e-commerce-operator (TCS) handling, no reverse charge, no
  export/SEZ treatment, no B2B (buyer GSTIN) invoicing, no discounts or coupons beyond sharing an existing discount across lines.
- **Delivery and cash-on-delivery charges use one fixed rate** (default 18%); GST law taxes a composite supply at the principal
  supply's rate, which this does not model.
- **Place of supply is always the delivery state** (correct for goods; services may differ).
- The GSTIN is checked for form only; StoreForge does not look it up with the GST portal.
- Product import does not carry tax rate or HSN yet.
