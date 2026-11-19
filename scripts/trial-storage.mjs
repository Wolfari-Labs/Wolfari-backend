// Run only on the new trial VM. Requires an operator-installed MinIO mc binary.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readEnv, root } from './config.mjs';
import { checkTrial, configDirectory } from './trial.mjs';

const directory = configDirectory();
const configs = await checkTrial(directory);
const infra = await readEnv(resolve(directory, '.env'));
const url = new URL(`http://127.0.0.1:${infra.MINIO_API_PORT}`);
url.username = infra.MINIO_ROOT_USER;
url.password = infra.MINIO_ROOT_PASSWORD;
const env = { ...process.env, MC_HOST_trial: url.href };
async function mc(args) {
  await new Promise((done, reject) => {
    // Suppress tool output: errors from third-party CLI may echo credentials.
    const child = spawn('mc', args, { env, stdio: 'ignore', windowsHide: true });
    child.on('error', () => reject(new Error('MC_NOT_AVAILABLE')));
    child.on('exit', (code) => (code === 0 ? done() : reject(new Error('MC_OPERATION_FAILED'))));
  });
}
try {
  if (process.argv[2] !== 'PROVISION_TRIAL_STORAGE')
    throw new Error('EXPLICIT_PROVISION_CONFIRMATION_REQUIRED');
  for (const [app, buckets, policy] of [
    ['identity-service', ['wolfari-identity-avatars'], 'wolfari-identity'],
    ['finance-service', ['wolfari-finance-receipts'], 'wolfari-finance'],
    [
      'trip-workspace-service',
      ['wolfari-trip-covers', 'wolfari-trip-dress-images'],
      'wolfari-trip',
    ],
  ]) {
    const config = configs.get(app);
    for (const bucket of buckets) {
      await mc(['mb', '--ignore-existing', `trial/${bucket}`]);
      await mc(['anonymous', 'set', 'none', `trial/${bucket}`]);
    }
    await mc([
      'admin',
      'policy',
      'create',
      'trial',
      policy,
      resolve(root, `deployment/minio-${app.split('-')[0]}-policy.json`),
    ]);
    // Explicit command may reapply these trial-only credentials from the active config.
    // Password is never printed/history, but root can inspect the short-lived process argv.
    await mc(['admin', 'user', 'add', 'trial', config.MINIO_ACCESS_KEY, config.MINIO_SECRET_KEY]);
    await mc(['admin', 'policy', 'attach', 'trial', policy, '--user', config.MINIO_ACCESS_KEY]);
  }
  console.log(
    'PASS trial private buckets and scoped users provisioned; verify upload through API.',
  );
} catch {
  console.error(
    'Trial storage provisioning failed. Check mc/root credentials locally; no secrets printed.',
  );
  process.exitCode = 1;
}
