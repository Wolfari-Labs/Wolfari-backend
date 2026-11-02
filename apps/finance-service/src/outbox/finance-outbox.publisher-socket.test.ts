import 'reflect-metadata';
import { createServer, type Socket } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { FinanceOutboxPublisher } from './finance-outbox.publisher';
import { validateFinanceEvent } from './finance-outbox.event';
const id = '00000000-0000-4000-8000-000000000001';
const event = () =>
  validateFinanceEvent({
    event_id: id,
    event_type: 'FinanceClosed',
    schema_version: 1,
    occurred_at: '2026-10-25T00:00:00.123456Z',
    producer: 'Finance',
    aggregate_type: 'Fund',
    aggregate_id: id,
    aggregate_version: 1,
    correlation_id: id,
    causation_id: null,
    operation_id: null,
    trip_id: id,
    actor_user_id: id,
    system_actor: null,
    payload: { fund_id: id, trip_id: id, closure_id: id, finance_version: 1 },
  });

describe('Finance publisher installed socket cancellation', () => {
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
        socket.on('data', () => {}); // Read protocol bytes but intentionally never speak AMQP.
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('Expected test TCP port');
      const publisher = new FinanceOutboxPublisher(
        new ConfigService({ RABBITMQ_URL: 'amqp://fixture:synthetic@127.0.0.1:' + address.port }),
      );
      try {
        const started = Date.now();
        const result = publisher.publish(event()).then(
          () => 'ok',
          (error) => (error as Error).message,
        );
        await vi.waitFor(() => expect(accepted).toBe(1));
        if (mode === 'shutdown') await publisher.close();
        expect(await result).toBe('FINANCE_OUTBOX_PUBLISH_FAILED');
        await vi.waitFor(() => expect(sockets.size).toBe(0));
        expect(Date.now() - started).toBeLessThan(mode === 'shutdown' ? 1500 : 6000);
        expect(publisher.connected).toBe(false);
      } finally {
        await publisher.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    8000,
  );
});
