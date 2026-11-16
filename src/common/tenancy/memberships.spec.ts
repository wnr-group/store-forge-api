import { AppException } from '../app.exception.js';
import { resolveOrganization, type OrgMembership } from './memberships.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER = '11111111-1111-4111-8111-111111111111';

const m = (
  id: string,
  role: OrgMembership['role'] = 'owner',
): OrgMembership => ({
  tenant: {
    id,
    name: `Org ${id[0]}`,
    slug: `org-${id[0]}`,
    publicId: `pub${id[0]}abc`,
  },
  role,
  permissions: {},
  joinedAt: new Date(0),
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as AppException).code;
  }
  return null;
};

describe('resolveOrganization', () => {
  it('uses the first membership when no hint is given', () => {
    const org = resolveOrganization(USER, [m(A), m(B)], undefined);
    expect(org).toMatchObject({ userId: USER, tenantId: A, role: 'owner' });
  });

  it('honours a hint that matches a verified membership, case-insensitively', () => {
    expect(
      resolveOrganization(USER, [m(A), m(B)], B.toUpperCase()).tenantId,
    ).toBe(B);
  });

  it('refuses a hint for an organization the caller does not belong to', () => {
    expect(code(() => resolveOrganization(USER, [m(A), m(B)], C))).toBe(
      'ORGANIZATION_ACCESS_DENIED',
    );
  });

  it('refuses a malformed hint instead of falling back', () => {
    for (const hint of [
      'nope',
      'x; drop table tenants;--',
      '../etc/passwd',
      A + 'x',
    ])
      expect(
        code(() => resolveOrganization(USER, [m(A)], hint)),
        hint,
      ).toBe('ORGANIZATION_ACCESS_DENIED');
  });

  it('reports NO_WORKSPACE when the caller has no membership at all', () => {
    expect(code(() => resolveOrganization(USER, [], undefined))).toBe(
      'NO_WORKSPACE',
    );
    expect(code(() => resolveOrganization(USER, [], A))).toBe('NO_WORKSPACE');
  });

  it('carries the role and permissions of the CHOSEN membership', () => {
    const org = resolveOrganization(
      USER,
      [m(A, 'owner'), { ...m(B, 'admin'), permissions: { products: 'read' } }],
      B,
    );
    expect(org).toMatchObject({
      role: 'admin',
      permissions: { products: 'read' },
    });
  });
});
