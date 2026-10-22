import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EVENT_TOPOLOGY, parseEventForConsume } from '@wolfari/contracts/events';
import { connect, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { PriceWatchLifecycleRepository } from './price-watch-lifecycle.repository';

const queue = 'wolfari.automation.price-watch.v1';
const dlx = `${queue}.dlx`;
const retryDelays = EVENT_TOPOLOGY.retry_delays_ms;
const supported = new Set([
  'MemberLeft',
  'MemberRemoved',
  'TripArchived',
  'TripDeleted',
  'TripReopened',
]);

@Injectable()
export class PriceWatchLifecycleConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PriceWatchLifecycleConsumer.name);
  private readonly brokerUrl: string;
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private connecting?: Promise<void>;
  private readonly consuming = new Set<Promise<void>>();
  private readonly returned = new Set<string>();

  constructor(
    config: ConfigService,
    private readonly repository: PriceWatchLifecycleRepository,
  ) {
    this.brokerUrl = config.getOrThrow<string>('RABBITMQ_URL');
  }

  onApplicationBootstrap(): void {
    const kick = () => {
      if (this.stopped || this.channel || this.connecting) return;
      this.connecting = this.connect()
        .catch(() => this.logger.warn('PRICE_WATCH_LIFECYCLE_BROKER_UNAVAILABLE'))
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
    await this.connecting;
    await this.channel?.cancel('price-watch-lifecycle-consumer').catch(() => {});
    await Promise.allSettled([...this.consuming]);
    await this.channel?.close().catch(() => {});
    await this.connection?.close().catch(() => {});
  }

  private async connect(): Promise<void> {
    await this.connection?.close().catch(() => {});
    const connection = await connect(this.brokerUrl);
    this.connection = connection;
    const reset = () => {
      if (this.connection === connection) this.channel = undefined;
    };
    connection.on('error', reset);
    connection.on('close', reset);
    try {
      const channel = await connection.createConfirmChannel();
      channel.on('error', reset);
      channel.on('close', reset);
      channel.on('return', (message) => this.returned.add(String(message.properties.messageId)));
      await channel.assertExchange(EVENT_TOPOLOGY.exchange.name, 'topic', { durable: true });
      await channel.assertExchange(dlx, 'fanout', { durable: true });
      await channel.assertQueue(`${queue}.dlq`, { durable: true });
      await channel.bindQueue(`${queue}.dlq`, dlx, '');
      await channel.assertQueue(queue, { durable: true, deadLetterExchange: dlx });
      for (const type of supported)
        await channel.bindQueue(queue, EVENT_TOPOLOGY.exchange.name, type);
      for (const [index, delay] of retryDelays.entries())
        await channel.assertQueue(`${queue}.retry.${index}`, {
          durable: true,
          messageTtl: delay,
          deadLetterExchange: '',
          deadLetterRoutingKey: queue,
        });
      await channel.prefetch(5);
      await channel.consume(
        queue,
        (message) => {
          if (!message) return;
          const pending = this.consume(channel, message)
            .catch(() => this.logger.warn('PRICE_WATCH_LIFECYCLE_CONSUMER_UNAVAILABLE'))
            .finally(() => this.consuming.delete(pending));
          this.consuming.add(pending);
        },
        { noAck: false, consumerTag: 'price-watch-lifecycle-consumer' },
      );
      this.channel = channel;
    } catch (error) {
      await connection.close().catch(() => {});
      if (this.connection === connection) this.connection = undefined;
      throw error;
    }
  }

  private async consume(channel: ConfirmChannel, message: ConsumeMessage): Promise<void> {
    let event;
    try {
      event = parseEventForConsume(JSON.parse(message.content.toString('utf8')));
      if (event.producer !== 'Trip' || !supported.has(event.event_type))
        throw new Error('UNSUPPORTED_PRICE_WATCH_LIFECYCLE_EVENT');
    } catch {
      try {
        channel.nack(message, false, false);
      } catch {
        /* channel recovery */
      }
      return;
    }
    try {
      await this.repository.apply(event);
      channel.ack(message);
    } catch {
      const attempt = Number(message.properties.headers?.['x-price-watch-lifecycle-attempt'] ?? 0);
      if (!Number.isInteger(attempt) || attempt >= retryDelays.length) {
        try {
          channel.nack(message, false, false);
        } catch {
          /* channel recovery */
        }
        return;
      }
      const messageId = randomUUID();
      try {
        await new Promise<void>((resolve, reject) =>
          channel.sendToQueue(
            `${queue}.retry.${attempt}`,
            message.content,
            {
              persistent: true,
              mandatory: true,
              messageId,
              contentType: 'application/json',
              headers: { 'x-price-watch-lifecycle-attempt': attempt + 1 },
            },
            (error) => (error ? reject(error) : resolve()),
          ),
        );
        if (this.returned.delete(messageId)) throw new Error('UNROUTABLE_RETRY');
        channel.ack(message);
      } catch {
        this.returned.delete(messageId);
        await channel.close().catch(() => {});
        this.channel = undefined;
      }
    }
  }
}
