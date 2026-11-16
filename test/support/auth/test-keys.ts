import * as jose from 'jose';

export interface TestKeyPair {
  privateKey: jose.CryptoKey;
  publicKey: jose.CryptoKey;
  publicJwk: jose.JWK;
  kid: string;
}

let cachedDefaultKeyPair: TestKeyPair | undefined;

/**
 * Generates an in-memory ES256 key pair.
 * The private key is kept strictly in memory and never written to disk or logged (AC-B-86).
 */
export async function generateTestKeyPair(
  kid = 'test-key-1',
): Promise<TestKeyPair> {
  const { privateKey, publicKey } = await jose.generateKeyPair('ES256', {
    extractable: true,
  });

  const jwk = await jose.exportJWK(publicKey);
  const publicJwk: jose.JWK = {
    ...jwk,
    kid,
    alg: 'ES256',
    use: 'sig',
  };

  return { privateKey, publicKey, publicJwk, kid };
}

/**
 * Returns a cached default test key pair for tests that don't need key rotation.
 */
export async function getDefaultTestKeyPair(): Promise<TestKeyPair> {
  if (!cachedDefaultKeyPair) {
    cachedDefaultKeyPair = await generateTestKeyPair('default-test-key');
  }
  return cachedDefaultKeyPair;
}
