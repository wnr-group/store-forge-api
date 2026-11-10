# Cookie-session authentication through the API

Sign-in, sign-out, session restoration, token refresh and password change used to run inside the Next.js app, which talked to Supabase Auth directly. They now run through this API: **Next.js -> NestJS -> Supabase Auth**. Nothing about *who may log in* or *what they may do* changed.

## What did not change

| | |
|---|---|
| Accounts | Existing, provisioned accounts only. **No sign-up, no registration endpoint, no email verification, no forgot/reset-password, no OAuth** (none existed; a Next.js test still enforces it). Login never creates a user, a profile, an organization or a membership. |
| Roles | Platform Admin (`super_admin`/`admin`), Owner, members with per-module permissions (Manager / Staff / Viewer presets). Read from Postgres on every request. A successful login grants nothing extra. |
| Tenant isolation | Unchanged: guards + RLS-as-user. |
| UX | Same login page and form validation, same messages (`Incorrect email or password.`, rate-limit wording), same `?next=` handling and redirects, same protected routes, same logout. |
| Identity provider | Supabase Auth, same project, same users, same passwords. |

## Architecture

```
Browser --(same-origin, HttpOnly cookies, per store host)--> Next.js (server actions + proxy)
Next.js --(server-to-server, X-Internal-Auth secret, visitor IP)--> NestJS /api/v1/auth/*
NestJS  --(supabase-js / @supabase/ssr)--> Supabase Auth
```

* The browser never calls the API for authentication and never sees a token: the Next.js **server** calls the API and copies the API's `Set-Cookie` headers onto its own response. Cookies therefore stay **host-only**, one set per store host (`<store>.<root>`), exactly as before.
* The session cookie is the one `@supabase/ssr` has always used (`sb-<project>-auth-token`, chunked when large). The API writes it with the library itself, so every other part of the Next.js app that reads it (Storage calls, the server Supabase client) keeps working unchanged. The only differences are its attributes: `HttpOnly`, `SameSite=Lax`, `Secure` outside local development, no `Domain`.
* A non-secret `sf_signed_in=1` cookie (not HttpOnly, no token inside) lets the static landing and storefront pages show "Dashboard" instead of "Sign in" without a lookup. It replaces the old trick of reading the Supabase cookie from JavaScript, which HttpOnly forbids.

## Endpoints (`/api/v1/auth`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/login` | Body `{email, password}`. Checks credentials with Supabase, sets the cookies, returns the safe profile (`id, email, fullName, platformAdminLevel, memberships[], expiresAt`). Counted against the DB login rate limit **before** the password is checked. 401 `INVALID_CREDENTIALS` / `ACCOUNT_NOT_ACTIVE`, 429 `LOGIN_RATE_LIMITED`, 403 `CSRF_*`. |
| POST | `/logout` | Revokes the session at Supabase (best effort), **always** clears the cookies. Safe when already signed out. |
| POST | `/refresh` | Exchanges the refresh token in the cookie for a new session; Supabase **rotates** the refresh token. Missing / used / revoked token -> cookies cleared, 401 `SESSION_EXPIRED`. |
| GET | `/session` | Verifies the access token (Bearer header **or** cookie) against Supabase's signing keys; returns `{user:{id,email,fullName}, expiresAt}`. Read-only, no database. 401 `TOKEN_EXPIRED` tells the caller to refresh. |
| GET | `/me` | Session restoration with the full profile (roles, organizations). Works with Bearer or cookie. |
| POST | `/change-password` | As before (re-verifies the current password). Works with Bearer or cookie. |

Every other endpoint also accepts the cookie session when no `Authorization` header is sent. An invalid Bearer header is never "rescued" by a cookie.

## Security measures

