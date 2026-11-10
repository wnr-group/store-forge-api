import { defineConfig } from 'vitest/config';
import { TEST_ENV } from './test/support/test-env.js';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    env: { ...TEST_ENV, THROTTLE_LIMIT: '100000' },
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    root: './',
    include: ['**/*.e2e-spec.ts'],
  },
});
