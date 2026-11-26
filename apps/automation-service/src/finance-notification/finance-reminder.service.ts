import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { status } from '@grpc/grpc-js';
import { DatabaseProvider } from '@wolfari/database';
import { FinanceV1 } from '@wolfari/contracts/grpc';
import { randomUUID } from 'node:crypto';
import { FinanceNotificationClient } from './finance-notification.client';
import { notificationEnabled, recipientUuid } from './finance-notification.event';
import {
  planReminder,
  REMINDER_TEXT,
  reminderDedupeKey,
  type ReminderSource,
} from './finance-reminder.domain';

export const FINANCE_REMINDER_CLOCK = 'FINANCE_REMINDER_CLOCK';
type Row = {
  source_type: ReminderSource;
  source_id: string;
  fund_id: string;
  trip_id: string;
  next_at: Date;
  sent_count: number;
  created_at: Date;
};
const RETRY_MS = 5 * 60_000;
const timestampDate = (value: FinanceV1.GetAutomationContextResponse['due_at']) =>
  value?.seconds === undefined
    ? null
    : new Date(Number(value.seconds) * 1000 + Math.floor((value.nanos ?? 0) / 1_000_000));
const missing = (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === status.NOT_FOUND;

/**
 * Runs the schedules written when a contribution request or a closure notice was processed (see
 * FinanceNotificationRepository.schedule). Each tick claims due rows with a lease, re-reads the
 * source from Finance, and either removes the row, moves it, or stores one notice per eligible
 * person per day (dedupe key) together with the next time, in one transaction.
 */
@Injectable()
export class FinanceReminderService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('FinanceReminders');
  private readonly enabled: boolean;
  private readonly pollMs: number;
  private readonly owner = randomUUID();
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly db: DatabaseProvider,
    @Inject(FinanceNotificationClient)
    private readonly client: Pick<FinanceNotificationClient, 'getSourceContext' | 'getEligibility'>,
    config: ConfigService,
    @Optional() @Inject(FINANCE_REMINDER_CLOCK) private readonly clock: () => Date = () => new Date(),
  ) {
    this.enabled = notificationEnabled(config.get('AUTOMATION_FINANCE_NOTIFICATION_ENABLED'));
    const poll = Number(config.get<string>('AUTOMATION_FINANCE_REMINDER_POLL_MS') ?? '60000');
    if (!Number.isInteger(poll) || poll < 200 || poll > 3_600_000)
      throw new Error('AUTOMATION_FINANCE_REMINDER_POLL_MS must be 200-3600000');
    this.pollMs = poll;
  }

  onApplicationBootstrap() {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => this.kick(), this.pollMs);
    this.timer.unref?.();
  }
  private kick() {
    if (this.running || this.stopped) return;
    this.running = this.runOnce()
      .catch(() => this.logger.warn('FINANCE_REMINDER_TICK_FAILED'))
      .finally(() => {
        this.running = undefined;
      });
  }
  async onApplicationShutdown() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }

  async runOnce(now = this.clock()) {
    const rows = (
      await this.db.query<Row>(
        `UPDATE finance_reminder_schedules SET claim_owner=$1,claim_until=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
        WHERE (source_type,source_id) IN (SELECT source_type,source_id FROM finance_reminder_schedules
          WHERE next_at<=$2 AND (claim_until IS NULL OR claim_until<clock_timestamp())
          ORDER BY next_at LIMIT 20 FOR UPDATE SKIP LOCKED)
        RETURNING source_type,source_id,fund_id,trip_id,next_at,sent_count,created_at`,
        [this.owner, now],
      )
    ).rows;
    for (const row of rows)
      await this.process(row, now).catch(async () => {
        this.logger.warn(`FINANCE_REMINDER_RETRY source=${row.source_type}`);
        await this.move(row, new Date(now.getTime() + RETRY_MS)).catch(() => {});
      });
  }

  private async process(row: Row, now: Date) {
    const correlation = randomUUID();
    const deadline = Date.now() + 10_000;
    let source: FinanceV1.GetAutomationContextResponse;
    try {
      source = await this.client.getSourceContext(
        { fundId: row.fund_id, sourceType: row.source_type, sourceId: row.source_id },
        correlation,
        deadline,
      );
    } catch (error) {
      if (missing(error)) return this.remove(row);
      throw error;
    }
    const recipients = (source.authorized_recipients ?? []).map((item) => recipientUuid(item?.user_id));
    // An older Finance without `eligible`: fall back to the Fund state the notices need.
    const eligible =
      source.eligible ??
      (row.source_type === 'CLOSURE'
        ? source.status === FinanceV1.FundStatus.FUND_STATUS_CLOSING
        : source.status === FinanceV1.FundStatus.FUND_STATUS_OPEN);
    const plan = planReminder(
      { sourceType: row.source_type, sentCount: row.sent_count, createdAt: new Date(row.created_at) },
      { eligible, dueAt: timestampDate(source.due_at), recipients: recipients.length },
      now,
    );
    if (plan.action === 'remove') return this.remove(row);
    if (plan.action === 'wait') return this.move(row, plan.nextAt);
    const accepted: string[] = [];
    for (let index = 0; index < recipients.length; index += 100) {
      const batch = recipients.slice(index, index + 100);
      const answer = await this.client.getEligibility(batch, correlation, deadline);
      for (const item of answer.recipients ?? [])
        if (item.eligible === true && batch.includes(recipientUuid(item.user_id)))
          accepted.push(recipientUuid(item.user_id));
    }
    const text = REMINDER_TEXT[plan.kind];
    await this.db.withTransaction(async (client) => {
      for (const userId of accepted)
        await client.query(
          `INSERT INTO notifications(user_id,trip_id,type,title,body,source_id,status,dedupe_key)
          VALUES($1,$2,$3,$4,$5,$6,'AVAILABLE',$7) ON CONFLICT(dedupe_key) DO NOTHING`,
          [
            userId,
            row.trip_id,
            plan.kind,
            text.title,
            text.body,
            row.source_id,
            reminderDedupeKey(plan.kind, row.source_id, userId, now),
          ],
        );
      await client.query(
        `UPDATE finance_reminder_schedules SET next_at=$4,sent_count=sent_count+1,claim_owner=NULL,claim_until=NULL,updated_at=clock_timestamp()
        WHERE source_type=$1 AND source_id=$2 AND claim_owner=$3`,
        [row.source_type, row.source_id, this.owner, plan.nextAt],
      );
    });
  }
  private async remove(row: Row) {
    await this.db.query(
      'DELETE FROM finance_reminder_schedules WHERE source_type=$1 AND source_id=$2 AND claim_owner=$3',
      [row.source_type, row.source_id, this.owner],
    );
  }
  private async move(row: Row, nextAt: Date) {
    await this.db.query(
      `UPDATE finance_reminder_schedules SET next_at=$4,claim_owner=NULL,claim_until=NULL,updated_at=clock_timestamp()
      WHERE source_type=$1 AND source_id=$2 AND claim_owner=$3`,
      [row.source_type, row.source_id, this.owner, nextAt],
    );
  }
}
