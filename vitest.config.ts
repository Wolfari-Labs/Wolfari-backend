import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/finance-service/src/**/*.test.ts',
      'scripts/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '.cache/**', '.pnpm-store/**'],
  },
});
