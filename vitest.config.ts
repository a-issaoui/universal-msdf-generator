import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
      exclude: [
        'node_modules/**',
        'dist/**',
        'examples/**',
        'coverage/**',
        '**/*.d.ts',
        'test/**',
        'vitest.config.ts',
        'tsup.config.ts',
      ],
    },
  },
});
