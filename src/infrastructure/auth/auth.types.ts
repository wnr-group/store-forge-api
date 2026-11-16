import type { MemberPermissions } from '../database/schema/enums.js';
import type { Role } from './generated/permissions.js';

export interface AuthenticatedUser {
  userId: string;
  role: string;
  email?: string;
  appMetadata?: Record<string, unknown>;
  userMetadata?: Record<string, unknown>;
}

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: Role;
  permissions: MemberPermissions;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthenticatedUser;
      tenant?: TenantContext;
    }
  }
}
