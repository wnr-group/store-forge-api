import type { AdminAuditEntityType } from '../../../database/schema/admin-audit.js';

/**
 * Every action a Platform Admin can leave in the audit log (ported from lib/admin/audit.ts).
 * The database only checks the shape (`entity.verb`); this list is the single source of truth for what the API records.
 * Organization deletion IS logged (unlike the Next.js app): the entry keeps the organization's name and key facts, since the tenant itself is gone.
 */
export const AUDIT_ACTIONS = [
  'organization.created',
  'organization.updated',
  'organization.suspended',
  'organization.reactivated',
  'organization.deleted',
  'store.updated',
  'store.studio_rollout_changed',
  'team_member.added',
  'team_member.disabled',
  'team_member.reactivated',
  'team_member.removed',
  'ownership.transferred',
  'platform_admin.added',
  'platform_admin.removed',
  'platform_admin.role_changed',
  'platform_settings.updated',
  'plan.created',
  'plan.updated',
  'plan.activated',
  'plan.deactivated',
  'plan.default_changed',
  'subscription.created',
  'subscription.changed',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditEntry = {
  action: AuditAction;
  entityType: AdminAuditEntityType;
  entityId?: string | null;
  organizationId?: string | null;
  description: string;
  /** Plain facts about the change. Never put credentials here (the database strips obvious ones as a second line of defence). */
  previous?: Record<string, unknown> | null;
  next?: Record<string, unknown> | null;
};
