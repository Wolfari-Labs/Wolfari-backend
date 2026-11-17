import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseProvider } from '@wolfari/database';
import type { AutomationV1 } from '@wolfari/contracts/grpc';
import { createHash, randomUUID } from 'node:crypto';
import { isCalendarDate } from '@wolfari/common';
import { notificationUuid } from '../notification/notification.domain';
import { notificationFail } from '../notification/notification.errors';
import { PriceWatchAccessService } from '../price-watch/price-watch-access.service';
import { DeliveryContextClient } from './delivery-context.client';

type ReminderRow = {
  id: string;
  user_id: string;
  trip_id: string;
  type: string;
  source_id: string;
  source_revision: number;
  occurrence_key: string;
  remind_at: Date;
  status: string;
  attempt_count: number;
  private_context: { source_at?: string; request_hash?: string };
  claim_owner: string | null;
  last_error: string | null;
  created_at: Date;
};
export const reminderView = (row: ReminderRow) => ({
  id: row.id,
  trip_id: row.trip_id,
  source_type: row.type,
  source_id: row.source_id,
  remind_at: row.remind_at.toISOString(),
  source_at: row.private_context.source_at ?? null,
  status: row.status,
  last_error: row.last_error,
  created_at: row.created_at.toISOString(),
});
export function reminderInstant(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !isCalendarDate(value.slice(0, 10)) ||
    !Number.isFinite(Date.parse(value))
  )
    return notificationFail('VALIDATION_FAILED');
  return new Date(value).toISOString();
}
export const terminalSourceError = (error: unknown) =>
  ['RESOURCE_NOT_FOUND', 'PERMISSION_DENIED'].includes(
    String((error as { code?: unknown })?.code),
  ) || [5, 7].includes(Number((error as { code?: unknown })?.code));

