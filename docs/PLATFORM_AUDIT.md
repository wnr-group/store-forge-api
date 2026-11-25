# Platform audit log

Every change a Platform Admin makes is recorded in `admin_audit_logs`, in the same database transaction as the change itself: if the change
rolls back, so does its entry, and an entry never exists for something that did not happen.

## What is recorded

| Field | Meaning |
|---|---|
| actor | `admin_user_id` and `admin_email`, always the signed-in admin (`auth.uid()`), never a value sent by the caller |
| action | `entity.verb`, from the list in `audit-actions.ts` (`GET /platform/audit-logs/filters`) |
| target | `entity_type`, `entity_id`, and the organization (id and its name as it was at the time) |
| time | `created_at` |
| before and after | `previous_data` / `new_data`: only the fields that changed, with anything that looks like a credential replaced by `[redacted]` at any depth (keys containing pass, secret, token, credential, api key, authorization, cookie) |
| request | `ip`, `user_agent` (capped at 300 characters) and `request_id`: the same id the API returns in `X-Request-Id` and prints in its logs |

Covered: organizations (create, edit, suspend, reactivate, delete), stores, team members and ownership, platform admins and their roles,
platform settings, plans (create, edit, activate, deactivate, default), subscriptions, entitlement and limit exceptions, billing settings,
invoices (issue, void), offline payments, refunds, and billing runs.

## Reading it

`GET /platform/audit-logs` filters by actor (`admin`), action, kind of thing (`entity`), organization (`org`), organization name
(`search`) and date (`from`, `to`, whole UTC days), newest first, paged. `GET /platform/organizations/:id/activity` is the same log for one
organization and still works after it is deleted. Reading needs the `audit:read` permission: Super Admin and Platform Admin only; Billing and
Support admins and every tenant user are refused.

## Why nobody can change it

* There is no route that edits or deletes an entry.
* No database role the application uses can select, insert, update or delete the table: reads go through `platform_list_audit()` and writes
  through `platform_record_audit()`, both of which require a Platform Admin.
* A trigger rejects `UPDATE`, `DELETE` and `TRUNCATE` for everyone, the table owner included, so no column can be rewritten.
* Entries carry no foreign key to admins or organizations, so deleting either never removes history.

## What it does not record

* Requests that were refused. A non-admin cannot write the log, so a denied request is written to the **server log** instead (`platform
  access denied: <method> <route> by <user id> (<reason>) request <id>`, no e-mail and no token).
* Tenant users' own actions. This log is about platform administration; tenants have their own histories (for example integration changes).
* Entries made before migration 0065 have no address, user agent or request id.
