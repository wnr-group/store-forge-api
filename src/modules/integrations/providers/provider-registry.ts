import { Ga4Provider } from './ga4.provider.js';
import type { IntegrationProvider } from './integration-provider.js';

/** Every integration the application knows. Adding one is adding it here; nothing else needs rewriting. */
const PROVIDERS: readonly IntegrationProvider[] = [new Ga4Provider()];

export const listProviders = (): readonly IntegrationProvider[] => PROVIDERS;

export const findProvider = (code: string): IntegrationProvider | undefined =>
  PROVIDERS.find((p) => p.code === code);
