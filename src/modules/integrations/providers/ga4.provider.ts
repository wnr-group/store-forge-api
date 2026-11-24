import {
  pickFields,
  type IntegrationProvider,
  type ParseResult,
  type ProviderField,
  type TestCheck,
} from './integration-provider.js';

/** A GA4 Measurement ID: `G-` and ten letters or digits (always capitals). */
export const GA4_MEASUREMENT_ID = /^G-[A-Z0-9]{10}$/;

const FIELDS: readonly ProviderField[] = [
  {
    key: 'measurementId',
    label: 'Measurement ID',
    placeholder: 'G-XXXXXXXXXX',
    help: 'Find it in Google Analytics under Admin, Data streams, your web stream. It starts with G-.',
  },
];

const TAG_URL = 'https://www.googletagmanager.com/gtag/js';

/**
 * Google Analytics 4, loaded in the shopper's browser with Google's own tag (gtag.js) once the shopper has agreed to analytics.
 * Events are sent by the browser (page_view, view_item, add_to_cart, begin_checkout, purchase). Server-side events (the Measurement
 * Protocol, which also carries `refund`) need an API secret and are a later addition: the secret has a place in this table already.
 */
export class Ga4Provider implements IntegrationProvider {
  readonly code = 'ga4';
  readonly name = 'Google Analytics 4';
  readonly description =
    'Measure visits, product views, bags, checkouts and purchases in your own Google Analytics property.';
  readonly fields = FIELDS;

  parse(input: Record<string, unknown>): ParseResult {
    const { values, errors } = pickFields(FIELDS, input);
    const id = (values.measurementId ?? '').toUpperCase();
    if (!errors.measurementId && !GA4_MEASUREMENT_ID.test(id))
      errors.measurementId =
        'Enter a Measurement ID like G-ABCDE12345 (G- and 10 letters or digits). A Universal Analytics ID (UA-) or a Google Ads ID (AW-) will not work here.';
    if (Object.keys(errors).length > 0) return { ok: false, errors };
    return { ok: true, config: { measurementId: id } };
  }

  async test(config: Readonly<Record<string, string>>): Promise<TestCheck[]> {
    const id = config.measurementId ?? '';
    const checks: TestCheck[] = [];
    const formatOk = GA4_MEASUREMENT_ID.test(id);
    checks.push({
      name: 'Measurement ID format',
      ok: formatOk,
      message: formatOk
        ? 'The ID has the right shape.'
        : 'This is not a GA4 Measurement ID.',
    });
    if (!formatOk) return checks;

    // Only Google's tag host is ever contacted, with an ID that has just passed the strict format check.
    try {
      const res = await fetch(`${TAG_URL}?id=${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(6000),
        headers: { accept: 'application/javascript, */*' },
      });
      const body = res.ok ? await res.text() : '';
      const served = res.ok && body.includes(id);
      checks.push({
        name: 'Google tag',
        ok: served,
        message: served
          ? "Google serves its tag for this ID, so shoppers' browsers will be able to load it."
          : `Google did not serve a tag for this ID (HTTP ${res.status}).`,
      });
    } catch {
      checks.push({
        name: 'Google tag',
        ok: false,
        message:
          'Google could not be reached from the server just now. This does not mean the ID is wrong; try again in a moment.',
      });
    }
    return checks;
  }
}