| Threat | Measure |
|---|---|
| Token theft by script (XSS) | Session cookies are `HttpOnly`; tokens are never in a response body, `localStorage` or `sessionStorage` (checked in a real browser). |
| CSRF | Every state-changing request that could ride on the cookie must come from an **allowed `Origin`** (`CORS_ORIGINS`, or the API's own origin for Swagger) or from the trusted Next.js server (shared secret). The sign-in/out/refresh routes require this even without a cookie (login CSRF). `SameSite=Lax` is the second layer; Next.js server actions add their own Origin check. Bearer calls are exempt (a browser never attaches them on its own). |
| Forged client address / rate-limit evasion | `X-Forwarded-For` is honoured only when the request carries `X-Internal-Auth` (constant-time compared to `AUTH_BFF_SECRET`). Everyone else is keyed on their own address. The global throttler uses the same rule so one visitor cannot exhaust the frontend server's budget. |
| Brute force | DB-backed `rate_limit_login` (8 per address+email and 40 per address per 15 min), counted before the password check, shared by all instances; plus a per-route throttle and Supabase's own limits. Fails open (logged) if the limiter is unreachable, as before. |
| Refresh-token replay | Supabase rotation. The API refreshes from a client that does **not** pre-load the stored session, so an expired session cannot spend its refresh token twice. A replayed token ends the session. |
| Token forgery | Signature (JWKS), issuer, audience, expiry, UUID `sub`, `role=authenticated`; anon/service keys and anonymous users refused. |
| Cookie downgrade | The Next.js server Supabase client, which would write cookies with `httpOnly:false`, is forced to keep `HttpOnly`/`Lax`/host-only when the API owns the session. |
| Information leaks | Unknown e-mail and wrong password answer identically; errors are mapped to safe messages; logs never contain tokens, cookies or passwords. |
| CORS | Exact origin allowlist with credentials; only `Authorization`, `Content-Type`, `X-Organization-Id` are allowed headers. |

## Environment variables

| Where | Variable | Meaning |
|---|---|---|
| API | `AUTH_BFF_SECRET` | Shared secret, 32+ characters. Optional but required for the Next.js server to be trusted (real visitor address, no Origin). |
| API | `RATE_LIMIT_SECRET` | Optional; keys the rate-limit hashes (defaults to the service-role key). |
| API | `CORS_ORIGINS` | Must list the frontend origin(s) if browsers ever call the API directly. |
| Next.js | `AUTH_API_URL` | e.g. `http://localhost:4000/api/v1`. **Setting it switches authentication to the API; unsetting it restores the direct-to-Supabase behaviour.** |
| Next.js | `AUTH_BFF_SECRET` | Same value as the API's. Server-only, never `NEXT_PUBLIC_`. |

Generate the secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## Rollout and rollback

1. Deploy the API with `AUTH_BFF_SECRET`.
2. Set `AUTH_API_URL` + `AUTH_BFF_SECRET` on the Next.js app and redeploy. Existing users keep their current sessions: the cookie format is identical, so nobody is logged out (their old non-HttpOnly cookie is simply replaced by an HttpOnly one at their next sign-in or refresh).
3. **Rollback:** remove `AUTH_API_URL`. The previous direct-to-Supabase code is still in place and takes over; sessions stay valid. The old code can be deleted once the API path has proven itself.

## Differences worth knowing

* **Logout and stolen tokens.** The Next.js app asked Supabase to confirm the session on every request (`getUser()`), so a revoked session stopped working immediately. The API verifies the access token locally (no Supabase round trip per request), so a token copied *before* logout stays valid until it expires (default 1 hour). Disabled or removed members are still cut off immediately (membership is read every request). If you need instant revocation, add a Supabase `getUser` call to `GET /auth/session` (costs one round trip per request, as before).
* **Display name** in the account menu now comes from the token's `user_metadata.full_name`. Renaming yourself rotates the session once so the new name shows immediately.
* **Optimistic gating in the proxy** no longer verifies the signature (it never was the security boundary); pages and actions verify through the API.

## Verification

* API: 20 end-to-end tests of this flow against the real schema and a fake Supabase Auth (`test/session.e2e-spec.ts`) plus unit tests of the CSRF rules, address trust and cookie handling.
* Next.js: 25 tests (`tests/unit/auth-api-mode.test.ts`) against a real local HTTP server standing in for the API, and the existing 20 auth tests still pass in the old mode.
* Real run: both servers against the real Supabase project and database with the existing demo accounts, driven through the real login form in Chromium (see the migration report). Passwords were not changed.
