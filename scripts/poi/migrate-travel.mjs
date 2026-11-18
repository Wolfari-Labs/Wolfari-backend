#!/usr/bin/env node
// Apply pending travel_db migrations using a travel app .env (DATABASE_URL), e.g. from a worktree.
// Usage: node scripts/poi/migrate-travel.mjs [--env <travel .env>] [--dry-run]
import { parseArgs } from 'node:util';
import { history, migrate, migrationFiles, safeError } from '../migrations.mjs';
import { DEFAULT_ENV, connectTravel, travelUrl } from './poi-db.mjs';

const { values } = parseArgs({
  options: { env: { type: 'string', default: DEFAULT_ENV }, 'dry-run': { type: 'boolean', default: false } },
});

try {
  const url = await travelUrl(values.env);
  const files = await migrationFiles('travel');
  const client = await connectTravel(url);
  const before = await history(client, files).finally(() => client.end());
  const pending = files.map((f) => f.version).filter((v) => !before.includes(v));
  console.log(`travel_db: đã có ${before.join(',') || '—'} · chờ ${pending.join(',') || 'không'}`);
  if (values['dry-run'] || !pending.length) process.exit(0);
  const started = performance.now();
  const after = await migrate('travel', url, files);
  console.log(`Xong: ${after.join(',')} (${Math.round(performance.now() - started)} ms)`);
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
}
