import { createServer, type Server } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Integration helper is native ESM JavaScript.
import { createTestPortAllocator } from './test-ports.mjs';

describe('isolated integration port allocation', () => {
  it('rejects a previously chosen OS candidate instead of assigning two listeners one port', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(31000)
      .mockResolvedValueOnce(31000)
      .mockResolvedValueOnce(31001);
    const port = createTestPortAllocator({ probe });
    expect(await port()).toBe(31000);
    expect(await port()).toBe(31001);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('keeps concurrent allocations distinct when probes return the same candidate', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(31000)
      .mockResolvedValueOnce(31000)
      .mockResolvedValueOnce(31001);
    const port = createTestPortAllocator({ probe });
    expect(await Promise.all([port(), port()])).toEqual([31000, 31001]);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('fails after a bounded number of duplicate probes and retains earlier choices', async () => {
    const probe = vi.fn().mockResolvedValue(31000);
    const port = createTestPortAllocator({ probe, maxAttempts: 3 });
    expect(await port()).toBe(31000);
    await expect(port()).rejects.toThrow('TEST_PORT_ALLOCATION_EXHAUSTED');
    expect(probe).toHaveBeenCalledTimes(4);
    probe.mockResolvedValueOnce(31000).mockResolvedValueOnce(31001);
    expect(await port()).toBe(31001);
    expect(probe).toHaveBeenCalledTimes(6);
  });

  it('propagates probe failures without retrying or consuming a port', async () => {
    const failure = new Error('synthetic bind failure');
    const probe = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(31000);
    const port = createTestPortAllocator({ probe });
    await expect(port()).rejects.toBe(failure);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(await port()).toBe(31000);
  });

  it.each([0, Infinity, 1001])(
    'rejects an unbounded or invalid attempt limit %s',
    (maxAttempts) => {
      expect(() => createTestPortAllocator({ maxAttempts })).toThrow(
        'INVALID_TEST_PORT_ATTEMPT_LIMIT',
      );
    },
  );

  it('closes real loopback probes so each chosen port can be bound by its listener', async () => {
    const port = createTestPortAllocator();
    const servers: Server[] = [];
    const chosen: number[] = [];
    try {
      for (let index = 0; index < 3; index++) {
        const candidate = await port();
        chosen.push(candidate);
        const server = createServer((socket) => socket.destroy());
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(candidate, '127.0.0.1', resolve);
        });
      }
      expect(new Set(chosen).size).toBe(3);
      expect(servers.every((server) => server.listening)).toBe(true);
    } finally {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => {
                if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING')
                  reject(error);
                else resolve();
              });
            }),
        ),
      );
    }
  });
});
