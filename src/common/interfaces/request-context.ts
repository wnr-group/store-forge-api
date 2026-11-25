import type { Request } from 'express';
import type {
  PlatformAdminRole,
  MemberCapability,
  MemberPermissions,
  MembershipRole,
} from '../../database/schema/enums.js';

/** Identity taken ONLY from a verified Supabase access token. Nothing here comes from the request body. */
export interface AuthUser {
  id: string;
  email: string | null;
  /** The verified bearer token, forwarded to Supabase (Storage, password change) so the user's own policies apply. */
  token: string;
  /** Unix seconds at which the verified access token expires. */
  expiresAt?: number;
  fullName?: string | null;
}

/** The caller's authorised organization, resolved from Postgres memberships (never trusted from the client). */
export interface OrgContext {
  userId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  tenantPublicId: string;
  role: MembershipRole;
  permissions: MemberPermissions;
  capabilities: MemberCapability[];
}

export type PlatformLevel = PlatformAdminRole;

export interface AuthenticatedRequest extends Request {
  user: AuthUser;
  /** How the access token arrived: the Authorization header, or the HttpOnly session cookie. */
  authVia?: 'bearer' | 'cookie';
  org?: OrgContext;
  platformLevel?: PlatformLevel;
}
