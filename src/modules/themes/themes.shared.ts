import { invalid, notFound } from '../../common/app.exception.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import type { DbTx } from '../../database/database.service.js';
import { getPrimaryStoreInTx } from '../store/store.service.js';
import type { DocumentIssue } from './validation/template-document.js';

export const storeNotFound = () =>
  notFound('No store was found for this organization.', 'STORE_NOT_FOUND');

export const themeNotFound = () =>
  notFound('That theme could not be found.', 'THEME_NOT_FOUND');

export const templateNotFound = () =>
  notFound('That design could not be found.', 'TEMPLATE_NOT_FOUND');

/** The organization's store, inside the caller's transaction. */
export async function requireStore(tx: DbTx, ctx: OrgContext) {
  const store = await getPrimaryStoreInTx(tx, ctx.tenantId);
  if (!store) throw storeNotFound();
  return store;
}

/** Turns validator issues into the API's `fieldErrors` map: `index.sections.hero.settings.link -> message`. */
export function issuesToFieldErrors(
  kind: string,
  issues: DocumentIssue[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues.slice(0, 20))
    out[issue.path ? `${kind}.${issue.path}` : kind] = issue.message;
  return out;
}

export const documentInvalid = (kind: string, issues: DocumentIssue[]) =>
  invalid(
    'This design has problems that must be fixed first.',
    issuesToFieldErrors(kind, issues),
    'TEMPLATE_DOCUMENT_INVALID',
  );
