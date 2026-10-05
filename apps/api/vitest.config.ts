import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    globalSetup: ['test/setup/global-setup.ts'],
    // Runs before the test module is imported, so loadEnv() never caches the dev URL.
    setupFiles: ['test/setup/env.ts'],
    // Auth tests share one schema and truncate it between cases, so files must not
    // interleave. The fake Discord tests are self-contained and could run alone.
    fileParallelism: false,
  },
})
