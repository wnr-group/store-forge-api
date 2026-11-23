# Shipping carrier integrations

All carriers sit behind one interface (`src/modules/shipping/providers/shipping-provider.ts`). The rest of the application only
ever uses `ShippingProviderRegistry`; nothing outside `modules/shipping` imports an adapter (a test enforces this). Every
network call goes through `CarrierHttp` (timeouts, retries for reads only, no secret in any error).

**Adding a carrier:** write a class implementing `ShippingProvider`, add it to `shipping.module.ts`. Nothing else changes.

## How far each adapter has been checked

The adapters are tested against **fake carrier servers** that reproduce the shapes written down below. Those tests prove our
code (request building, response parsing, error handling, safety rules). They cannot prove the carrier. **None of the three has
been run against a real carrier account.** Do that with each carrier's sandbox before enabling it for a real store.

| | Shiprocket | Delhivery | Blue Dart |
|---|---|---|---|
| Status in code | `partially_documented` | `partially_documented` | `unverified` |
| Auth | login with an API user, token cached 8 days, replaced once on a refusal | `Authorization: Token <apiToken>` | JWT from an authenticator call (ClientID / clientSecret), replaced once on a refusal |
| Serviceability | yes (courier list for the lane) | yes (PIN code lookup) | **no** (left unsupported rather than guessed) |
| Rate quotes | yes (per courier, with delivery days) | yes, **approximate**, no delivery days | **no** (rates follow the tenant's own contract) |
| Create shipment | yes (order, then courier/AWB; resumable) | yes (idempotent: a "duplicate" answer is resolved by looking up our reference) | yes (waybill; the label comes back with it) |
| Cancel | yes | yes (only an explicit yes counts) | yes (only an explicit "no error" counts) |
| Label | yes (PDF link) | yes (PDF link) | **only at creation** (cannot be re-fetched) |
| Tracking | yes | yes | yes |
| Carrier webhooks | available at the carrier, **receiver not built yet** | available at the carrier, **receiver not built yet** | not offered |

### What was confirmed from the carriers' published documentation

- **Shiprocket:** base URL `https://apiv2.shiprocket.in/v1/external` and the paths `auth/login`, `courier/serviceability/`,
  `orders/create/adhoc`, `courier/assign/awb`, `courier/generate/label`, `courier/track/awb/{awb}`.
- **Delhivery:** production `https://track.delhivery.com` and staging `https://staging-express.delhivery.com`; paths
  `c/api/pin-codes/json/`, `api/cmu/create.json` (body `format=json&data=...`), `api/p/packing_slip?wbns=`, `api/p/edit`
  (`cancellation`, `waybill`), `api/v1/packages/json/` (`waybill`, `ref_ids`), the shipping-charge API (`md`, `cgm`, `o_pin`,
  `d_pin`, `ss`; "approximate"); tracking structure `ShipmentData > Shipment > Status / Scans > ScanDetail`.
- **Blue Dart:** the production waybill address
  `https://apigateway.bluedart.com/in/transportation/waybill/v1/GenerateWayBill`, that every call needs a JWT from an
  authenticator call made with the customer's API key and secret, and that a waybill answer carries `AWBNo` and
  `AWBPrintContent`.

### What is NOT confirmed (written from the known shape of each API; check in the sandbox)

- **Shiprocket:** exact request/response field names (for example `available_courier_companies`, `awb_assign_status`,
  `label_created`, `tracking_data`), and the cancel endpoints `orders/cancel/shipment/awbs` and `orders/cancel`.
- **Delhivery:** the `Token` authorization header, the create-response fields (`packages[].status/waybill/remarks`), the cancel
  answer, the shape of the packing-slip answer (a `pdf_download_link` is looked for), and the rate answer (`total_amount`).
- **Blue Dart:** nearly everything else: the token address and header names, the whole waybill request body, the cancel and
  tracking calls, the sandbox address, what `ProductCode` / `SubProductCode` values a given contract allows.

Where a shape is not as expected the adapters fail with `invalid_response`. They never report a serviceable lane, a booked
shipment or a cancellation on a guess. The unverified Blue Dart request is built in one function (`buildWaybillRequest`) so a
sandbox correction is a small, local change.

## Sandbox checklist (per carrier)

1. Create the carrier test account / API user. Put the details into the connection form (Phase 7).
2. `validateCredentials` returns valid; a wrong secret returns "not valid".
3. A serviceability / rate call for a real lane returns sensible values.
4. Book a COD and a prepaid shipment; the AWB appears in the carrier's panel.
5. Fetch the label; open the PDF.
6. Track the AWB; cancel one shipment before pickup.
7. Compare each real answer with the fake answers in `test/shipping-*.spec.ts` and fix any field that differs.

## How a tenant's carrier accounts are stored (Phase 7)

- One connection per tenant and carrier (`tenant_carrier_connections`). Each tenant uses **its own** carrier account; there is no
  platform-wide carrier login.
- **Secret** fields (as declared by each adapter's `credentialFields`) are encrypted into one AES-256-GCM blob bound to the tenant
  id, so a row copied to another tenant cannot be opened. They are never returned by any route; the dashboard only learns *which*
  secrets are saved. Non-secret settings (pickup location name, environment...) are stored readable so they can be shown.
- Only the tenant-pinned checkout role can read the ciphertext, through `get_carrier_credentials()`; signed-in users, including
  the Owner, cannot. `carrier-credentials.ts` is the second reviewed place that decrypts (the first is the Razorpay reader); a
  static test pins both, and pins which service may use this one.
- **Lifecycle:** connect -> check (`verify`) -> turn on -> (optionally) make default. Changing any setting turns the carrier off
  and asks for a new check (a database trigger, so no code path can skip it). A failed check turns it off. A carrier whose
  integration is `unverified` also needs an explicit acknowledgement to be turned on.
- **History:** every change is recorded (who, what, when) with the *names* of the settings changed, never their values.
- **Preferences:** manual or automatic selection, and the strategy (lowest cost, fastest, or the default carrier first). Phase 8
  applies them.
- Owner only (`carriers:manage`).
