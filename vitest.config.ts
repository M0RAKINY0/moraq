import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'test/redis/**', 'test/smoke/**'],
        },
      },
      {
        // Needs a running Redis. Locally: `npm run test:redis` starts one in Docker.
        test: {
          name: 'redis',
          include: ['test/redis/**/*.test.ts'],
        },
      },
      {
        // Real provider calls. Each suite skips itself when its API key is missing.
        test: {
          name: 'smoke',
          include: ['test/smoke/**/*.test.ts'],
          testTimeout: 60_000,
        },
      },
    ],
  },
})
