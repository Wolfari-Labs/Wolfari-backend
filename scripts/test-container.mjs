import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

// Restart the existing container, without Compose-version-dependent start flags
// or recreating the volume whose recovery the integration test must verify.
export async function startTestService(project, service, execute = executeFile) {
  if (
    !/^wolfari-(?:test-[a-f0-9]{12}|trip-test-[a-f0-9]{10})$/.test(project) ||
    !['postgres', 'rabbitmq', 'mailpit'].includes(service)
  ) {
    throw new Error('UNSAFE_TEST_CONTAINER_TARGET');
  }
  const options = { windowsHide: true, timeout: 30_000, maxBuffer: 65_536 };
  const { stdout } = await execute(
    'docker',
    [
      'ps',
      '--all',
      '--quiet',
      '--no-trunc',
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--filter',
      `label=com.docker.compose.service=${service}`,
    ],
    options,
  );
  const ids = stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length !== 1 || !/^[a-f0-9]{64}$/.test(ids[0])) {
    throw new Error(`TEST_CONTAINER_NOT_UNIQUE: ${project}/${service}`);
  }
  await execute('docker', ['start', ids[0]], options);
  // The caller must still verify SQL/SMTP/AMQP readiness and preserved data.
}
