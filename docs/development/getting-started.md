# Getting started

A first-run walkthrough. Full reference is in the [README](../../README.md).

## 1. Install and configure

```bash
git clone https://github.com/wnr-group/store-forge-api.git
cd store-forge-api
npm install
cp .env.example .env.local    # Windows PowerShell: Copy-Item .env.example .env.local
```

Requires Node.js >= 22.12 (`node -v`).

### Environment loading order (D-016)

Environment files are loaded in order:
1. `.env.local` (developer local overrides, git-ignored)
2. `.env` (default environment variables, git-ignored)
3. Real `process.env` always takes precedence over both files.

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

## 4. Run tests and verifications

```bash
npm test                 # unit tests
npm run test:e2e         # e2e tests
npm run test:int         # PGlite database integration tests
npm run typecheck        # TypeScript check
npm run lint             # oxlint
npm run format:check     # Prettier code style
npm run build            # production build
```

All must pass on a clean checkout.

## 5. Schema synchronization and drift check (D-004, D-018)

The frontend `wnr-group/store-forge` is the single source of truth for the database schema.
To check or sync schema locally:

```bash
# Sync from adjacent frontend repository:
node scripts/sync-schema.mjs sync --source ../store-forge

# Run drift check:
node scripts/sync-schema.mjs check --source ../store-forge
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Invalid environment configuration - DATABASE_URL: ...` | `DATABASE_URL` is missing or invalid. It must use the `storeforge_app` role. In test mode (`NODE_ENV=test`), `DATABASE_URL` is optional. |
| `Invalid environment configuration - PORT: ...` | A value in `.env.local` or `.env` failed validation. |
| `EADDRINUSE` | Port 4000 is taken. Set a different `PORT` in `.env.local`. |
| `Cannot find module './x'` / `ERR_MODULE_NOT_FOUND` | ESM project: relative imports need the `.js` suffix (`'./x.js'`). |
