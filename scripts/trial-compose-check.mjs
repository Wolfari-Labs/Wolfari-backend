// Static Compose validation with disposable, generated credentials. Does not use Docker daemon.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { initTrial, composeArgs } from './trial.mjs';
const scratch = await mkdtemp(join(tmpdir(), 'wolfari-compose-check-'));
try {
  const directory = join(scratch, 'config');
  await initTrial(directory);
  const model = JSON.parse(
    execFileSync('docker', composeArgs(directory, ['config', '--format', 'json']), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  for (const name of ['postgres', 'rabbitmq', 'minio']) {
    const service = model.services[name];
    assert.equal(service.restart, 'unless-stopped');
    for (const port of service.ports) assert.equal(port.host_ip, '127.0.0.1');
    assert.equal(service.logging.options['max-size'], '10m');
  }
  if (model.services.mailpit)
    assert.deepEqual(model.services.mailpit.profiles, ['local-mail-only']);
  assert.equal(model.services.rabbitmq.hostname, 'wolfari-trial-rabbitmq');
  for (const name of ['postgres_data', 'rabbitmq_data', 'minio_data'])
    assert.equal(model.volumes[name].name, `wolfari-trial_${name}`);
  console.log(
    'PASS static Compose model (loopback, restart, logs, volumes, no default Mailpit); daemon/runtime NOT tested.',
  );
} catch {
  // The rendered Compose model contains throwaway secrets; never echo it or tool stderr.
  console.error(
    'FAIL static Compose check; verify Compose plugin is installed. No credentials printed.',
  );
  process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
