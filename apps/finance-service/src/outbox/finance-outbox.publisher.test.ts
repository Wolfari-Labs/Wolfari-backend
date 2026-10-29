import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinanceOutboxPublisher } from './finance-outbox.publisher';
import { validateFinanceEvent } from './finance-outbox.event';
const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('amqplib', () => ({ connect: mocks.connect }));
const id = '00000000-0000-4000-8000-000000000001';
function event() {
  return validateFinanceEvent({
    event_id: id,
    event_type: 'ContributionUpdated',
    schema_version: 1,
    occurred_at: '2026-10-25T10:00:00.123456Z',
    producer: 'Finance',
    aggregate_type: 'Fund',
    aggregate_id: id,
    aggregate_version: 7,
    correlation_id: id,
    causation_id: null,
    operation_id: null,
    trip_id: id,
    actor_user_id: id,
    system_actor: null,
    payload: {
      fund_id: id,
      trip_id: id,
      contribution_id: id,
      status: 'PENDING',
      finance_version: 7,
    },
  });
}
function broker() {
  const channel = Object.assign(new EventEmitter(), {
    assertExchange: vi.fn().mockResolvedValue({ exchange: 'wolfari.events.v1' }),
    publish: vi.fn(),
  });
  const connection = Object.assign(new EventEmitter(), {
    createConfirmChannel: vi.fn().mockResolvedValue(channel),
  });
  let signal: AbortSignal | undefined;
  mocks.connect.mockImplementation(async (_url, options) => {
    signal = options.signal;
    return connection;
  });
  const publisher = new FinanceOutboxPublisher(
    new ConfigService({ RABBITMQ_URL: 'amqp://user:private-password@127.0.0.1:5672' }),
  );
  return { channel, connection, publisher, signal: () => signal };
}
const confirm = (channel: ReturnType<typeof broker>['channel'], error?: Error) =>
  channel.publish.mock.calls.at(-1)![4](error ?? null, {});
