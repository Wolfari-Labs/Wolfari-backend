import { describe, expect, it } from 'vitest';
// @ts-expect-error JS operator tool has no declaration file.
import { exportable } from './trial-export.mjs';
describe('trial source handoff', () => {
  it('excludes runtime data/secrets and preserves templates/new deployment sources', () => {
    for (const path of [
      '.env',
      '.env.production',
      'apps/api/.env',
      '.local/demo/accounts.json',
      'node_modules/a.js',
      'dist/main.js',
      'key.pem',
      'backup.age',
      '../secret',
    ])
      expect(exportable(path)).toBe(false);
    for (const path of [
      '.env.example',
      'apps/api/.env.example',
      'deployment/Caddyfile',
      'deployment/backup.sh',
      'scripts/trial.mjs',
      'pnpm-lock.yaml',
    ])
      expect(exportable(path)).toBe(true);
  });
});
