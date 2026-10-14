import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'apps/*/tests/**/*.test.ts',
      'scripts/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '.cache/**', '.pnpm-store/**'],
  },
});
