import {
  AppException,
  conflict,
  forbidden,
  invalid,
  notFound,
} from '../../common/app.exception.js';
import { errorChain } from '../../common/db-errors.js';

/** Maps the SQL functions' RAISE codes to client-safe errors. Anything unrecognised is rethrown (logged, hidden). */
export function mapProvisioningError(
  error: unknown,
  notFoundMessage = 'Organization not found.',
): never {
  if (error instanceof AppException) throw error;
  const msg = errorChain(error);
  if (msg.includes('not_super_admin'))
    throw forbidden('Only a super admin can do that.', 'SUPER_ADMIN_REQUIRED');
  if (msg.includes('last_super_admin'))
    throw invalid(
      'There must always be at least one super admin.',
      undefined,
      'LAST_SUPER_ADMIN',
    );
  if (msg.includes('already_admin'))
    throw conflict(
      'That person is already a platform admin.',
      undefined,
      'ALREADY_PLATFORM_ADMIN',
    );
  if (msg.includes('member_cannot_be_platform_admin'))
    throw invalid(
      'That account belongs to an organization, so it cannot also be a platform admin.',
      undefined,
      'MEMBER_CANNOT_BE_PLATFORM_ADMIN',
    );
  if (msg.includes('not_note_author'))
    throw forbidden('You can only edit your own notes.');
  if (msg.includes('currency_locked'))
    throw invalid(
      'Currency cannot be changed once the store has products or orders.',
      { currency: 'Locked: prices already exist' },
      'CURRENCY_LOCKED',
    );
  if (msg.includes('cannot_change_owner'))
    throw invalid(
      'The owner cannot be disabled or removed. Transfer ownership first.',
      undefined,
      'OWNER_PROTECTED',
    );
  if (msg.includes('already_owner'))
    throw invalid(
      'That person is already the owner.',
      undefined,
      'ALREADY_OWNER',
    );
  if (msg.includes('not_eligible'))
    throw invalid(
      'Only an active team member of this organization, or a brand-new account, can become the owner.',
      undefined,
      'OWNER_NOT_ELIGIBLE',
    );
  if (msg.includes('slug_taken'))
    throw conflict(
      'That store address is already taken.',
      { storeSlug: 'That address is already taken' },
      'STORE_SLUG_TAKEN',
    );
  if (msg.includes('invalid_slug'))
    throw invalid(
      'That store address is not allowed.',
      { storeSlug: 'Choose a different address' },
      'STORE_SLUG_INVALID',
    );
  // 'plan_not_found' contains 'not_found', so the plan codes are checked before the generic one below.
  if (msg.includes('plan_not_found'))
    throw notFound('That plan was not found.', 'PLAN_NOT_FOUND');
  if (msg.includes('plan_inactive'))
    throw invalid(
      'That plan is not active, so it cannot be assigned.',
      { planId: 'Choose an active plan' },
      'PLAN_INACTIVE',
    );
  if (msg.includes('invalid_input'))
    throw invalid('Please check the details you entered.');
  if (msg.includes('not_found')) throw notFound(notFoundMessage, 'NOT_FOUND');
  if (msg.includes('not_platform_admin')) throw forbidden();
  throw error;
}
