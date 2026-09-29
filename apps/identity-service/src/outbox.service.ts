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
import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { DatabaseProvider } from '@wolfari/database';
import { EVENT_TOPOLOGY, parseEventForPublish } from '@wolfari/contracts/events';
import { IdentityService } from './identity.service';
import { AvatarService } from './avatar.service';

type OutboxRow = {
  event_id: string;
  event_type: string;
  schema_version: number;
  occurred_at: Date;
  producer: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  correlation_id: string;
  causation_id: string | null;
  operation_id: string | null;
  trip_id: string | null;
  actor_user_id: string | null;
  system_actor: string | null;
  payload: Record<string, unknown>;
  attempt_count: number;
};

const delays = EVENT_TOPOLOGY.retry_delays_ms;

@Injectable()
export class OutboxService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxService.name);
  private readonly owner = randomUUID();
  private timer?: NodeJS.Timeout;
  private maintenanceTimer?: NodeJS.Timeout;
  private running = false;
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private readonly returned = new Set<string>();

  constructor(
    private readonly db: DatabaseProvider,
    private readonly config: ConfigService,
    private readonly identity: IdentityService,
    private readonly avatars: AvatarService,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.tick(), 1000);
    this.maintenanceTimer = setInterval(() => void this.maintain(), 3600_000);
    void this.tick();
    void this.maintain();
  }

  async onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    await this.channel?.close().catch(() => {});
    await this.connection?.close().catch(() => {});
  }

  private async maintain() {
    try {
      await this.identity.cleanupExpiredTokens();
      await this.avatars.cleanupOrphans();
    } catch {
      this.logger.warn('IDENTITY_MAINTENANCE_UNAVAILABLE');
    }
  }

  private async broker(): Promise<ConfirmChannel> {
    if (this.channel) return this.channel;
    const url = this.config.getOrThrow<string>('RABBITMQ_URL');
    let connection: ChannelModel | undefined;
    let channel: ConfirmChannel | undefined;
    try {
      connection = await connect(url);
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
      channel = await connection.createConfirmChannel();
      const activeChannel = channel;
      channel.on('return', (message) => this.returned.add(String(message.properties.messageId)));
      channel.on('error', () => {
        if (this.channel === activeChannel) this.channel = undefined;
      });
      channel.on('close', () => {
        if (this.channel === activeChannel) this.channel = undefined;
      });
      await channel.assertExchange(EVENT_TOPOLOGY.exchange.name, 'topic', { durable: true });
      this.connection = connection;
      this.channel = channel;
      return channel;
    } catch (error) {
      await channel?.close().catch(() => {});
      await connection?.close().catch(() => {});
      throw error;
    }
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const channel = await this.broker();
      const rows = await this.db.query<OutboxRow>(
        `UPDATE outbox_events SET claim_owner=$1,claim_until=now()+interval '30 seconds'
        WHERE event_id IN (SELECT event_id FROM outbox_events WHERE status='PENDING' AND next_attempt_at<=now()
          AND (claim_until IS NULL OR claim_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 10)
        RETURNING *`,
        [this.owner],
      );
      for (const row of rows.rows) await this.publish(channel, row);
    } catch {
      this.logger.warn('OUTBOX_BROKER_OR_DATABASE_UNAVAILABLE');
    } finally {
      this.running = false;
    }
  }

  private async publish(channel: ConfirmChannel, row: OutboxRow) {
    try {
      const event = parseEventForPublish({
        event_id: row.event_id,
        event_type: row.event_type,
        schema_version: row.schema_version,
        occurred_at: row.occurred_at.toISOString(),
        producer: row.producer,
        aggregate_type: row.aggregate_type,
        aggregate_id: row.aggregate_id,
        aggregate_version: row.aggregate_version,
        correlation_id: row.correlation_id,
        causation_id: row.causation_id,
        operation_id: row.operation_id,
        trip_id: row.trip_id,
        actor_user_id: row.actor_user_id,
        system_actor: row.system_actor,
        payload: row.payload,
      });
      await new Promise<void>((resolve, reject) =>
        channel.publish(
          EVENT_TOPOLOGY.exchange.name,
          row.event_type,
          Buffer.from(JSON.stringify(event)),
          {
            persistent: true,
            mandatory: true,
            messageId: row.event_id,
            contentType: 'application/json',
            contentEncoding: 'utf-8',
          },
          (error) => (error ? reject(error) : resolve()),
        ),
      );
      if (this.returned.delete(row.event_id)) throw new Error('UNROUTABLE');
      await this.db.query(
        "UPDATE outbox_events SET status='PUBLISHED',published_at=now(),claim_owner=NULL,claim_until=NULL,last_error=NULL WHERE event_id=$1 AND claim_owner=$2",
        [row.event_id, this.owner],
      );
    } catch {
      this.returned.delete(row.event_id);
      const attempt = row.attempt_count + 1;
      const delay = delays[Math.min(attempt - 1, delays.length - 1)] ?? 900000;
      await this.db.query(
        `UPDATE outbox_events SET status=$3,attempt_count=$4,next_attempt_at=now()+($5::int * interval '1 millisecond'),
        claim_owner=NULL,claim_until=NULL,last_error='PUBLISH_FAILED' WHERE event_id=$1 AND claim_owner=$2`,
        [row.event_id, this.owner, attempt > delays.length ? 'FAILED' : 'PENDING', attempt, delay],
      );
    }
  }

  async diagnostics() {
    const rows = await this.db.query<{ status: string; count: string }>(
      "SELECT status,count(*)::text AS count FROM outbox_events WHERE status<>'PUBLISHED' GROUP BY status",
    );
    return {
      broker: this.channel ? 'up' : 'down',
      outbox: Object.fromEntries(
        rows.rows.map((row) => [row.status.toLowerCase(), Number(row.count)]),
      ),
    };
  }
}

@Controller('health')
export class IdentityDependenciesController {
  constructor(private readonly outbox: OutboxService) {}
  @Get('dependencies')
  @Header('Cache-Control', 'no-store')
  dependencies() {
    return this.outbox.diagnostics();
  }
}
