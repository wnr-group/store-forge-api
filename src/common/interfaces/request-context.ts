import type { Request } from 'express';
import type {
  MemberPermissions,
  MembershipRole,
} from '../../database/schema/enums.js';

/** Identity taken ONLY from a verified Supabase access token. Nothing here comes from the request body. */
export interface AuthUser {
  id: string;
  email: string | null;
  /** The verified bearer token, forwarded to Supabase (Storage, password change) so the user's own policies apply. */
  token: string;
}

/** The caller's authorised organization, resolved from Postgres memberships (never trusted from the client). */
export interface OrgContext {
  userId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: MembershipRole;
  permissions: MemberPermissions;
}

export type PlatformLevel = 'super_admin' | 'admin';

export interface AuthenticatedRequest extends Request {
  user: AuthUser;
  org?: OrgContext;
  platformLevel?: PlatformLevel;
}
