import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { ConsumeMessage } from 'amqplib';
import { FinanceNotificationConsumer } from './finance-notification.consumer';
import {
  FINANCE_NOTIFICATION_QUEUE as queue,
  FINANCE_NOTIFICATION_ATTEMPT as attempt,
} from './finance-notification.event';

const broker = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('amqplib', () => ({ connect: broker.connect }));
const workers: FinanceNotificationConsumer[] = [];
let receive: (message: ConsumeMessage | null) => void;
let channel: EventEmitter & Record<string, ReturnType<typeof vi.fn>>;
let connection: EventEmitter & { createConfirmChannel: ReturnType<typeof vi.fn> };
let signal: AbortSignal;
const drain = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  channel = Object.assign(
    new EventEmitter(),
    Object.fromEntries(
      [
        'assertExchange',
        'assertQueue',
        'bindQueue',
        'prefetch',
        'consume',
        'sendToQueue',
        'ack',
      ].map((key) => [key, vi.fn().mockResolvedValue({})]),
    ),
  ) as typeof channel;
  channel.consume.mockImplementation(async (_name, callback) => {
    receive = callback;
    return { consumerTag: 'test' };
  });
  channel.sendToQueue.mockImplementation((_target, _body, _options, callback) => {
    callback(null);
    return false;
  });
  connection = Object.assign(new EventEmitter(), {
    createConfirmChannel: vi.fn().mockResolvedValue(channel),
  });
  broker.connect.mockImplementation(async (_url, options) => {
    signal = options.signal;
    signal.addEventListener('abort', () => connection.emit('close'), { once: true });
    return connection;
  });
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.onApplicationShutdown()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function start(enabled = 'true') {
  const service = { process: vi.fn().mockResolvedValue(undefined) };
  const worker = new FinanceNotificationConsumer(
    new ConfigService({
      AUTOMATION_FINANCE_NOTIFICATION_ENABLED: enabled,
      RABBITMQ_URL: 'amqp://127.0.0.1',
    }),
    service,
  );
  workers.push(worker);
  worker.onApplicationBootstrap();
  await drain();
  return { worker, service };
}
function message(headers: Record<string, unknown> = {}): ConsumeMessage {
  const fund = randomUUID(),
    trip = randomUUID();
  const content = {
    event_id: randomUUID(),
    event_type: 'ContributionRequested',
    schema_version: 1,
    occurred_at: '2026-10-28T12:00:00Z',
    producer: 'Finance',
    aggregate_type: 'Fund',
    aggregate_id: fund,
    aggregate_version: 1,
    correlation_id: randomUUID(),
    trip_id: trip,
    actor_user_id: randomUUID(),
    causation_id: null,
    operation_id: null,
    system_actor: null,
    payload: {
      fund_id: fund,
      trip_id: trip,
      request_id: randomUUID(),
      contribution_ids: [randomUUID()],
      finance_version: 1,
    },
  };
  return {
    content: Buffer.from(JSON.stringify(content)),
    properties: { headers, messageId: content.event_id },
    fields: {},
  } as ConsumeMessage;
}
describe('Finance notification broker ownership and acknowledgements', () => {
  it('does not connect or provision queues when disabled', async () => {
    const h = await start('false');
    expect(h.worker.connected).toBe(false);
    expect(broker.connect).not.toHaveBeenCalled();
  });
  it('owns only the contribution queue and provisions durable, safe TTL transfers', async () => {
    const h = await start();
    expect(h.worker.connected).toBe(true);
    expect(channel.bindQueue.mock.calls).toEqual([
      [queue, 'wolfari.events.v1', 'ContributionRequested'],
    ]);
    const retry = channel.assertQueue.mock.calls.filter((call) =>
      String(call[0]).includes('.retry.'),
    );
    expect(retry.map((call) => call[1].messageTtl)).toEqual([10000, 30000, 120000, 300000, 900000]);
    for (const [, options] of retry)
      expect(options).toMatchObject({
        durable: true,
        deadLetterRoutingKey: queue,
        arguments: {
          'x-queue-type': 'quorum',
          'x-dead-letter-strategy': 'at-least-once',
          'x-overflow': 'reject-publish',
        },
      });
    h.worker.onApplicationBootstrap();
    expect(broker.connect).toHaveBeenCalledOnce();
  });
  it('ACKs only after the local transaction promise completes', async () => {
    const h = await start();
    let complete!: () => void;
    h.service.process.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const value = message();
    receive(value);
    await drain();
    expect(channel.ack).not.toHaveBeenCalled();
    complete();
    await drain();
    expect(channel.ack).toHaveBeenCalledWith(value);
  });
  it('keeps original body/event identity and waits for retry confirmation before ACK', async () => {
    const h = await start();
    h.service.process.mockRejectedValue(new Error('PRIVATE SQL ERROR'));
    let confirm!: (error: Error | null) => void;
    channel.sendToQueue.mockImplementation((_target, _body, _options, callback) => {
      confirm = callback;
      return false;
    });
    const value = message();
    receive(value);
    await drain();
    expect(channel.ack).not.toHaveBeenCalled();
    const [target, body, options] = channel.sendToQueue.mock.calls[0]!;
    expect(target).toBe(`${queue}.retry.0`);
    expect(body).toBe(value.content);
    expect(options).toMatchObject({
      persistent: true,
      mandatory: true,
      messageId: value.properties.messageId,
      headers: { [attempt]: 1 },
    });
    expect(JSON.stringify(options)).not.toContain('PRIVATE');
    confirm(null);
    await drain();
    expect(channel.ack).toHaveBeenCalledWith(value);
  });
  it.each([0, 1, 2, 3, 4, 5])(
    'routes failed attempt %i to its bounded retry or DLQ',
    async (count) => {
      const h = await start();
      h.service.process.mockRejectedValue(new Error('unavailable'));
      receive(message({ [attempt]: count }));
      await drain();
      expect(channel.sendToQueue.mock.calls[0]![0]).toBe(
        count === 5 ? `${queue}.dlq` : `${queue}.retry.${count}`,
      );
      expect(channel.ack).toHaveBeenCalledOnce();
    },
  );
  it.each([-1, '1', 1.5, 6, null])(
    'puts malformed attempt %j into retained DLQ without processing',
    async (count) => {
      const h = await start();
      const value = message({ [attempt]: count });
      receive(value);
      await drain();
      expect(h.service.process).not.toHaveBeenCalled();
      expect(channel.sendToQueue.mock.calls[0]![0]).toBe(`${queue}.dlq`);
      expect(channel.ack).toHaveBeenCalledOnce();
    },
  );
  it('retains poison on its original queue if even DLQ transfer is unconfirmed', async () => {
    await start();
    channel.sendToQueue.mockImplementation((_target, _body, _options, callback) =>
      callback(new Error('broker')),
    );
    const value = message();
    value.content = Buffer.from('{}');
    receive(value);
    await drain();
    expect(channel.ack).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(true);
  });
  it('a mandatory return overrides positive confirm without acknowledging original', async () => {
    const h = await start();
    h.service.process.mockRejectedValue(new Error('outage'));
    channel.sendToQueue.mockImplementation((_target, _body, options, callback) => {
      channel.emit('return', { properties: options });
      callback(null);
      return true;
    });
    receive(message());
    await drain();
    expect(channel.ack).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(true);
  });
  it('bounds a missing confirm and resets the session', async () => {
    vi.useFakeTimers();
    const h = await start();
    h.service.process.mockRejectedValue(new Error('outage'));
    channel.sendToQueue.mockImplementation(() => true);
    receive(message());
    await drain();
    await vi.advanceTimersByTimeAsync(5000);
    expect(channel.ack).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(true);
  });
  it('shutdown aborts an in-flight transfer and leaves the original unacked', async () => {
    const h = await start();
    h.service.process.mockRejectedValue(new Error('outage'));
    channel.sendToQueue.mockImplementation(() => true);
    receive(message());
    await drain();
    await h.worker.onApplicationShutdown();
    expect(channel.ack).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(true);
  });
  it('handles broker consumer cancellation by reconnecting rather than reporting readiness', async () => {
    const h = await start();
    receive(null);
    expect(h.worker.connected).toBe(false);
  });
  it('bounds a stalled connection handshake', async () => {
    vi.useFakeTimers();
    broker.connect.mockImplementation(() => new Promise(() => {}));
    const h = await start();
    const closing = h.worker.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(5000);
    await closing;
    expect(h.worker.connected).toBe(false);
  });
});
