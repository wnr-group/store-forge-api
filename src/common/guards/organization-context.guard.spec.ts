import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { DatabaseService } from '../../database/database.service.js';
import { AppException } from '../app.exception.js';
import {
  OrgScoped,
  RequireExplicitOrganization,
  RequirePermission,
} from '../decorators/decorators.js';
import type { AuthenticatedRequest } from '../interfaces/request-context.js';
import {
  listActiveMemberships,
  type OrgMembership,
} from '../tenancy/memberships.js';
import { OrganizationContextGuard } from './organization-context.guard.js';

vi.mock('../tenancy/memberships.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tenancy/memberships.js')>()),
  listActiveMemberships: vi.fn(),
}));

const membership = (role: OrgMembership['role']): OrgMembership => ({
  tenant: {
    id: randomUUID(),
    name: 'Org',
    slug: 'org',
    publicId: 'abc123',
  },
  role,
  permissions: {},
  capabilities: [],
  joinedAt: new Date(),
});

/** First organization the caller joined: the one a header-less request would silently fall back to. */
const first = membership('admin');
const second = membership('owner');

// Controllers carry only the metadata under test; the decorators are plain function calls.
class OrdinaryController {
  handler() {}
}
OrgScoped()(OrdinaryController);

class ExplicitController {
  handler() {}
}
OrgScoped()(ExplicitController);
RequireExplicitOrganization()(ExplicitController);

class ExplicitByPermissionOnly {
  handler() {}
}
RequirePermission('payments:manage')(ExplicitByPermissionOnly);
RequireExplicitOrganization()(ExplicitByPermissionOnly);

class UnscopedController {
  handler() {}
}

const withUser = vi.fn(
  async (_userId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
);
const db = { withUser } as unknown as DatabaseService;
const guard = new OrganizationContextGuard(new Reflector(), db);

type Headers = Record<string, string | string[] | undefined>;

function run(controller: new () => { handler(): void }, headers: Headers) {
  const request = {
    headers,
    user: { id: 'user-1' },
  } as unknown as AuthenticatedRequest;
  const context = {
    getHandler: () => controller.prototype.handler as () => void,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { request, result: guard.canActivate(context) };
}

async function refusal(promise: Promise<boolean>): Promise<AppException> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(AppException);
    return e as AppException;
  }
  throw new Error('expected the guard to refuse the request');
}

beforeEach(() => {
  withUser.mockClear();
  vi.mocked(listActiveMemberships).mockReset();
  vi.mocked(listActiveMemberships).mockResolvedValue([first, second]);
});

describe('OrganizationContextGuard: explicit organization (opt-in)', () => {
  describe.each([
    ['is missing', {}],
    ['is empty', { 'x-organization-id': '' }],
    ['is only whitespace', { 'x-organization-id': '   ' }],
    ['is an empty list', { 'x-organization-id': [] }],
    ['is a list of blanks', { 'x-organization-id': ['', ' '] }],
  ] as [string, Headers][])('when the header %s', (_label, headers) => {
    it.each([
      ['@OrgScoped', ExplicitController],
      ['@RequirePermission', ExplicitByPermissionOnly],
    ])(
      'refuses a %s route with 400 ORGANIZATION_REQUIRED and never looks up memberships (AC-ORG-01, AC-ORG-02, AC-ORG-03, AC-ORG-04)',
      async (_n, controller) => {
        const { request, result } = run(controller, headers);
        const error = await refusal(result);
        expect(error.getStatus()).toBe(400);
        expect(error.code).toBe('ORGANIZATION_REQUIRED');
        expect(error.kind).toBe('VALIDATION');
        expect(withUser).not.toHaveBeenCalled();
        expect(listActiveMemberships).not.toHaveBeenCalled();
        expect(request.org).toBeUndefined();
      },
    );
  });

  it('does not fall back to the first organization when the header is absent', async () => {
    const { request, result } = run(ExplicitController, {});
    await refusal(result);
    expect(request.org).toBeUndefined();
  });

  it('resolves exactly the organization the header names, not the first one (AC-ORG-07)', async () => {
    const { request, result } = run(ExplicitController, {
      'x-organization-id': second.tenant.id,
    });
    await expect(result).resolves.toBe(true);
    expect(request.org?.tenantId).toBe(second.tenant.id);
    expect(request.org?.role).toBe('owner');
  });

  it('still refuses an organization the caller does not belong to (AC-ORG-08)', async () => {
    const { result } = run(ExplicitController, {
      'x-organization-id': randomUUID(),
    });
    const error = await refusal(result);
    expect(error.getStatus()).toBe(403);
    expect(error.code).toBe('ORGANIZATION_ACCESS_DENIED');
  });

  it('still refuses a header that is not a uuid', async () => {
    const { result } = run(ExplicitController, {
      'x-organization-id': 'not-a-uuid',
    });
    const error = await refusal(result);
    expect(error.code).toBe('ORGANIZATION_ACCESS_DENIED');
  });
});

describe('OrganizationContextGuard: every other route is unchanged (AC-ORG-10)', () => {
  it('an ordinary @OrgScoped route without the header still uses the first organization', async () => {
    const { request, result } = run(OrdinaryController, {});
    await expect(result).resolves.toBe(true);
    expect(request.org?.tenantId).toBe(first.tenant.id);
  });

  it('an ordinary @OrgScoped route with a blank header still uses the first organization', async () => {
    const { request, result } = run(OrdinaryController, {
      'x-organization-id': '   ',
    });
    await expect(result).resolves.toBe(true);
    expect(request.org?.tenantId).toBe(first.tenant.id);
  });

  it('an ordinary @OrgScoped route with a valid header resolves that organization', async () => {
    const { request, result } = run(OrdinaryController, {
      'x-organization-id': second.tenant.id,
    });
    await expect(result).resolves.toBe(true);
    expect(request.org?.tenantId).toBe(second.tenant.id);
  });

  it('a route that is not organization-scoped is not touched at all', async () => {
    const { request, result } = run(UnscopedController, {});
    await expect(result).resolves.toBe(true);
    expect(withUser).not.toHaveBeenCalled();
    expect(request.org).toBeUndefined();
  });

  it('a caller with no organization still gets the existing NO_WORKSPACE answer on an ordinary route', async () => {
    vi.mocked(listActiveMemberships).mockResolvedValue([]);
    const { result } = run(OrdinaryController, {});
    const error = await refusal(result);
    expect(error.code).toBe('NO_WORKSPACE');
  });
});
