import { defineConfig } from 'vitest/config';
import { TEST_ENV } from './test/support/test-env.js';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`. Requires Vite 8, which ships this option.
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    env: { ...TEST_ENV },
    root: './',
    include: ['**/*.spec.ts'],
  },
});
