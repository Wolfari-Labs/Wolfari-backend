import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, type ChannelModel, type ConfirmChannel, type Message } from 'amqplib';
import { EVENT_TOPOLOGY } from '@wolfari/contracts/events';
import { validateFinanceEvent } from './finance-outbox.event';

type FinanceEvent = ReturnType<typeof validateFinanceEvent>;
type Session = { abort: AbortController; connection?: ChannelModel; channel?: ConfirmChannel };
const setupTimeoutMs = 5000;
const confirmTimeoutMs = 5000;
const failure = () => new Error('FINANCE_OUTBOX_PUBLISH_FAILED');

/** One in-flight event per publisher; a confirm never substitutes for a consumer acknowledgement. */
@Injectable()
export class FinanceOutboxPublisher {
  private session?: Session;
  private running?: Promise<void>;
  private stopped = false;
  constructor(private readonly config: ConfigService) {}

  get connected(): boolean {
    return Boolean(this.session?.channel && !this.session.abort.signal.aborted);
  }

  async publish(value: FinanceEvent): Promise<void> {
    const event = validateFinanceEvent(value);
    if (this.stopped || this.running) throw failure();
    const running = this.send(event);
    this.running = running;
    try {
      await running;
    } finally {
      if (this.running === running) this.running = undefined;
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.session) this.invalidate(this.session);
    await this.running?.catch(() => {});
  }

  private invalidate(session: Session): void {
    if (this.session === session) this.session = undefined;
    // amqplib forwards socket options to Node net/tls.connect. Abort closes the socket,
    // including during a stalled handshake, without accessing amqplib private fields.
    session.abort.abort();
  }

  private async broker(): Promise<Session> {
    if (this.session?.channel) return this.session;
    if (this.stopped) throw failure();
    const session: Session = { abort: new AbortController() };
    this.session = session;
    let timer: NodeJS.Timeout | undefined;
    const setup = async () => {
      const url = new URL(this.config.get<string>('RABBITMQ_URL') ?? '');
      if (!['amqp:', 'amqps:'].includes(url.protocol)) throw failure();
      if (!url.searchParams.has('heartbeat')) url.searchParams.set('heartbeat', '10');
      const socketOptions = {
        timeout: 2000,
        signal: session.abort.signal,
        noDelay: true,
      };
      const connection = await connect(url.href, socketOptions);
      session.connection = connection;
      connection.on('error', () => this.invalidate(session));
      connection.on('close', () => this.invalidate(session));
      connection.on('blocked', () => this.invalidate(session));
      if (session.abort.signal.aborted || this.stopped) throw failure();
      const channel = await connection.createConfirmChannel();
      channel.on('error', () => this.invalidate(session));
      channel.on('close', () => this.invalidate(session));
      if (session.abort.signal.aborted || this.stopped) throw failure();
      await channel.assertExchange(EVENT_TOPOLOGY.exchange.name, EVENT_TOPOLOGY.exchange.type, {
        durable: true,
      });
      if (session.abort.signal.aborted || this.stopped) throw failure();
      session.channel = channel;
      return session;
    };
    try {
      return await Promise.race([
        setup(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.invalidate(session);
            reject(failure());
          }, setupTimeoutMs);
        }),
      ]);
    } catch {
      this.invalidate(session);
      throw failure();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async send(event: FinanceEvent): Promise<void> {
    const session = await this.broker();
    const channel = session.channel!;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          channel.off('return', onReturn);
          session.abort.signal.removeEventListener('abort', onAbort);
          if (error) reject(error);
          else resolve();
        };
        const onAbort = () => finish(failure());
        const onReturn = (message: Message) => {
          if (message.properties.messageId === event.event_id) finish(failure());
        };
        const timer = setTimeout(() => finish(failure()), confirmTimeoutMs);
        channel.on('return', onReturn);
        session.abort.signal.addEventListener('abort', onAbort, { once: true });
        if (session.abort.signal.aborted || this.stopped) {
          finish(failure());
          return;
        }
        try {
          // The boolean is backpressure only. With one in flight, wait for this confirm
          // before sending another event, even when publish() returns false.
          channel.publish(
            EVENT_TOPOLOGY.exchange.name,
            event.event_type,
            Buffer.from(JSON.stringify(event)),
            {
              persistent: true,
              mandatory: true,
              messageId: event.event_id,
              contentType: 'application/json',
              contentEncoding: 'utf-8',
            },
            (error) => finish(error ? failure() : undefined),
          );
        } catch {
          finish(failure());
        }
      });
    } catch {
      this.invalidate(session);
      throw failure();
    }
  }
}
