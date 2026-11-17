import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseProvider } from '@wolfari/database';
import { createHash, randomUUID } from 'node:crypto';
import { NotificationRepository } from '../notification/notification.repository';
import { DeliveryContextClient } from './delivery-context.client';
import { getExpoReceipt, sendExpoPush } from './expo-push.provider';
import { terminalSourceError } from './reminder.service';

type Delivery = {
  id: string;
  notification_id: string;
  provider_reference: string | null;
  attempt_count: number;
  private_context: { device_id?: string; token_hash?: string; receipt_checks?: number };
};
type Notice = {
  user_id: string;
  trip_id: string | null;
  type: string;
  source_id: string | null;
  status: string;
  read_at: Date | null;
  token: string;
  active: boolean;
  device_user_id: string;
  session_family_id: string | null;
};
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function pushGroup(type: string) {
  return type.includes('INVITATION')
    ? 'INVITATION'
    : type.includes('PACKING')
      ? 'PACKING'
      : type.includes('CONTRIBUTION') || type.includes('TRANSFER')
        ? 'CONTRIBUTION'
        : type.includes('CLOSURE') || type.includes('FINANCE_CLOSED')
          ? 'CLOSURE'
          : type.includes('PRICE')
            ? 'PRICE'
            : 'PLAN';
}
@Injectable()
export class PushDeliveryService {
  private readonly enabled: boolean;
  private readonly token: string;
  private readonly owner = randomUUID();
  private readonly logger = new Logger('PushDelivery');
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(
    private readonly db: DatabaseProvider,
    private readonly context: DeliveryContextClient,
    private readonly notifications: NotificationRepository,
    config: ConfigService,
  ) {
    const flag = config.get<string>('PUSH_DELIVERY_ENABLED') ?? 'false';
    if (!['true', 'false'].includes(flag)) throw Error('Invalid push flag');
    this.enabled = flag === 'true';
    this.token = config.get<string>('EXPO_PUSH_ACCESS_TOKEN')?.trim() ?? '';
    if (this.enabled && !this.token) throw Error('Push delivery requires EXPO_PUSH_ACCESS_TOKEN');
  }
  async enqueue() {
    // The stable per-device key prevents repeated inbox scans from sending a second delivery.
    await this.db
      .query(`INSERT INTO notification_deliveries(notification_id,channel,delivery_key,private_context)
      SELECT n.id,'PUSH','push:'||n.id::text||':'||d.id::text,
        jsonb_build_object('device_id',d.id::text,'token_hash',encode(sha256(convert_to(d.token,'UTF8')),'hex'))
      FROM (SELECT * FROM notifications WHERE status='AVAILABLE' AND read_at IS NULL AND user_id IS NOT NULL AND created_at>=clock_timestamp()-interval '24 hours' ORDER BY created_at DESC,id DESC LIMIT 1000) n
      JOIN device_tokens d ON d.user_id=n.user_id AND d.active AND d.session_family_id IS NOT NULL AND d.platform IN ('IOS','ANDROID')
      ON CONFLICT(delivery_key) DO NOTHING`);
  }
  async runOnce() {
    await this.enqueue();
    const deliveries = await this.db.withTransaction(async (client) => {
      const rows = (
        await client.query<Delivery>(`SELECT * FROM notification_deliveries WHERE channel='PUSH' AND status IN ('PENDING','SENDING') AND next_attempt_at<=clock_timestamp()
        AND (claim_until IS NULL OR claim_until<clock_timestamp()) ORDER BY next_attempt_at,id LIMIT 4 FOR UPDATE SKIP LOCKED`)
      ).rows;
      for (const row of rows)
        await client.query(
          "UPDATE notification_deliveries SET status='SENDING',claim_owner=$2,claim_until=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp() WHERE id=$1",
          [row.id, this.owner],
        );
      return rows;
    });
    await Promise.all(deliveries.map((delivery) => this.deliver(delivery)));
  }
  private async deliver(row: Delivery) {
    try {
      const notice = (
        await this.db.query<Notice>(
          `SELECT n.user_id,n.trip_id,n.type,n.source_id,n.status,n.read_at,d.token,d.active,d.user_id AS device_user_id,d.session_family_id FROM notifications n
        JOIN device_tokens d ON d.id=$2::uuid WHERE n.id=$1`,
          [row.notification_id, row.private_context.device_id],
        )
      ).rows[0];
      if (
        !notice ||
        notice.status !== 'AVAILABLE' ||
        notice.read_at ||
        !notice.active ||
        !notice.session_family_id ||
        notice.user_id !== notice.device_user_id ||
        tokenHash(notice.token) !== row.private_context.token_hash
      ) {
        await this.failed(row.id, 'SUPPRESSED');
        return;
      }
      const preference = await this.notifications.getPreference(notice.user_id);
      if (
        !preference.push_enabled ||
        preference.group_overrides[pushGroup(notice.type)]?.push === false
      ) {
        await this.failed(row.id, 'PREFERENCE_DISABLED');
        return;
      }
      if (!(await this.context.eligible(notice.user_id, notice.trip_id, undefined, notice.session_family_id!))) {
        await this.failed(row.id, 'RECIPIENT_UNAVAILABLE');
        return;
      }
      if (notice.type.endsWith('_REMINDER')) {
        const reminder = (
          await this.db.query<{
            source_id: string;
            type: string;
            status: string;
            private_context: { source_at?: string };
          }>(
            'SELECT source_id,type,status,private_context FROM reminders WHERE id=$1::uuid AND user_id=$2 AND trip_id=$3',
            [notice.source_id, notice.user_id, notice.trip_id],
          )
        ).rows[0];
        if (!reminder || reminder.status !== 'SENT') {
          await this.failed(row.id, 'SOURCE_UNAVAILABLE');
          return;
        }
        const source = await this.context.source({
          trip_id: notice.trip_id!,
          user_id: notice.user_id,
          source_type: reminder.type,
          source_id: reminder.source_id,
        });
        if (
          !source.allowed ||
          !source.at ||
          source.at !== reminder.private_context.source_at ||
          Date.parse(source.at) < Date.now()
        ) {
          await this.failed(row.id, 'SOURCE_CHANGED');
          return;
        }
      }
      const result = row.provider_reference
        ? await getExpoReceipt(row.provider_reference, this.token)
        : await sendExpoPush(
            notice.token,
            {
              notification_id: row.notification_id,
              type: notice.type,
              ...(notice.trip_id ? { trip_id: notice.trip_id } : {}),
            },
            this.token,
          );
      if (result.invalidToken)
        await this.db.query(
          'UPDATE device_tokens SET active=false,updated_at=clock_timestamp() WHERE id=$1 AND token=$2',
          [row.private_context.device_id, notice.token],
        );
      if (result.error) {
        if (result.permanent || row.attempt_count >= 4) {
          await this.failed(row.id, result.error);
          return;
        }
        await this.retry(row, result.error);
        return;
      }
      if (result.reference) {
        await this.db.query(
          "UPDATE notification_deliveries SET provider_reference=$3,next_attempt_at=clock_timestamp()+interval '60 seconds',claim_owner=NULL,claim_until=NULL,last_error=NULL,attempt_count=attempt_count+1,updated_at=clock_timestamp() WHERE id=$1 AND claim_owner=$2",
          [row.id, this.owner, result.reference],
        );
        return;
      }
      if (result.pending) {
        if ((row.private_context.receipt_checks ?? 0) >= 29) {
          await this.failed(row.id, 'RECEIPT_TIMEOUT');
          return;
        }
        await this.db.query(
          "UPDATE notification_deliveries SET next_attempt_at=clock_timestamp()+interval '60 seconds',claim_owner=NULL,claim_until=NULL,private_context=jsonb_set(private_context,'{receipt_checks}',to_jsonb($3::int)),updated_at=clock_timestamp() WHERE id=$1 AND claim_owner=$2",
          [row.id, this.owner, (row.private_context.receipt_checks ?? 0) + 1],
        );
        return;
      }
      await this.db.query(
        "UPDATE notification_deliveries SET status='SENT',sent_at=clock_timestamp(),claim_owner=NULL,claim_until=NULL,last_error=NULL,updated_at=clock_timestamp() WHERE id=$1 AND claim_owner=$2",
        [row.id, this.owner],
      );
    } catch (error) {
      if (terminalSourceError(error)) await this.failed(row.id, 'ACCESS_REVOKED');
      else if (row.attempt_count >= 4) await this.failed(row.id, 'RETRY_EXHAUSTED');
      else await this.retry(row, 'PROVIDER_OR_CONTEXT_UNAVAILABLE');
    }
  }
  private async failed(id: string, code: string) {
    await this.db.query(
      "UPDATE notification_deliveries SET status='FAILED',last_error=$3,claim_owner=NULL,claim_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND claim_owner=$2",
      [id, this.owner, code],
    );
  }
  private async retry(row: Delivery, code: string) {
    const delay = [10, 30, 120, 300, 900][Math.min(row.attempt_count, 4)]!;
    await this.db.query(
      "UPDATE notification_deliveries SET status='SENDING',attempt_count=attempt_count+1,last_error=$3,next_attempt_at=clock_timestamp()+($4::int*interval '1 second'),claim_owner=NULL,claim_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND claim_owner=$2",
      [row.id, this.owner, code, delay],
    );
  }
  onModuleInit() {
    if (this.enabled) {
      this.timer = setInterval(() => {
        if (!this.running)
          this.running = this.runOnce()
            .catch(() => this.logger.warn('PUSH_POLL_UNAVAILABLE'))
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
