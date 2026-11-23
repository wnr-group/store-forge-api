import { Inject, Injectable } from '@nestjs/common';
import {
  CarrierError,
  SHIPPING_PROVIDERS,
  type CredentialField,
  type IntegrationStatus,
  type ProviderCapabilities,
  type ShippingProvider,
} from './shipping-provider.js';

/** What the dashboard may show about a carrier: no behaviour, no credentials. */
export interface ProviderDescription {
  code: string;
  name: string;
  capabilities: ProviderCapabilities;
  integrationStatus: IntegrationStatus;
  integrationNotes: string;
  credentialFields: readonly CredentialField[];
}

/**
 * The one door to the carriers. Order and shipping services ask the registry for a provider by its code and then speak only the
 * `ShippingProvider` interface; they never import an adapter. Adding a carrier means adding its class to the module's provider
 * list: the registry, and everything built on it, picks it up.
 */
@Injectable()
export class ShippingProviderRegistry {
  private readonly byCode = new Map<string, ShippingProvider>();

  constructor(@Inject(SHIPPING_PROVIDERS) providers: ShippingProvider[]) {
    for (const p of providers) {
      if (this.byCode.has(p.code))
        throw new Error(`Two shipping providers share the code "${p.code}".`);
      this.byCode.set(p.code, p);
    }
  }

  /** Throws `invalid_input` for a code nobody registered (for example a connection saved for a carrier since removed). */
  get(code: string): ShippingProvider {
    const provider = this.byCode.get(code);
    if (!provider)
      throw new CarrierError(
        'invalid_input',
        'That shipping carrier is not supported.',
      );
    return provider;
  }

  has(code: string): boolean {
    return this.byCode.has(code);
  }

  codes(): string[] {
    return [...this.byCode.keys()];
  }

  describe(): ProviderDescription[] {
    return [...this.byCode.values()].map((p) => ({
      code: p.code,
      name: p.name,
      capabilities: p.capabilities,
      integrationStatus: p.integrationStatus,
      integrationNotes: p.integrationNotes,
      credentialFields: p.credentialFields,
    }));
  }
}
