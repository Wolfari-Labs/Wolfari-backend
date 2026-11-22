#!/usr/bin/env node
// POI-OVERTURE pipeline: [download] → export golden → build (O2–O4 files) → load (inactive snapshot).
// Usage: corepack pnpm poi:overture --release <R> [--from-raw] [--golden-snapshot <version>]
//          [--dry-run] [--replace] [--env <travel .env>] [--coast-m 300] [--memory 2GB]
//   --from-raw   re-run O2–O4 from the raw parquet already on disk (never downloads)
//   --dry-run    stop after the build (files and reports only; nothing written to travel_db)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { root } from '../config.mjs';
import { safeError } from '../migrations.mjs';
import { DEFAULT_ENV, connectTravel, exportGolden, travelUrl } from './poi-db.mjs';

const { values: args } = parseArgs({
  options: {
    release: { type: 'string' },
    'from-raw': { type: 'boolean', default: false },
    'golden-snapshot': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    replace: { type: 'boolean', default: false },
    env: { type: 'string', default: DEFAULT_ENV },
    'coast-m': { type: 'string', default: '300' },
    memory: { type: 'string', default: '2GB' },
  },
});

const node = (script, list) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, script), ...list], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${script} thoát mã ${code}`))));
  });

async function main() {
  const release = args.release;
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(release ?? '')) throw new Error('Cần --release <YYYY-MM-DD.n>');
  const raw = resolve(root, `.local/poi/overture/raw-vn-bbox-${release}.parquet`);
  if (!existsSync(raw)) {
    if (args['from-raw']) throw new Error(`--from-raw nhưng chưa có ${raw}`);
    await node('overture-download.mjs', ['--release', release, '--memory', args.memory]);
  }

  const client = await connectTravel(await travelUrl(args.env));
  let golden;
  try {
    golden = await exportGolden(client, args['golden-snapshot']);
  } finally {
    await client.end();
  }
  const goldenFile = resolve(root, `.local/poi/overture/golden-${golden.snapshot.version}.json`);
  await mkdir(resolve(root, '.local/poi/overture'), { recursive: true });
  await writeFile(goldenFile, `${JSON.stringify(golden.rows, null, 1)}\n`);
  console.log(`Golden: ${golden.rows.length} điểm từ ${golden.snapshot.version}`);

  await node('overture-build.mjs', ['--release', release, '--golden', goldenFile, '--coast-m', args['coast-m'], '--memory', args.memory]);
  if (args['dry-run']) {
    console.log('--dry-run: dừng sau build, không ghi travel_db.');
    return;
  }
  await node('overture-load.mjs', [
    '--release',
    release,
    '--golden-snapshot',
    golden.snapshot.version,
    '--env',
    args.env,
    ...(args.replace ? ['--replace'] : []),
  ]);
}

main().catch((error) => {
  const message = String(error?.message ?? '');
  console.error(/^(Cần|--from-raw|Không|Snapshot|Thiếu cấu hình|overture-)/.test(message) ? message : safeError(error));
  process.exitCode = 1;
});
