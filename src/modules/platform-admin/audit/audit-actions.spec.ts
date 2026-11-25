import { describe, expect, it } from 'vitest';
import { ADMIN_AUDIT_ENTITY_TYPES } from '../../../database/schema/admin-audit.js';
import { AUDIT_ACTIONS } from './audit-actions.js';

describe('audit action catalogue', () => {
  it('uses the entity.verb shape the database enforces, and lists each action once', () => {
    for (const a of AUDIT_ACTIONS) expect(a, a).toMatch(/^[a-z_]+\.[a-z_]+$/);
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it('keeps the entity types the database accepts in step with the list in code', () => {
    expect(new Set(ADMIN_AUDIT_ENTITY_TYPES).size).toBe(
      ADMIN_AUDIT_ENTITY_TYPES.length,
    );
    for (const t of [
      'organization',
      'plan',
      'subscription',
      'entitlement',
      'invoice',
      'payment',
      'billing_settings',
      'platform_admin',
    ])
      expect(ADMIN_AUDIT_ENTITY_TYPES).toContain(t);
  });

  it('covers every kind of change the platform makes', () => {
    for (const a of [
      'organization.created',
      'organization.suspended',
      'organization.reactivated',
      'organization.deleted',
      'subscription.created',
      'subscription.changed',
      'plan.created',
      'plan.updated',
      'entitlement.feature_overridden',
      'entitlement.limit_overridden',
      'platform_admin.added',
      'platform_admin.role_changed',
      'platform_admin.removed',
      'invoice.issued',
      'invoice.voided',
      'payment.manual_recorded',
      'payment.refunded',
      'platform_settings.updated',
      'billing.settings_updated',
    ])
      expect(AUDIT_ACTIONS).toContain(a);
  });
});
