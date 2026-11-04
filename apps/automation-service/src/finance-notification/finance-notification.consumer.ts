import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  connect,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
  type Message,
} from 'amqplib';
import { randomUUID } from 'node:crypto';
import { EVENT_TOPOLOGY } from '@wolfari/contracts/events';
import { FinanceNotificationService } from './finance-notification.service';
import {
  financeNotificationEvent,
  FINANCE_NOTIFICATION_QUEUE as queue,
  FINANCE_NOTIFICATION_ATTEMPT as attemptHeader,
  notificationEnabled,
  InvalidFinanceNotificationEvent,
} from './finance-notification.event';

type Session = {
  abort: AbortController;
  connection?: ChannelModel;
  channel?: ConfirmChannel;
  ready?: boolean;
};
const failed = () => new Error('FINANCE_NOTIFICATION_BROKER_UNAVAILABLE');
const transferHeader = 'x-finance-notification-transfer';

@Injectable()
export class FinanceNotificationConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(FinanceNotificationConsumer.name);
  private readonly enabled: boolean;
  private session?: Session;
  private connecting?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly config: ConfigService,
    @Inject(FinanceNotificationService)
    private readonly service: Pick<FinanceNotificationService, 'process'>,
  ) {
    this.enabled = notificationEnabled(config.get('AUTOMATION_FINANCE_NOTIFICATION_ENABLED'));
  }

  get connected(): boolean {
    return Boolean(this.session?.ready && !this.session.abort.signal.aborted);
  }

  onApplicationBootstrap(): void {
    if (!this.enabled || this.timer || this.stopped) return;
    const kick = () => {
      if (this.stopped || this.session || this.connecting || this.inflight.size) return;
      this.connecting = this.open()
        .catch(() => this.logger.warn('FINANCE_NOTIFICATION_BROKER_UNAVAILABLE'))
        .finally(() => {
          this.connecting = undefined;
        });
    };
    this.timer = setInterval(kick, 3000);
    this.timer.unref();
    kick();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.session) this.invalidate(this.session);
    await this.connecting;
    await Promise.allSettled([...this.inflight]);
  }

  private invalidate(session: Session): void {
    if (this.session === session) this.session = undefined;
    session.abort.abort();
  }

  private async open(): Promise<void> {
    const session: Session = { abort: new AbortController() };
    this.session = session;
    let timer: NodeJS.Timeout | undefined;
    const setup = async () => {
      const url = new URL(this.config.get<string>('RABBITMQ_URL') ?? '');
      if (!['amqp:', 'amqps:'].includes(url.protocol)) throw failed();
      if (!url.searchParams.has('heartbeat')) url.searchParams.set('heartbeat', '10');
      const socketOptions = { timeout: 2000, signal: session.abort.signal, noDelay: true };
      session.connection = await connect(url.href, socketOptions);
      const invalid = () => this.invalidate(session);
      session.connection.on('error', invalid);
      session.connection.on('close', invalid);
      session.connection.on('blocked', invalid);
      if (session.abort.signal.aborted) throw failed();
      const channel = await session.connection.createConfirmChannel();
      session.channel = channel;
      channel.on('error', invalid);
      channel.on('close', invalid);
      await channel.assertExchange(EVENT_TOPOLOGY.exchange.name, EVENT_TOPOLOGY.exchange.type, {
        durable: true,
      });
      const durable = {
        durable: true,
        arguments: { 'x-queue-type': 'quorum', 'x-delivery-limit': -1 },
      };
      await channel.assertQueue(queue, durable);
      await channel.assertQueue(`${queue}.dlq`, durable);
      await channel.bindQueue(queue, EVENT_TOPOLOGY.exchange.name, 'ContributionRequested');
      await channel.bindQueue(queue, EVENT_TOPOLOGY.exchange.name, 'ClosureRequested');
      await channel.bindQueue(queue, EVENT_TOPOLOGY.exchange.name, 'ContributionUpdated');
      await channel.bindQueue(queue, EVENT_TOPOLOGY.exchange.name, 'ClosureCancelled');
      await channel.bindQueue(queue, EVENT_TOPOLOGY.exchange.name, 'FinanceClosed');
      for (const [index, delay] of EVENT_TOPOLOGY.retry_delays_ms.entries()) {
        await channel.assertQueue(`${queue}.retry.${index}`, {
          durable: true,
          messageTtl: delay,
          deadLetterExchange: '',
          deadLetterRoutingKey: queue,
          arguments: {
            ...durable.arguments,
            'x-dead-letter-strategy': 'at-least-once',
            'x-overflow': 'reject-publish',
          },
        });
      }
      await channel.prefetch(4);
      if (session.abort.signal.aborted || this.stopped) throw failed();
      await channel.consume(
        queue,
        (message) => {
          if (!message) {
            invalid();
            return;
          }
          const pending = this.consume(session, message)
            .catch(() => {
              invalid();
              this.logger.warn('FINANCE_NOTIFICATION_PROCESSING_UNAVAILABLE');
            })
            .finally(() => this.inflight.delete(pending));
          this.inflight.add(pending);
        },
        { noAck: false, consumerTag: `finance-inbox:${randomUUID()}` },
      );
      if (session.abort.signal.aborted || this.stopped) throw failed();
      session.ready = true;
    };
    try {
      await Promise.race([
        setup(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.invalidate(session);
            reject(failed());
          }, 5000);
        }),
      ]);
    } catch {
      this.invalidate(session);
      throw failed();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async consume(session: Session, message: ConsumeMessage): Promise<void> {
    if (this.stopped || session.abort.signal.aborted) throw failed();
    let event;
    let attempt: number;
    try {
      if (message.content.length > 1024 * 1024) throw new InvalidFinanceNotificationEvent();
      event = financeNotificationEvent(JSON.parse(message.content.toString('utf8')));
      const headers = message.properties.headers;
      const raw = headers && Object.hasOwn(headers, attemptHeader) ? headers[attemptHeader] : 0;
      if (
        typeof raw !== 'number' ||
        !Number.isInteger(raw) ||
        raw < 0 ||
        raw > EVENT_TOPOLOGY.retry_delays_ms.length
      )
        throw new InvalidFinanceNotificationEvent();
      attempt = raw;
    } catch {
      await this.transfer(session, message, `${queue}.dlq`, 0, 'INVALID_EVENT');
      return;
    }
    try {
      await this.service.process(event, session.abort.signal);
    } catch (error) {
      const invalid = error instanceof InvalidFinanceNotificationEvent;
      const exhausted = attempt >= EVENT_TOPOLOGY.retry_delays_ms.length;
      await this.transfer(
        session,
        message,
        invalid || exhausted ? `${queue}.dlq` : `${queue}.retry.${attempt}`,
        invalid || exhausted ? attempt : attempt + 1,
        invalid ? 'INVALID_EVENT' : exhausted ? 'RETRIES_EXHAUSTED' : 'RETRY',
      );
      return;
    }
    if (this.stopped || session.abort.signal.aborted) throw failed();
    session.channel!.ack(message);
  }

  private async transfer(
    session: Session,
    message: ConsumeMessage,
    target: string,
    attempt: number,
    reason: string,
  ): Promise<void> {
    const channel = session.channel!;
    const transferId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.off('return', returned);
        session.abort.signal.removeEventListener('abort', aborted);
        if (error) reject(error);
        else resolve();
      };
      const aborted = () => finish(failed());
      const returned = (value: Message) => {
        if (value.properties.headers?.[transferHeader] === transferId) finish(failed());
      };
      const timer = setTimeout(() => finish(failed()), 5000);
      channel.on('return', returned);
      session.abort.signal.addEventListener('abort', aborted, { once: true });
      if (this.stopped || session.abort.signal.aborted) {
        finish(failed());
        return;
      }
      try {
        channel.sendToQueue(
          target,
          message.content,
          {
            persistent: true,
            mandatory: true,
            messageId: message.properties.messageId,
            contentType: 'application/json',
            contentEncoding: 'utf-8',
            headers: {
              [attemptHeader]: attempt,
              [transferHeader]: transferId,
              'x-finance-notification-result': reason,
            },
          },
          (error) => finish(error ? failed() : undefined),
        );
      } catch {
        finish(failed());
      }
    });
    if (this.stopped || session.abort.signal.aborted) throw failed();
    // The original stays unacked if retry/DLQ confirmation is missing or ambiguous.
    channel.ack(message);
  }
}
