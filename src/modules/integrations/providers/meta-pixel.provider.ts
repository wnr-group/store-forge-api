import {
  pickFields,
  type IntegrationProvider,
  type ParseResult,
  type ProviderField,
  type TestCheck,
} from './integration-provider.js';

/** A Meta Pixel ID is a number of 15 or 16 digits. */
export const META_PIXEL_ID = /^[0-9]{15,16}$/;

const FIELDS: readonly ProviderField[] = [
  {
    key: 'pixelId',
    label: 'Pixel ID',
    placeholder: '123456789012345',
    help: 'Find it in Meta Events Manager: choose your data source (the Pixel); the ID is the number under its name.',
  },
];

const SCRIPT_URL = 'https://connect.facebook.net/en_US/fbevents.js';

/**
 * Meta Pixel, loaded in the shopper's browser with Meta's own script (fbevents.js) once the shopper has agreed to analytics.
 * Standard events are sent by the browser (PageView, ViewContent, AddToCart, InitiateCheckout, Purchase), each with an event id so a
 * server-side Conversions API can later report the same event and Meta will count it once. The Conversions API itself is not
 * built: it needs an access token, which would be kept in this table's encrypted secret columns and never reach a browser.
 */
export class MetaPixelProvider implements IntegrationProvider {
  readonly code = 'meta_pixel';
  readonly name = 'Meta Pixel';
  readonly description =
    'Measure product views, bags, checkouts and purchases for your Meta (Facebook and Instagram) advertising.';
  readonly fields = FIELDS;
  readonly testNote =
    'This confirms the ID is well formed and that the Meta script can be loaded. It sends nothing to your Pixel. Meta offers no public way to confirm a Pixel belongs to you: open Test events in Meta Events Manager, then visit your store and agree to analytics to see the events arrive.';

  parse(input: Record<string, unknown>): ParseResult {
    const { values, errors } = pickFields(FIELDS, input);
    // Digits only: a pasted ID often carries spaces or dashes that are not part of it.
    const id = (values.pixelId ?? '').replace(/[\s-]/g, '');
    if (!errors.pixelId && !META_PIXEL_ID.test(id))
      errors.pixelId =
        'Enter your Pixel ID: a number of 15 or 16 digits. It is not your Meta ad account ID or your Business ID.';
    if (Object.keys(errors).length > 0) return { ok: false, errors };
    return { ok: true, config: { pixelId: id } };
  }

  async test(config: Readonly<Record<string, string>>): Promise<TestCheck[]> {
    const id = config.pixelId ?? '';
    const checks: TestCheck[] = [];
    const formatOk = META_PIXEL_ID.test(id);
    checks.push({
      name: 'Pixel ID format',
      ok: formatOk,
      message: formatOk
        ? 'The ID has the right shape.'
        : 'This is not a Meta Pixel ID.',
    });
    if (!formatOk) return checks;

    // Meta's script is the same for every Pixel, so this proves shoppers' browsers can load it. Nothing is sent to the Pixel: a
    // test must never put a fake visit into someone's advertising data.
    try {
      const res = await fetch(SCRIPT_URL, {
        signal: AbortSignal.timeout(6000),
        headers: { accept: 'application/javascript, */*' },
      });
      const body = res.ok ? await res.text() : '';
      const served = res.ok && body.includes('fbq');
      checks.push({
        name: 'Meta script',
        ok: served,
        message: served
          ? "Meta's Pixel script can be loaded, so shoppers' browsers will be able to run it."
          : `Meta's Pixel script could not be loaded (HTTP ${res.status}).`,
      });
    } catch {
      checks.push({
        name: 'Meta script',
        ok: false,
        message:
          'Meta could not be reached from the server just now. This does not mean the ID is wrong; try again in a moment.',
      });
    }
    return checks;
  }
}
