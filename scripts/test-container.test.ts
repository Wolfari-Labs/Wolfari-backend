import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Integration helper is native ESM JavaScript.
import { startTestService } from './test-container.mjs';

const project = 'wolfari-test-0123456789ab';
const containerId = 'a'.repeat(64);

describe('isolated integration container recovery', () => {
  it.each(['postgres', 'rabbitmq', 'mailpit'])(
    'starts the exact existing %s container, including stopped containers',
    async (service) => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce({ stdout: `${containerId}\r\n` })
        .mockResolvedValueOnce({ stdout: containerId });
      await startTestService(project, service, execute);
      expect(execute.mock.calls[0]!.slice(0, 2)).toEqual([
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
      ]);
      expect(execute.mock.calls[1]!.slice(0, 2)).toEqual(['docker', ['start', containerId]]);
      expect(execute.mock.calls[1]![2]).toMatchObject({ windowsHide: true, timeout: 30_000 });
    },
  );

  it('accepts the isolated invitations project name', async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: containerId });
    await startTestService('wolfari-trip-test-0123456789', 'rabbitmq', execute);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each(['', `${containerId}\n${'b'.repeat(64)}`, 'not-a-container-id'])(
    'refuses missing, ambiguous or invalid container IDs',
    async (stdout) => {
      const execute = vi.fn().mockResolvedValue({ stdout });
      await expect(startTestService(project, 'postgres', execute)).rejects.toThrow(
        'TEST_CONTAINER_NOT_UNIQUE',
      );
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['wolfari', 'postgres'],
    ['another-project', 'rabbitmq'],
    [project, 'unknown'],
  ])('refuses targets outside the test project and service allowlist', async (name, service) => {
    const execute = vi.fn();
    await expect(startTestService(name, service, execute)).rejects.toThrow(
      'UNSAFE_TEST_CONTAINER_TARGET',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not hide Docker lookup or start failures', async () => {
    const failure = new Error('Docker unavailable');
    const lookup = vi.fn().mockRejectedValue(failure);
    await expect(startTestService(project, 'postgres', lookup)).rejects.toBe(failure);
    const start = vi
      .fn()
      .mockResolvedValueOnce({ stdout: containerId })
      .mockRejectedValueOnce(failure);
    await expect(startTestService(project, 'postgres', start)).rejects.toBe(failure);
  });
});
