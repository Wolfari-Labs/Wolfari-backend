import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '.cache/**', '.pnpm-store/**', 'packages/contracts/src/generated/**'] },
  ...tseslint.configs.recommended,
);
