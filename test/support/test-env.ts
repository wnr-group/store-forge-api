/** Dummy, non-secret environment for tests. Nothing here can reach a real Supabase project or database. */
export const TEST_ENV = {
  SUPABASE_URL: 'http://127.0.0.1:54399',
  SUPABASE_ANON_KEY: 'test-anon-key-test-anon-key-test',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key-test-service-role',
  AUTH_BFF_SECRET: 'test-bff-secret-test-bff-secret-12345',
  DATABASE_URL:
    'postgresql://storeforge_app.testref:test-password@localhost:6543/postgres',
} as const;
