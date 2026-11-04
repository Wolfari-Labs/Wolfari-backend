import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSeedJournal } from './demo-accounts.mjs';
import { demoRoot } from './demo-config.mjs';
import { login } from './demo-scenarios.mjs';

export async function runDemoCollection(demo) {
  const localTools = createRequire(resolve(demoRoot, 'tools/package.json'));
  let newman;
  try {
    newman = localTools('newman');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    throw new Error(
      'DEMO_NEWMAN_MISSING: npm install --prefix .local/demo/tools --ignore-scripts --no-audit --no-fund newman@6.2.1',
    );
  }
  const reports = resolve(demoRoot, 'reports');
  const source = JSON.parse(
    await readFile(resolve(reports, 'finance-price-watch-latest.json'), 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      throw new Error('DEMO_RUN_REQUIRED: run demo:finance-price-watch first');
    }),
  );
  if (
    source.instanceId !== demo.manifest.instanceId ||
    !source.resources?.tripId ||
    source.checks.some((row) => row.status !== 'PASS') ||
    source.checks.filter((row) => /^API\d{2}\b/.test(row.name)).length !== 12
  ) {
    throw new Error('DEMO_RUN_REQUIRED: run demo:finance-price-watch for this instance');
  }
  const seed = JSON.parse(await readFile(resolve(demoRoot, 'seed.json'), 'utf8'));
  validateSeedJournal(seed, demo.manifest.instanceId);
  const owner = await login(seed.accounts.owner);
  const collection = fileURLToPath(
    new URL('../docs/api/finance-price-watch.postman_collection.json', import.meta.url),
  );
  const startedAt = new Date().toISOString();
  const summary = await new Promise((accept, reject) => {
    newman.run(
      {
        collection,
        envVar: [
          { key: 'tripId', value: source.resources.tripId },
          { key: 'accessToken', value: owner.access },
        ],
        reporters: [],
        timeout: 60000,
        timeoutRequest: 10000,
        ignoreRedirects: true,
      },
      (error, result) => (error ? reject(error) : accept(result)),
    );
  });
  // Newman also retains private HTTP headers in its summary. Export only these public fields.
  const checks = summary.run.executions.map((run) => ({
    request: run.item.name,
    http: run.response?.code ?? null,
    assertions: (run.assertions ?? []).map((check) => ({
      name: check.assertion,
      status: check.error ? 'FAIL' : check.skipped ? 'SKIP' : 'PASS',
    })),
  }));
  const passed =
    summary.run.failures.length === 0 &&
    checks.length === 5 &&
    checks.every(
      (check) =>
        check.http === 200 &&
        check.assertions.length === 2 &&
        check.assertions.every((item) => item.status === 'PASS'),
    );
  const runId = randomUUID();
  const evidence =
    JSON.stringify(
      {
        runId,
        sourceRunId: source.runId,
        backendSha: source.backendSha,
        sourceUncommittedChanges: source.uncommittedChanges,
        tripId: source.resources.tripId,
        tool: 'Newman',
        version: localTools('newman/package.json').version,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: passed ? 'PASS' : 'FAIL',
        checks,
      },
      null,
      2,
    ) + '\n';
  await writeFile(resolve(reports, `postman-${runId}.json`), evidence, { flag: 'wx' });
  await writeFile(resolve(reports, 'postman-latest.json'), evidence);
  for (const check of checks)
    console.log(
      `HTTP ${check.http} ${check.request}: ${check.assertions.map((item) => item.status).join(', ')}`,
    );
  if (!passed) throw new Error('DEMO_POSTMAN_FAILED: see .local/demo/reports/postman-latest.json');
  console.log('PASS Postman collection. Redacted report: .local/demo/reports/postman-latest.json');
}
