/**
 * What a marketing / analytics integration is, as far as the rest of the application cares. A new provider (Meta Pixel now,
 * later Google Ads, TikTok, Pinterest, Snapchat ...) is one file that implements this and one line in the registry: the
 * dashboard routes, validation flow, enable / disable rules, audit log and the public tracking endpoint do not change.
 *
 * Only PUBLIC identifiers live in `config` (they are printed in every page of the store anyway). A provider that needs a real secret
 * (a Conversions API token, a Measurement Protocol API secret) will keep it in the encrypted secret columns of the same table, which
 * no dashboard or storefront route can read.
 */
export interface ProviderField {
  key: string;
  label: string;
  placeholder: string;
  help: string;
}

export type ParseResult =
  | { ok: true; config: Record<string, string> }
  | { ok: false; errors: Record<string, string> };

export interface TestCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface IntegrationProvider {
  /** Stored in `marketing_integrations.provider_code`: lower-case letters, digits and underscores. */
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly fields: readonly ProviderField[];
  /** Checks and normalizes what the owner typed. Unknown keys are an error: nothing is stored that was not asked for. */
  parse(input: Record<string, unknown>): ParseResult;
  /** Checks done with the outside world; never throws, never receives or returns a secret. */
  test(config: Readonly<Record<string, string>>): Promise<TestCheck[]>;
}

/** Shared by providers: exactly the declared keys, each a short string. */
export function pickFields(
  fields: readonly ProviderField[],
  input: Record<string, unknown>,
): { values: Record<string, string>; errors: Record<string, string> } {
  const known = new Set(fields.map((f) => f.key));
  const errors: Record<string, string> = {};
  const values: Record<string, string> = {};
  for (const key of Object.keys(input))
    if (!known.has(key)) errors[key] = 'This setting does not exist.';
  for (const f of fields) {
    const v = input[f.key];
    if (typeof v !== 'string') errors[f.key] = `Enter your ${f.label}.`;
    else values[f.key] = v.trim();
  }
  return { values, errors };
}
