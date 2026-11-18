#!/usr/bin/env node
// POI snapshots in travel_db.
//   corepack pnpm poi:snapshots [--env <travel .env>]
//   corepack pnpm poi:activate <version|id> [--env <travel .env>]
// Activation is one transaction (no restart needed): the previous snapshot stays in the
// database, so rolling back is activating it again.
import { parseArgs } from 'node:util';
import { safeError } from '../migrations.mjs';
import {
  DEFAULT_ENV,
  activateSnapshot,
  connectTravel,
  listSnapshots,
  pruneSnapshots,
  travelUrl,
} from './poi-db.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: 'string', default: DEFAULT_ENV },
    'dry-run': { type: 'boolean', default: false },
  },
});
const [command, ref] = positionals;

async function main() {
  if (!['list', 'activate', 'prune'].includes(command))
    throw new Error('Lệnh: list | activate <snapshot> | prune [--dry-run]');
  if (command === 'activate' && !ref) throw new Error('Lệnh: corepack pnpm poi:activate <version|id>');
  const client = await connectTravel(await travelUrl(values.env), {
    statementTimeout: command === 'prune' ? '30min' : '30s',
  });
  try {
    if (command === 'prune') {
      const dryRun = values['dry-run'];
      const { kept, removed, skipped } = await pruneSnapshots(client, { keep: 1, dryRun });
      const line = (r) => `${r.version} (${r.pois} POI${r.active ? ', ACTIVE' : ''})`;
      console.log(`Giữ: ${kept.map(line).join('; ') || 'không có'}`);
      console.log(`${dryRun ? 'Sẽ xóa' : 'Đã xóa'}: ${removed.map(line).join('; ') || 'không có'}`);
      if (skipped.length) console.log(`Bỏ qua (đang nạp): ${skipped.map(line).join('; ')}`);
      if (dryRun) console.log('--dry-run: không xóa gì.');
      return;
    }
    if (command === 'list') {
      const rows = await listSnapshots(client);
      console.table(
        rows.map((r) => ({
          version: r.version,
          id: r.id,
          kind: r.kind,
          status: r.status,
          pois: r.pois,
          golden: r.golden,
          active: r.active ? 'ACTIVE' : '',
          loaded_at: new Date(r.created_at).toISOString(),
        })),
      );
      return;
    }
    const started = performance.now();
    const { previous, current } = await activateSnapshot(client, ref);
    const ms = Math.round(performance.now() - started);
    console.log(`Snapshot active: ${current} (trước đó: ${previous ?? 'không có'}) · ${ms} ms`);
    if (previous && previous !== current)
      console.log(`Quay lại: corepack pnpm poi:activate ${previous}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  const message = String(error?.message ?? '');
  console.error(/^(Không có|Không|Snapshot|Lệnh|Thiếu cấu hình)/.test(message) ? message : safeError(error));
  process.exitCode = 1;
});
