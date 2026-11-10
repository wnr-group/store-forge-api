# Swagger authentication guide (Windows)

How to call the protected StoreForge API from Swagger UI using a real Supabase access token.

The API never issues tokens. **Supabase Auth is the only token issuer**; this guide just automates asking it for one.

```
npm run auth:token  ->  token is on your clipboard  ->  Swagger "Authorize" -> paste  ->  try endpoints
```

## Prerequisites

| Need | How to check |
|---|---|
| Backend running | `npm run start:dev` prints `API listening on port 4000` |
| Supabase settings in `.env` | `SUPABASE_URL` and `SUPABASE_ANON_KEY` are filled in (the script also accepts them as environment variables). The API itself additionally needs `SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL` |
| A confirmed Supabase Auth user | Created by `npm run admin:create` (Platform Admin), `POST /platform/organizations` (an Owner), the team endpoints (members), or `npm run db:seed:demo` (dev only) |
| The right StoreForge role for what you want to test | See [Step 6](#step-6-test-organization-apis) |

You never need the service-role key or `DIRECT_URL` for this guide.

## Step 1: Start the backend

```powershell
npm run start:dev
```

## Step 2: Open Swagger

http://localhost:4000/api/docs (OpenAPI JSON: http://localhost:4000/api/docs-json). Swagger is on by default outside production.

## Step 3: Generate an access token

In a second terminal, from the repository root:

```powershell
npm run auth:token
```

You are asked for the email, then the password (typed hidden). On success:

```
Access token copied to the clipboard.
  Signed in as : owner@example.com
  Valid for    : 60 minutes
  Expires at   : 2026-11-10 18:44:26 +05:30
```

What the script does, and does not do:

- Sends `POST {SUPABASE_URL}/auth/v1/token?grant_type=password` to Supabase with the anon key in the `apikey` header.
- Copies `access_token` to the clipboard with `Set-Clipboard`.
- **Never prints** the token or the password, never writes them to a file, never changes `.env`.
- Works in Windows PowerShell 5.1 and PowerShell 7. It reads `SUPABASE_URL` / `SUPABASE_ANON_KEY` from the environment first, then from `.env`.

Tokens last about an hour (the Supabase project's JWT expiry). Run the command again when one expires.

> **Alternative without the script:** `POST /api/v1/auth/login` works from Swagger "Try it out" (same origin). It sets the session in an HttpOnly cookie in your browser, after which Swagger's requests are authenticated by the cookie and no Authorize step is needed. Use `POST /auth/logout` to clear it.

## Step 4: Authorize Swagger

1. Click the green **Authorize** button (top right) or any padlock.
2. Click into the **Value** box and press **Ctrl+V**.
3. **Do not type `Bearer`.** Swagger adds it for you. Pasting `Bearer eyJ...` would send `Bearer Bearer ...` and fail with `INVALID_TOKEN`.
4. Click **Authorize**, then **Close**. The padlocks are now closed.

To switch user (for example Platform Admin to Owner): **Authorize -> Logout**, run `npm run auth:token` for the other user, paste again.

## Step 5: Test the Platform Admin

With a Platform Admin's token, expand `GET /api/v1/platform/me` -> **Try it out** -> **Execute**.

Expected: HTTP **200**

```json
{ "success": true, "message": "Platform admin level retrieved successfully", "data": { "level": "super_admin" } }
```

`level` is `super_admin` or `admin`, read from the database. Then try `GET /api/v1/platform/overview` and `GET /api/v1/platform/organizations`. Use `GET /api/v1/auth/me` with any valid token to see who the API thinks you are (platform level and organizations).

## Step 6: Test organization APIs

Endpoints such as `/products`, `/customers`, `/inventory`, `/team/members`, `/store` and `/analytics` work on one organization.

- Each shows an optional **X-Organization-Id** field in Swagger.
- **Leave it empty** and the API uses your first organization.
- If you belong to several organizations, paste the id of the one you want (list them with `GET /api/v1/organizations`).
- The id is only a *hint*: the API checks it against your memberships and answers `403 ORGANIZATION_ACCESS_DENIED` if it is not yours. It can never be used to reach another organization's data.

**Platform Admin token vs Owner token**

| Token of | Works on | Does not work on |
|---|---|---|
| Platform Admin | `/platform/*`, `/auth/me`, `/users/me`, public routes | `/products`, `/customers`... (`404 NO_WORKSPACE`: platform admins deliberately have no access to merchant data) |
| Store Owner | everything in their organization, including `/team/members` | `/platform/*` (`403 FORBIDDEN`) |
| Team member | what the Owner granted per module (products / orders / customers / settings) | `/team/*`, `/platform/*` |

A person is never both a Platform Admin and an organization member. To test both sides you need two accounts.

## Step 7: Troubleshooting

| What you see | Meaning | Fix |
|---|---|---|
| `401 AUTH_REQUIRED` | No token was sent | Click **Authorize** and paste the token (padlock must be closed) |
| `401 TOKEN_EXPIRED` | The token is older than its lifetime (about 1 hour) | Run `npm run auth:token` again, **Logout** + paste in Authorize |
| `401 INVALID_TOKEN` | Not a valid Supabase user token for this project | You pasted the anon key, a refresh token or `Bearer ...`; or the token belongs to a different Supabase project than `SUPABASE_URL`; or `SUPABASE_URL` in `.env` changed after starting the API (restart it) |
| `403 FORBIDDEN` | Token is valid but your role may not do this | Use the right account (see the table above); members need the module permission |
| `403 ORGANIZATION_ACCESS_DENIED` | `X-Organization-Id` is not one of your organizations | Clear the field or use an id from `GET /organizations` |
| `404 NO_WORKSPACE` | You belong to no active organization (or you are a Platform Admin) | Use an Owner/member account; disabled members and suspended organizations count as "none" |
| `429` | Rate limit | Wait a minute |

Problems in the token script itself:

| Message | Fix |
|---|---|
| `Missing SUPABASE_URL and SUPABASE_ANON_KEY` | Fill them in `.env` (see `.env.example`) or set `$env:SUPABASE_URL` / `$env:SUPABASE_ANON_KEY` |
| `Wrong email or password.` | Check the account; passwords are case-sensitive |
| `Supabase rejected the request (401)` | `SUPABASE_ANON_KEY` is from a different project than `SUPABASE_URL` |
| `Could not reach Supabase` | Network or a wrong `SUPABASE_URL` |
| `This account is not confirmed` | StoreForge accounts are created pre-confirmed; ask an administrator |
| `Too many attempts` | Supabase rate limit; wait a minute |
| Script blocked by execution policy | `npm run auth:token` already passes `-ExecutionPolicy Bypass` for that one process; if your organization forbids it, open the script and run it from a PowerShell you are allowed to use |

## Security notes

- **Never commit** `.env`, passwords or access tokens, and do not paste tokens into chats or tickets. A token is a password for up to an hour.
- Supabase Auth is the only issuer. Do not create your own JWTs, and never use `SUPABASE_SERVICE_ROLE_KEY` as a token: it bypasses row level security and must never reach a browser or frontend code.
- The anon key in `.env` is public by design (it ships in browsers), but still keep it out of commits.
- Swagger is configured with `persistAuthorization`, so **the token is kept in your browser's local storage** and survives page reloads. That is convenient and acceptable **only on a trusted development machine**. On a shared computer, click **Logout** in the Authorize dialog when finished. Do not enable Swagger on a public production deployment (`SWAGGER_ENABLED=false` is the production default).
- The script never writes the token anywhere except the clipboard. The clipboard is readable by other programs and may be kept in Windows clipboard history (Win+V): clear it afterwards if that matters (`Set-Clipboard -Value " "`).
- Test with the demo accounts only on a development project: their password is public.
