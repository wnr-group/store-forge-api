import { signTestToken, type SignTestTokenOptions } from './sign-test-token.js';

export interface AuthHeaders {
  Authorization: string;
  'X-Tenant-Id'?: string;
}

export function authAs(token: string, tenantId?: string): AuthHeaders {
  return {
    Authorization: `Bearer ${token}`,
    ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
  };
}

export async function authAsUser(
  options: SignTestTokenOptions,
  tenantId?: string,
): Promise<AuthHeaders> {
  const token = await signTestToken(options);
  return authAs(token, tenantId);
}
