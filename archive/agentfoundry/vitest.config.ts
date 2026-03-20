import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/types/**/*.ts'],
      thresholds: {
        statements: 50,
        branches: 40,
        functions: 50,
        lines: 50
      }
    },
    testTimeout: 10000,
    hookTimeout: 10000
  }
})
