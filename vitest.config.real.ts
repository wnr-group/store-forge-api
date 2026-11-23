import { defineConfig } from 'vitest/config';

/**
 * REAL-layer checks: a real running API, a real Postgres and a real Supabase Auth and PostgREST (the isolated local stack, or a
 * hosted dev/staging project when one is provided). These specs need QA_REAL_* variables and are NOT part of `npm test` or
 * `npm run test:e2e`. See test/real/payments-real.real-spec.ts.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    root: './',
    include: ['**/*.real-spec.ts'],
  },
});
