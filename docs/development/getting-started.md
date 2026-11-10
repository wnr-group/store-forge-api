# Getting started

A first-run walkthrough. Full reference is in the [README](../../README.md).

## 1. Install and configure

```bash
git clone https://github.com/wnr-group/store-forge-api.git
cd store-forge-api
npm install
cp .env.example .env
```

Requires Node.js >= 22.12 (`node -v`).

## 2. Start the API

```bash
npm run start:dev
```

You should see `API listening on port 4000 under /api/v1` and `Swagger UI at /api/docs`.

## 3. Confirm it works

```bash
curl http://localhost:4000/api/v1/health
```

Expected: `{"status":"ok","service":"store-forge-api"}`. Open http://localhost:4000/api/docs for Swagger UI.

This only proves the app is running. It does not check a database or any external service (none is configured).

## 4. Confirm your toolchain

```bash
npm run typecheck && npm run lint && npm test && npm run test:e2e && npm run build
```

All five must pass on a clean checkout.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Invalid environment configuration - PORT: ...` | A value in `.env` failed validation; the message names the variable. Fix `.env` (see `.env.example`). |
| `EADDRINUSE` | Port 4000 is taken. Set a different `PORT` in `.env`. |
| Browser blocked by CORS | Add the frontend origin to `CORS_ORIGINS` (exact origin, comma-separated). |
| `Cannot find module './x'` / `ERR_MODULE_NOT_FOUND` | ESM project: relative imports need the `.js` suffix (`'./x.js'`). |
| `jest is not defined` | Tests use Vitest: `vi.fn()`, not `jest.fn()`. |
| Swagger returns 404 | `SWAGGER_ENABLED` is off (the default when `NODE_ENV=production`). |

## Next

Read [santu-onboarding.md](santu-onboarding.md) and [../architecture/overview.md](../architecture/overview.md).