@Injectable()
export class ReminderService {
  private readonly logger = new Logger('ReminderWorker');
  private readonly enabled: boolean;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private readonly owner = randomUUID();
  constructor(
    private readonly db: DatabaseProvider,
    private readonly access: PriceWatchAccessService,
    private readonly context: DeliveryContextClient,
    config: ConfigService,
  ) {
    const flag = config.get<string>('REMINDER_WORKER_ENABLED') ?? 'false';
    if (!['true', 'false'].includes(flag)) throw Error('Invalid reminder worker flag');
    this.enabled = flag === 'true';
  }
  async list(raw: AutomationV1.ListRemindersRequest, correlation: string) {
    const actor = notificationUuid(raw.actor_user_id),
      trip = notificationUuid(raw.trip_id);
    await this.access.get(trip, actor, correlation);
    const rows = (
      await this.db.query<ReminderRow>(
        'SELECT * FROM reminders WHERE user_id=$1 AND trip_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100',
        [actor, trip],
      )
    ).rows;
    return rows.map(reminderView);
  }
  async create(raw: AutomationV1.CreateReminderRequest, correlation: string) {
    const actor = notificationUuid(raw.actor_user_id),
      trip = notificationUuid(raw.trip_id),
      key = notificationUuid(raw.operation_id),
      source = notificationUuid(raw.source_id);
    if (!['ACTIVITY', 'PACKING'].includes(raw.source_type ?? ''))
      return notificationFail('VALIDATION_FAILED');
    const when = reminderInstant(raw.remind_at),
      type = raw.source_type!;
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ trip, source, type, when }))
      .digest('hex');
    const access = await this.access.get(trip, actor, correlation);
    if (access.state !== 'ACTIVE') return notificationFail('STATE_CONFLICT');
    return this.db.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,9224))', [actor]);
      const old = (
        await client.query<ReminderRow>(
          "SELECT * FROM reminders WHERE user_id=$1 AND occurrence_key=$2 AND private_context ? 'request_hash'",
          [actor, key],
        )
      ).rows[0];
      if (old) {
        if (old.private_context.request_hash !== requestHash)
          return notificationFail('STATE_CONFLICT');
        return reminderView(old);
      }
      const context = await this.context.source(
        { trip_id: trip, user_id: actor, source_type: type, source_id: source },
        correlation,
      );
      if (
        !context.allowed ||
        !context.at ||
        Date.parse(when) <= Date.now() ||
        Date.parse(when) > Date.parse(context.at) ||
        Date.parse(when) > Date.now() + 366 * 86400000
      )
        return notificationFail('VALIDATION_FAILED');
      const count =
        (
          await client.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM reminders WHERE user_id=$1 AND trip_id=$2 AND status IN ('PENDING','PROCESSING')",
            [actor, trip],
          )
        ).rows[0]?.n ?? 0;
      if (count >= 50) return notificationFail('STATE_CONFLICT');
      const row = (
        await client.query<ReminderRow>(
          `INSERT INTO reminders(user_id,trip_id,type,source_id,source_revision,occurrence_key,remind_at,private_context)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
          [
            actor,
            trip,
            type,
            source,
            context.revision,
            key,
            when,
            JSON.stringify({ source_at: context.at, request_hash: requestHash }),
          ],
        )
      ).rows[0]!;
      return reminderView(row);
    });
  }
  async cancel(raw: AutomationV1.CancelReminderRequest, correlation: string) {
    const actor = notificationUuid(raw.actor_user_id),
      trip = notificationUuid(raw.trip_id),
      id = notificationUuid(raw.reminder_id);
    await this.access.get(trip, actor, correlation);
    const row = (
      await this.db.query<ReminderRow>(
        "UPDATE reminders SET status='CANCELLED',cancelled_at=COALESCE(cancelled_at,clock_timestamp()),claim_owner=NULL,claim_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND trip_id=$3 AND status IN ('PENDING','PROCESSING','CANCELLED') RETURNING *",
        [id, actor, trip],
      )
    ).rows[0];
    if (!row) return notificationFail('RESOURCE_NOT_FOUND');
    return reminderView(row);
  }
  async runOnce() {
    await this.db.query(
      "UPDATE reminders SET status='FAILED',last_error='RETRY_EXHAUSTED',claim_owner=NULL,claim_until=NULL,updated_at=clock_timestamp() WHERE status='PROCESSING' AND attempt_count>=5 AND claim_until<clock_timestamp()",
    );
    const rows = await this.db.withTransaction(async (client) => {
      const claimed = (
        await client.query<ReminderRow>(`SELECT * FROM reminders WHERE
        ((status='PENDING' AND remind_at<=clock_timestamp()) OR (status='PROCESSING' AND claim_until<clock_timestamp()))
        AND attempt_count<5 ORDER BY remind_at,id LIMIT 4 FOR UPDATE SKIP LOCKED`)
      ).rows;
      for (const row of claimed)
        await client.query(
          "UPDATE reminders SET status='PROCESSING',claim_owner=$2,claim_until=clock_timestamp()+interval '120 seconds',attempt_count=attempt_count+1 WHERE id=$1",
          [row.id, this.owner],
        );
      return claimed;
    });
    for (const row of rows) {
      try {
        const correlation = randomUUID();
        const source = await this.context.source(
          {
            trip_id: row.trip_id,
            user_id: row.user_id,
            source_type: row.type,
            source_id: row.source_id,
          },
          correlation,
        );
        const valid =
          source.allowed &&
          source.at === row.private_context.source_at &&
          Boolean(source.at) &&
          Date.parse(source.at!) >= Date.now() &&
          (await this.context.eligible(row.user_id, row.trip_id, correlation));
        if (!valid) {
          await this.finishCancelled(row.id, 'SOURCE_CHANGED_OR_UNAVAILABLE');
          continue;
        }
        await this.db.withTransaction(async (client) => {
          const current = (
            await client.query<ReminderRow>('SELECT * FROM reminders WHERE id=$1 FOR UPDATE', [
              row.id,
            ])
          ).rows[0];
          if (!current || current.status !== 'PROCESSING' || current.claim_owner !== this.owner)
            return;
          await client.query(
            `INSERT INTO notifications(user_id,trip_id,type,title,body,source_id,status,dedupe_key)
            VALUES($1,$2,$3,$4,$5,$6,'AVAILABLE',$7) ON CONFLICT(dedupe_key) DO NOTHING`,
            [
              row.user_id,
              row.trip_id,
              `${row.type}_REMINDER`,
              row.type === 'PACKING' ? 'Nhắc chuẩn bị hành lý' : 'Nhắc lịch hoạt động',
              'Đến giờ nhắc bạn đã đặt. Mở chuyến đi để xem và chuẩn bị.',
              row.id,
              `reminder:${row.id}`,
            ],
          );
          await client.query(
            "UPDATE reminders SET status='SENT',claim_owner=NULL,claim_until=NULL,last_error=NULL,updated_at=clock_timestamp() WHERE id=$1",
            [row.id],
          );
        });
      } catch (error) {
        if (terminalSourceError(error)) {
          await this.finishCancelled(row.id, 'ACCESS_REVOKED');
          continue;
        }
        await this.db.query(
          "UPDATE reminders SET status=CASE WHEN attempt_count>=5 THEN 'FAILED' ELSE 'PROCESSING' END,claim_until=clock_timestamp()+interval '30 seconds',last_error='CONTEXT_UNAVAILABLE',updated_at=clock_timestamp() WHERE id=$1 AND claim_owner=$2 AND status='PROCESSING'",
          [row.id, this.owner],
        );
      }
    }
  }
  private async finishCancelled(id: string, reason: string) {
    await this.db.query(
      "UPDATE reminders SET status='CANCELLED',cancelled_at=clock_timestamp(),claim_owner=NULL,claim_until=NULL,last_error=$3,updated_at=clock_timestamp() WHERE id=$1 AND claim_owner=$2 AND status='PROCESSING'",
      [id, this.owner, reason],
    );
  }
  onModuleInit() {
    if (this.enabled) {
      this.timer = setInterval(() => {
        if (!this.running)
          this.running = this.runOnce()
            .catch(() => this.logger.warn('REMINDER_POLL_UNAVAILABLE'))
            .finally(() => {
              this.running = undefined;
            });
      }, 5000);
      this.timer.unref();
    }
  }
  async onApplicationShutdown() {
    clearInterval(this.timer);
    await this.running;
  }
}
