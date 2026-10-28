import 'reflect-metadata';
import { createServer, type Socket } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { FinanceNotificationConsumer } from './finance-notification.consumer';

describe('Finance inbox installed socket cancellation', () => {
  it.each(['handshake-timeout', 'shutdown'] as const)(
    'closes a real stalled TCP handshake on %s',
    async (mode) => {
      const sockets = new Set<Socket>();
      let accepted = 0;
      const server = createServer((socket) => {
        accepted++;
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
        socket.on('data', () => {});
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('Expected test TCP port');
      const consumer = new FinanceNotificationConsumer(
        new ConfigService({
          AUTOMATION_FINANCE_NOTIFICATION_ENABLED: 'true',
          RABBITMQ_URL: `amqp://fixture:synthetic@127.0.0.1:${address.port}`,
        }),
        { process: vi.fn() },
      );
      try {
        const started = Date.now();
        consumer.onApplicationBootstrap();
        await vi.waitFor(() => expect(accepted).toBe(1));
        if (mode === 'shutdown') await consumer.onApplicationShutdown();
        await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 6000 });
        expect(Date.now() - started).toBeLessThan(mode === 'shutdown' ? 1500 : 6000);
        expect(consumer.connected).toBe(false);
      } finally {
        await consumer.onApplicationShutdown();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    8000,
  );
});