async function publishing() {
  const s = broker();
  const work = s.publisher.publish(event());
  const result = work.then(
    () => 'ok',
    (error) => (error as Error).message,
  );
  await vi.waitFor(() => expect(s.channel.publish).toHaveBeenCalledTimes(1));
  return { ...s, work, result };
}
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Finance outbox confirm transport', () => {
  it('waits for confirm and publishes an unchanged persistent mandatory envelope', async () => {
    const s = await publishing();
    let completed = false;
    void s.work.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    const [exchange, key, body, options] = s.channel.publish.mock.calls[0]!;
    expect(exchange).toBe('wolfari.events.v1');
    expect(key).toBe(event().event_type);
    expect(JSON.parse(body.toString())).toEqual(event());
    expect(options).toEqual({
      persistent: true,
      mandatory: true,
      messageId: id,
      contentType: 'application/json',
      contentEncoding: 'utf-8',
    });
    expect(s.channel.assertExchange).toHaveBeenCalledWith('wolfari.events.v1', 'topic', {
      durable: true,
    });
    confirm(s.channel);
    expect(await s.result).toBe('ok');
    expect(s.publisher.connected).toBe(true);
    expect(s.channel.listenerCount('return')).toBe(0);
    await s.publisher.close();
    expect(s.signal()?.aborted).toBe(true);
  });
  it('treats a mandatory return followed by positive confirm as failure', async () => {
    const s = await publishing();
    s.channel.emit('return', { properties: { messageId: id } });
    confirm(s.channel);
    expect(await s.result).toBe('FINANCE_OUTBOX_PUBLISH_FAILED');
    expect(s.signal()?.aborted).toBe(true);
    expect(s.publisher.connected).toBe(false);
  });
  it('does not mistake an unrelated returned message for this event', async () => {
    const s = await publishing();
    s.channel.emit('return', { properties: { messageId: 'different' } });
    confirm(s.channel);
    expect(await s.result).toBe('ok');
    await s.publisher.close();
  });
  it('does not interpret a false publish boolean as broker rejection', async () => {
    const s = broker();
    s.channel.publish.mockReturnValue(false);
    const work = s.publisher.publish(event());
    await vi.waitFor(() => expect(s.channel.publish).toHaveBeenCalledOnce());
    confirm(s.channel);
    await expect(work).resolves.toBeUndefined();
    await s.publisher.close();
  });
  it.each([
    'nack',
    'channel-error',
    'channel-close',
    'connection-error',
    'connection-close',
    'blocked',
  ])('invalidates the session on %s without exposing broker credentials', async (condition) => {
    const s = await publishing();
    if (condition === 'nack') confirm(s.channel, new Error('private-password'));
    else if (condition.startsWith('channel'))
      s.channel.emit(
        condition.endsWith('error') ? 'error' : 'close',
        new Error('private-password'),
      );
    else
      s.connection.emit(
        condition === 'blocked' ? 'blocked' : condition.endsWith('error') ? 'error' : 'close',
        new Error('private-password'),
      );
    expect(await s.result).toBe('FINANCE_OUTBOX_PUBLISH_FAILED');
    expect(s.signal()?.aborted).toBe(true);
    expect(s.publisher.connected).toBe(false);
    expect(s.channel.listenerCount('return')).toBe(0);
  });
  it('bounds a lost confirm, ignores a late acknowledgement and opens a new session', async () => {
    const next = broker();
    vi.useFakeTimers();
    const work = next.publisher.publish(event()).then(
      () => 'ok',
      (error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(next.channel.publish).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await work).toBe('FINANCE_OUTBOX_PUBLISH_FAILED');
    confirm(next.channel);
    expect(next.publisher.connected).toBe(false);
    const again = next.publisher.publish(event());
    await vi.advanceTimersByTimeAsync(0);
    confirm(next.channel);
    await expect(again).resolves.toBeUndefined();
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    await next.publisher.close();
  });
  it.each(['connect', 'channel', 'exchange'])(
    'bounds a stalled %s setup and aborts its socket',
    async (phase) => {
      const s = broker();
      let signal: AbortSignal | undefined;
      if (phase === 'connect')
        mocks.connect.mockImplementation((_url, options) => {
          signal = options.signal;
          return new Promise(() => {});
        });
      if (phase === 'channel')
        s.connection.createConfirmChannel.mockImplementation(() => new Promise(() => {}));
      if (phase === 'exchange')
        s.channel.assertExchange.mockImplementation(() => new Promise(() => {}));
      vi.useFakeTimers();
      const result = s.publisher.publish(event()).then(
        () => 'ok',
        (error) => error.message,
      );
      await vi.advanceTimersByTimeAsync(5000);
      expect(await result).toBe('FINANCE_OUTBOX_PUBLISH_FAILED');
      expect((signal ?? s.signal())?.aborted).toBe(true);
      expect(s.channel.publish).not.toHaveBeenCalled();
      await s.publisher.close();
    },
  );
  it('rejects concurrent sends and shutdown cancels an undecided publication', async () => {
    const s = await publishing();
    await expect(s.publisher.publish(event())).rejects.toThrow('FINANCE_OUTBOX_PUBLISH_FAILED');
    expect(s.channel.publish).toHaveBeenCalledOnce();
    await s.publisher.close();
    expect(await s.result).toBe('FINANCE_OUTBOX_PUBLISH_FAILED');
    await expect(s.publisher.publish(event())).rejects.toThrow('FINANCE_OUTBOX_PUBLISH_FAILED');
  });
  it('fails safe before connecting for invalid configuration or foreign events', async () => {
    const publisher = new FinanceOutboxPublisher(
      new ConfigService({ RABBITMQ_URL: 'http://private-password@example.test' }),
    );
    await expect(publisher.publish(event())).rejects.toThrow('FINANCE_OUTBOX_PUBLISH_FAILED');
    await expect(publisher.publish({ ...event(), producer: 'Trip' })).rejects.toThrow();
    expect(mocks.connect).not.toHaveBeenCalled();
    await publisher.close();
  });
});
