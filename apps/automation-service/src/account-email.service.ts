import {
  Controller,
  Get,
  Header,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, type ChannelModel, type Channel, type ConsumeMessage } from 'amqplib';
import { createTransport, type Transporter } from 'nodemailer';
import { randomUUID } from 'node:crypto';
import { DatabaseProvider } from '@wolfari/database';
import { EVENT_TOPOLOGY, parseEventForConsume } from '@wolfari/contracts/events';
import { IdentityClient } from '@wolfari/contracts/identity-client';
import type { PoolClient } from 'pg';

type Delivery = { id: string; attempt_count: number; private_context: { token_id?: string } };
const queue = 'wolfari.automation.account-email.v1';
const deadLetterExchange = `${EVENT_TOPOLOGY.exchange.name}.dlx`;
const retryDelays = EVENT_TOPOLOGY.retry_delays_ms;

@Injectable()
export class AccountEmailService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AccountEmailService.name);
  private readonly owner = randomUUID();
  private readonly identity: IdentityClient;
  private readonly smtp: Transporter;
  private brokerTimer?: NodeJS.Timeout;
  private senderTimer?: NodeJS.Timeout;
  private connection?: ChannelModel;
  private channel?: Channel;
  private connecting = false;
  private sending = false;

  constructor(
    private readonly db: DatabaseProvider,
    config: ConfigService,
  ) {
    if (process.env.NODE_ENV === 'production')
      throw new Error('Automation gRPC/AMQP/SMTP transport requires TLS in production');
    this.identity = new IdentityClient(
      config.getOrThrow<string>('IDENTITY_GRPC_TARGET'),
      'Automation',
      config.getOrThrow<string>('AUTOMATION_IDENTITY_SECRET'),
    );
    this.smtp = createTransport({
      host: config.getOrThrow<string>('SMTP_HOST'),
      port: Number(config.getOrThrow<string>('SMTP_PORT')),
      secure: false,
      connectionTimeout: 2000,
      socketTimeout: 5000,
    });
    this.brokerUrl = config.getOrThrow<string>('RABBITMQ_URL');
  }

  private readonly brokerUrl: string;

  onApplicationBootstrap() {
    this.brokerTimer = setInterval(() => void this.connectBroker(), 3000);
    this.senderTimer = setInterval(() => void this.sendPending(), 1000);
    void this.connectBroker();
    void this.sendPending();
  }

  async onApplicationShutdown() {
    if (this.brokerTimer) clearInterval(this.brokerTimer);
    if (this.senderTimer) clearInterval(this.senderTimer);
    this.identity.close();
    this.smtp.close();
    await this.channel?.close().catch(() => {});
    await this.connection?.close().catch(() => {});
  }

  private async connectBroker() {
    if (this.channel || this.connecting) return;
    this.connecting = true;
    let connection: ChannelModel | undefined;
    let channel: Channel | undefined;
    try {
      connection = await connect(this.brokerUrl);
      connection.on('error', () => {
        if (this.connection === connection) {
          this.channel = undefined;
          this.connection = undefined;
        }
      });
      connection.on('close', () => {
        if (this.connection === connection) {
          this.channel = undefined;
          this.connection = undefined;
        }
      });
      channel = await connection.createChannel();
      const activeChannel = channel;
      channel.on('error', () => {
        if (this.channel === activeChannel) this.channel = undefined;
      });
      channel.on('close', () => {
        if (this.channel === activeChannel) this.channel = undefined;
      });
      await channel.assertExchange(EVENT_TOPOLOGY.exchange.name, 'topic', { durable: true });
      await channel.assertExchange(deadLetterExchange, 'fanout', { durable: true });
      await channel.assertQueue(`${queue}.dlq`, { durable: true });
      await channel.bindQueue(`${queue}.dlq`, deadLetterExchange, '');
      await channel.assertQueue(queue, { durable: true, deadLetterExchange });
      await channel.bindQueue(queue, EVENT_TOPOLOGY.exchange.name, 'AccountEmailRequested');
      await channel.prefetch(5);
      await channel.consume(
        queue,
        (message) => {
          if (message) void this.consume(activeChannel, message);
        },
        { noAck: false },
      );
      this.connection = connection;
      this.channel = channel;
    } catch {
      await channel?.close().catch(() => {});
      await connection?.close().catch(() => {});
      this.logger.warn('ACCOUNT_EMAIL_BROKER_UNAVAILABLE');
    } finally {
      this.connecting = false;
    }
  }

  private async consume(channel: Channel, message: ConsumeMessage) {
    let event;
    try {
      event = parseEventForConsume(JSON.parse(message.content.toString('utf8')));
      if (event.event_type !== 'AccountEmailRequested' || event.producer !== 'Identity')
        throw new Error('UNSUPPORTED_EVENT');
    } catch {
      this.acknowledge(channel, message, false, false);
      return;
    }
    try {
      await this.db.withTransaction(async (client: PoolClient) => {
        const inbox = await client.query(
          `INSERT INTO inbox_events(consumer_name,event_id,event_type,aggregate_id,aggregate_version)
          VALUES('AutomationAccountEmail',$1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_id`,
          [event.event_id, event.event_type, event.aggregate_id, event.aggregate_version],
        );
        if (!inbox.rowCount) return;
        const tokenId = event.payload.token_id;
        const notification = await client.query<{ id: string }>(
          `INSERT INTO notifications(user_id,type,title,body,event_id,status,dedupe_key)
          VALUES($1,'ACCOUNT_EMAIL','Account email','Email delivery is pending',$2,'CREATED',$3)
          ON CONFLICT (dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING id`,
          [event.payload.user_id, event.event_id, `account-email:${tokenId}`],
        );
        await client.query(
          `INSERT INTO notification_deliveries(notification_id,channel,delivery_key,private_context)
          VALUES($1,'EMAIL',$2,$3) ON CONFLICT (delivery_key) DO NOTHING`,
          [
            notification.rows[0]!.id,
            `account-email:${tokenId}`,
            JSON.stringify({ token_id: tokenId }),
          ],
        );
      });
      this.acknowledge(channel, message);
    } catch {
      this.logger.warn('ACCOUNT_EMAIL_INBOX_UNAVAILABLE');
      this.acknowledge(channel, message, false, true);
    }
  }

  private acknowledge(channel: Channel, message: ConsumeMessage, ack = true, requeue = false) {
    try {
      if (ack) channel.ack(message);
      else channel.nack(message, false, requeue);
    } catch {
      // If the channel closed, RabbitMQ requeues unacknowledged deliveries when it recovers.
      this.logger.warn('ACCOUNT_EMAIL_ACK_UNAVAILABLE');
    }
  }

  private async sendPending() {
    if (this.sending) return;
    this.sending = true;
    try {
      const deliveries = await this.db.query<Delivery>(
        `UPDATE notification_deliveries SET status='SENDING',claim_owner=$1,
        claim_until=now()+interval '30 seconds',updated_at=now()
        WHERE id IN (SELECT id FROM notification_deliveries WHERE channel='EMAIL' AND next_attempt_at<=now()
          AND (status='PENDING' OR (status='SENDING' AND claim_until<now()))
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 5) RETURNING id,attempt_count,private_context`,
        [this.owner],
      );
      for (const delivery of deliveries.rows) await this.deliver(delivery);
    } catch {
      this.logger.warn('ACCOUNT_EMAIL_DATABASE_UNAVAILABLE');
    } finally {
      this.sending = false;
    }
  }

  private async deliver(delivery: Delivery) {
    try {
      if (!delivery.private_context.token_id) throw new Error('TOKEN_REFERENCE_MISSING');
      const response = await this.identity.getAccountEmailDelivery({
        token_id: delivery.private_context.token_id,
      });
      if (!response.valid || !response.delivery) {
        await this.db.query(
          "UPDATE notification_deliveries SET status='FAILED',last_error='TOKEN_INVALID',private_context='{}'::jsonb,claim_owner=NULL,claim_until=NULL,updated_at=now() WHERE id=$1 AND claim_owner=$2",
          [delivery.id, this.owner],
        );
        return;
      }
      const info = await this.smtp.sendMail({
        from: 'Wolfari <no-reply@wolfari.local>',
        to: response.delivery.recipient_email,
        subject:
          response.delivery.purpose === 1 ? 'Xác minh email Wolfari' : 'Đặt lại mật khẩu Wolfari',
        text: `Mở liên kết sau để tiếp tục: ${response.delivery.one_time_link}\nNếu bạn không yêu cầu, hãy bỏ qua email này.`,
      });
      await this.db.query(
        `UPDATE notification_deliveries SET status='SENT',provider_reference=$3,sent_at=now(),
        claim_owner=NULL,claim_until=NULL,last_error=NULL,private_context='{}'::jsonb,updated_at=now()
        WHERE id=$1 AND claim_owner=$2`,
        [delivery.id, this.owner, String(info.messageId).slice(0, 180)],
      );
    } catch {
      const attempt = delivery.attempt_count + 1;
      const delay = retryDelays[Math.min(attempt - 1, retryDelays.length - 1)] ?? 900000;
      await this.db
        .query(
          `UPDATE notification_deliveries SET status=$3,attempt_count=$4,
        next_attempt_at=now()+($5::int * interval '1 millisecond'),last_error='DELIVERY_FAILED',
        claim_owner=NULL,claim_until=NULL,updated_at=now() WHERE id=$1 AND claim_owner=$2`,
          [
            delivery.id,
            this.owner,
            attempt > retryDelays.length ? 'FAILED' : 'PENDING',
            attempt,
            delay,
          ],
        )
        .catch(() => {});
    }
  }

  async diagnostics() {
    const rows = await this.db.query<{ status: string; count: string }>(
      "SELECT status,count(*)::text AS count FROM notification_deliveries WHERE channel='EMAIL' AND status<>'SENT' GROUP BY status",
    );
    let smtp: 'up' | 'down' = 'down';
    try {
      if (await this.smtp.verify()) smtp = 'up';
    } catch {
      /* independent of login readiness */
    }
    return {
      broker: this.channel ? 'up' : 'down',
      smtp,
      deliveries: Object.fromEntries(
        rows.rows.map((row) => [row.status.toLowerCase(), Number(row.count)]),
      ),
    };
  }
}

@Controller('health')
export class AccountEmailDependenciesController {
  constructor(private readonly delivery: AccountEmailService) {}
  @Get('dependencies')
  @Header('Cache-Control', 'no-store')
  dependencies() {
    return this.delivery.diagnostics();
  }
}
