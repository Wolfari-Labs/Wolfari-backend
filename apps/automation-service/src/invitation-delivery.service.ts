import {
  Controller,
  Get,
  Header,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseProvider } from '@wolfari/database';
import { EVENT_TOPOLOGY, parseEventForConsume } from '@wolfari/contracts/events';
import { TripAccessClient, TripInvitationClient } from '@wolfari/contracts/trip-client';
import { connect, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { createTransport, type Transporter } from 'nodemailer';
import { randomUUID } from 'node:crypto';

const queue = 'wolfari.automation.invitations.v1';
const dlx = `${queue}.dlx`;
const delays = EVENT_TOPOLOGY.retry_delays_ms;
type Context = {
  invitation_id: string;
  invitation_version: number;
  correlation_id: string;
  ack_pending?: boolean;
};
type Delivery = {
  id: string;
  delivery_key: string;
  status: string;
  attempt_count: number;
  private_context: Context;
};

@Injectable()
export class InvitationDeliveryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(InvitationDeliveryService.name);
  private readonly owner = randomUUID();
  private readonly trip: TripInvitationClient;
  private readonly access: TripAccessClient;
  private readonly smtp: Transporter;
  private readonly brokerUrl: string;
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  private readonly consuming = new Set<Promise<void>>();
  private readonly returned = new Set<string>();

  constructor(
    private readonly db: DatabaseProvider,
    config: ConfigService,
  ) {
    if (process.env.NODE_ENV === 'production')
      throw new Error('Invitation transport requires TLS in production');
    const target = config.getOrThrow<string>('TRIP_GRPC_TARGET'),
      secret = config.getOrThrow<string>('AUTOMATION_TRIP_SECRET');
    if (!/^127\.0\.0\.1:\d+$/.test(target) || secret.length < 32)
      throw new Error('Invalid Automation Trip configuration');
    this.trip = new TripInvitationClient(target, secret);
    this.access = new TripAccessClient(target, 'Automation', secret);
    this.smtp = createTransport({
      host: config.getOrThrow<string>('SMTP_HOST'),
      port: Number(config.getOrThrow<string>('SMTP_PORT')),
      secure: false,
      connectionTimeout: 2000,
      socketTimeout: 5000,
    });
    this.brokerUrl = config.getOrThrow<string>('RABBITMQ_URL');
  }
  onApplicationBootstrap() {
    const tick = () => {
      if (!this.stopped && !this.running)
        this.running = this.tick()
          .catch(() => this.logger.warn('INVITATION_DEPENDENCY_UNAVAILABLE'))
          .finally(() => {
            this.running = undefined;
          });
    };
    this.timer = setInterval(tick, 3000);
    tick();
  }
  async onApplicationShutdown() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
    await this.channel?.cancel('invitation-consumer').catch(() => {});
    await Promise.allSettled([...this.consuming]);
    await this.channel?.close().catch(() => {});
    await this.connection?.close().catch(() => {});
    this.trip.close();
    this.access.close();
    this.smtp.close();
  }
  private async broker() {
    if (this.channel) return;
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
      for (const type of ['MemberInvited', 'MemberJoined'])
        await channel.bindQueue(queue, EVENT_TOPOLOGY.exchange.name, type);
      for (const [index, delay] of delays.entries())
        await channel.assertQueue(`${queue}.retry.${index}`, {
          durable: true,
          messageTtl: delay,
          deadLetterExchange: '',
          deadLetterRoutingKey: queue,
        });
      await channel.prefetch(5);
      this.channel = channel;
      await channel.consume(
        queue,
        (message) => {
          if (!message) return;
          const pending = this.consume(channel, message)
            .catch(() => this.logger.warn('INVITATION_CONSUMER_UNAVAILABLE'))
            .finally(() => this.consuming.delete(pending));
          this.consuming.add(pending);
        },
        { noAck: false, consumerTag: 'invitation-consumer' },
      );
    } catch (error) {
      await connection.close().catch(() => {});
      this.channel = undefined;
      throw error;
    }
  }
  private async preference(
    client: Pick<DatabaseProvider, 'query'>,
    userId: string | undefined,
    tripId: string,
  ): Promise<boolean> {
    if (!userId) return true;
    const row = (
      await client.query<{
        email_enabled: boolean;
        group_overrides: Record<string, { email_enabled?: boolean }>;
      }>('SELECT email_enabled,group_overrides FROM notification_preferences WHERE user_id=$1', [
        userId,
      ])
    ).rows[0];
    return row?.group_overrides?.[tripId]?.email_enabled ?? row?.email_enabled ?? true;
  }
  private async consume(channel: ConfirmChannel, message: ConsumeMessage) {
    let event;
    try {
      event = parseEventForConsume(JSON.parse(message.content.toString('utf8')));
      if (
        event.producer !== 'Trip' ||
        !['MemberInvited', 'MemberJoined'].includes(event.event_type)
      )
        throw new Error('UNSUPPORTED_EVENT');
    } catch {
      try {
        channel.nack(message, false, false);
      } catch {
        /* channel recovery */
      }
      return;
    }
    try {
      // Nothing from delivery context, especially the link, is written to Automation storage.
      let recipientEmail: string | undefined, recipientUserId: string | undefined;
      if (event.event_type === 'MemberInvited') {
        const source = await this.trip.getInvitationDelivery(
          {
            invitation_id: event.payload.invitation_id,
            expected_invitation_version: event.payload.invitation_version,
          },
          event.correlation_id,
        );
        if (source.valid && source.delivery) {
          recipientEmail = source.delivery.recipient_email;
          recipientUserId = source.delivery.recipient_user_id;
        }
      } else if (event.event_type === 'MemberJoined') {
        try {
          const source = await this.access.getAccessContext(
            { trip_id: event.payload.trip_id, user_id: event.payload.user_id, action: 'TRIP_VIEW' },
            event.correlation_id,
          );
          if (source.context?.allowed && source.context.membership?.id === event.aggregate_id)
            recipientUserId = event.payload.user_id;
        } catch (error) {
          if ((error as { code?: number }).code !== 5) throw error;
        }
      }
      await this.db.withTransaction(async (client) => {
        const inserted = await client.query(
          `INSERT INTO inbox_events(consumer_name,event_id,event_type,aggregate_id,aggregate_version)
          VALUES('AutomationInvitations',$1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_id`,
          [event.event_id, event.event_type, event.aggregate_id, event.aggregate_version],
        );
        if (!inserted.rowCount || (!recipientEmail && !recipientUserId)) return;
        const key =
          event.event_type === 'MemberInvited'
            ? `invitation:${event.aggregate_id}:${event.aggregate_version}`
            : `member-joined:${event.aggregate_id}`;
        const notification = (
          await client.query<{ id: string }>(
            `INSERT INTO notifications(user_id,recipient_email,trip_id,type,title,body,source_id,event_id,status,dedupe_key)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'AVAILABLE',$9) ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING id`,
            [
              recipientUserId ?? null,
              recipientEmail ?? null,
              event.trip_id,
              event.event_type === 'MemberInvited' ? 'TRIP_INVITATION' : 'MEMBER_JOINED',
              event.event_type === 'MemberInvited' ? 'Lời mời chuyến đi' : 'Đã tham gia chuyến đi',
              'Mở ứng dụng Wolfari để xem thông tin.',
              event.aggregate_id,
              event.event_id,
              key,
            ],
          )
        ).rows[0]!;
        if (
          event.event_type === 'MemberInvited' &&
          (await this.preference(client, recipientUserId, event.payload.trip_id))
        ) {
          const context: Context = {
            invitation_id: event.payload.invitation_id,
            invitation_version: event.payload.invitation_version,
            correlation_id: event.correlation_id,
          };
          await client.query(
            `INSERT INTO notification_deliveries(notification_id,channel,delivery_key,private_context) VALUES($1,'EMAIL',$2,$3::jsonb) ON CONFLICT(delivery_key) DO NOTHING`,
            [notification.id, key, JSON.stringify(context)],
          );
        }
      });
      channel.ack(message);
    } catch {
      const attempt = Number(message.properties.headers?.['x-invitation-attempt'] ?? 0);
      if (!Number.isInteger(attempt) || attempt >= delays.length) {
        try {
          channel.nack(message, false, false);
        } catch {
          /* reconnect */
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
              headers: { 'x-invitation-attempt': attempt + 1 },
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
  private async tick() {
    // SMTP and ack retries continue even when RabbitMQ is temporarily down.
    await this.broker().catch(() => this.logger.warn('INVITATION_BROKER_UNAVAILABLE'));
    const rows = (
      await this.db.query<Delivery>(
        `UPDATE notification_deliveries SET claim_owner=$1,claim_until=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp(),
      status=CASE WHEN status='SENT' THEN 'SENT' ELSE 'SENDING' END
      WHERE id IN (SELECT d.id FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id
        WHERE n.type='TRIP_INVITATION' AND d.channel='EMAIL' AND d.next_attempt_at<=clock_timestamp()
        AND (d.claim_until IS NULL OR d.claim_until<clock_timestamp())
        AND (d.status IN ('PENDING','SENDING') OR (d.status='SENT' AND d.private_context->>'ack_pending'='true'))
        ORDER BY d.created_at FOR UPDATE OF d SKIP LOCKED LIMIT 1) RETURNING *`,
        [this.owner],
      )
    ).rows;
    for (const row of rows) await this.deliver(row);
  }
  private async ack(delivery: Delivery) {
    const context = delivery.private_context;
    await this.trip.acknowledgeInvitationDelivery(
      { invitation_id: context.invitation_id, invitation_version: context.invitation_version },
      context.correlation_id,
    );
    // false means superseded version: safe to stop retrying this old acknowledgement.
    await this.db.query(
      "UPDATE notification_deliveries SET private_context=private_context-'ack_pending',claim_owner=NULL,claim_until=NULL,last_error=NULL WHERE id=$1 AND claim_owner=$2 AND status='SENT'",
      [delivery.id, this.owner],
    );
  }
  private async deliver(delivery: Delivery) {
    let sent = delivery.status === 'SENT';
    try {
      if (!sent) {
        const context = delivery.private_context;
        const source = await this.trip.getInvitationDelivery(
          {
            invitation_id: context.invitation_id,
            expected_invitation_version: context.invitation_version,
          },
          context.correlation_id,
        );
        const notification = (
          await this.db.query<{ trip_id: string }>(
            'SELECT n.trip_id FROM notifications n JOIN notification_deliveries d ON d.notification_id=n.id WHERE d.id=$1',
            [delivery.id],
          )
        ).rows[0]!;
        if (
          !source.valid ||
          !source.delivery ||
          !(await this.preference(this.db, source.delivery.recipient_user_id, notification.trip_id))
        ) {
          await this.db.query(
            "UPDATE notification_deliveries SET status='FAILED',last_error='SOURCE_INVALID_OR_SUPPRESSED',claim_owner=NULL,claim_until=NULL WHERE id=$1 AND claim_owner=$2",
            [delivery.id, this.owner],
          );
          return;
        }
        const info = await this.smtp.sendMail({
          from: 'Wolfari <no-reply@wolfari.local>',
          to: source.delivery.recipient_email,
          subject: 'Lời mời chuyến đi Wolfari',
          text: `Bạn được mời tham gia chuyến đi. Đăng nhập và xem trước lời mời: ${source.delivery.link}\nMở liên kết không tự động chấp nhận lời mời.`,
          messageId: `<${delivery.delivery_key.replaceAll(':', '.')}@wolfari.local>`,
        });
        const updated = await this.db.query(
          `UPDATE notification_deliveries SET status='SENT',sent_at=clock_timestamp(),provider_reference=$3,last_error=NULL,
          private_context=private_context||'{"ack_pending":true}'::jsonb WHERE id=$1 AND claim_owner=$2 RETURNING id`,
          [delivery.id, this.owner, String(info.messageId).slice(0, 180)],
        );
        if (!updated.rowCount) return;
        sent = true;
      }
      await this.ack(delivery);
    } catch {
      const attempt = delivery.attempt_count + 1;
      await this.db
        .query(
          `UPDATE notification_deliveries SET status=$3,attempt_count=$4,next_attempt_at=clock_timestamp()+($5::int*interval '1 millisecond'),
        last_error=$6,claim_owner=NULL,claim_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND claim_owner=$2`,
          [
            delivery.id,
            this.owner,
            sent ? 'SENT' : attempt > delays.length ? 'FAILED' : 'PENDING',
            attempt,
            delays[Math.min(attempt - 1, delays.length - 1)] ?? 900000,
            sent ? 'ACK_FAILED' : 'DELIVERY_FAILED',
          ],
        )
        .catch(() => {});
    }
  }
  async diagnostics() {
    const rows = (
      await this.db.query<{ status: string; count: string }>(
        "SELECT d.status,count(*)::text AS count FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.type='TRIP_INVITATION' GROUP BY d.status",
      )
    ).rows;
    const pending = (
      await this.db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.type='TRIP_INVITATION' AND d.status='SENT' AND d.private_context->>'ack_pending'='true'",
      )
    ).rows[0]!;
    return {
      broker: this.channel ? 'up' : 'down',
      deliveries: Object.fromEntries(
        rows.map((row) => [row.status.toLowerCase(), Number(row.count)]),
      ),
      ack_pending: Number(pending.count),
    };
  }
}

@Controller('health')
export class InvitationDependenciesController {
  constructor(private readonly delivery: InvitationDeliveryService) {}
  @Get('invitations')
  @Header('Cache-Control', 'no-store')
  diagnostics() {
    return this.delivery.diagnostics();
  }
}
