import { spawnSync } from 'node:child_process';

const reference = process.argv[2];
if (!reference || !/^[A-Za-z0-9_./-]+$/.test(reference)) {
  console.error('Usage: node scripts/ci-contract-breaking.mjs <git-ref>');
  process.exit(1);
}

const baseline = spawnSync('git', ['cat-file', '-e', `${reference}:packages/contracts/schemas/events-v1.schema.json`], { stdio: 'ignore' });
if (baseline.status !== 0) {
  console.log(`NOT RUN contract compatibility: ${reference} has no committed contract baseline.`);
  process.exit(0);
}

const result = spawnSync(process.execPath, ['scripts/contracts.mjs', 'breaking', '--against', reference], { stdio: 'inherit' });
process.exit(result.status ?? 1);
