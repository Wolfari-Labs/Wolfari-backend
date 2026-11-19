import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { FundQueryService } from './fund-query.service';
import { FinanceReadError, readUuid } from '../finance.errors';
import { MomoSandboxProvider } from '../providers/momo-sandbox.provider';

type Input = {
  actor_user_id?: string;
  trip_id?: string;
  request_id?: string;
  amount?: string;
  note?: string;
};
type Checkout = {
  request_id: string;
  order_id: string;
  amount: string;
  payment_url: string;
  environment: string;
};
type Entry = { fingerprint: string; expires: number; task?: Promise<Checkout>; result?: Checkout };

/** Isolated MoMo test checkout. No fund, contribution, expense, ledger or receipt is written. */
@Injectable()
export class QrSandboxService {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly queries: FundQueryService,
    private readonly provider: MomoSandboxProvider,
    private readonly config: ConfigService,
  ) {}

  async create(input: Input, correlation: string, deadline: number): Promise<Checkout> {
    const actor = readUuid(input.actor_user_id),
      trip = readUuid(input.trip_id),
      request = readUuid(input.request_id);
    const amount = input.amount,
      note = input.note;
    if (
      typeof amount !== 'string' ||
      !/^[1-9]\d{0,7}$/.test(amount) ||
      BigInt(amount) < 1000n ||
      BigInt(amount) > 50000000n ||
      typeof note !== 'string' ||
      note !== note.trim() ||
      !note ||
      [...note].length > 150 ||
      /[\u0000-\u001f\u007f]/.test(note)
    )
      throw new FinanceReadError('VALIDATION_FAILED');
    await this.queries.authorizeQrSandbox(trip, actor, correlation, deadline);
    if (this.config.get('NODE_ENV') === 'production')
      throw new FinanceReadError('SERVICE_UNAVAILABLE');
    let configured = false;
    try { configured = this.provider.ready(); } catch { /* Invalid configuration is never exposed. */ }
    if (!configured) throw new FinanceReadError('PAYMENT_PROVIDER_NOT_CONFIGURED');
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key);
    const key = `${actor}:${trip}:${request}`,
      fingerprint = JSON.stringify([amount, note]);
    let entry = this.entries.get(key);
    if (entry && entry.fingerprint !== fingerprint)
      throw new FinanceReadError('IDEMPOTENCY_CONFLICT');
    if (entry?.result) return entry.result;
    if (entry?.task) return entry.task;
    if (!entry) {
      // Bounded memory and per-user demo rate. Remote provider credentials stay server-side.
      if (
        this.entries.size >= 1000 ||
        [...this.entries.keys()].filter((value) => value.startsWith(`${actor}:`)).length >= 5
      )
        throw new FinanceReadError('SERVICE_UNAVAILABLE');
      entry = { fingerprint, expires: now + 5 * 60_000 };
      this.entries.set(key, entry);
    }
    const orderId = `wqr-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
    const current = entry;
    current.task = (async () => {
      try {
        const result = await this.provider.create({
          amount: BigInt(amount),
          orderId,
          requestId: request,
          orderInfo: `Wolfari QR Sandbox: ${note}`,
        });
        if (result.resultCode !== 0 || !result.paymentUrl)
          throw new FinanceReadError('SERVICE_UNAVAILABLE');
        const url = new URL(result.paymentUrl);
        if (
          url.protocol !== 'https:' ||
          url.hostname !== 'test-payment.momo.vn' ||
          url.username ||
          url.password ||
          url.port
        )
          throw new FinanceReadError('SERVICE_UNAVAILABLE');
        current.result = {
          request_id: request,
          order_id: orderId,
          amount,
          payment_url: url.href,
          environment: 'SANDBOX',
        };
        return current.result;
      } catch (cause) {
        if (cause instanceof FinanceReadError) throw cause;
        throw new FinanceReadError('SERVICE_UNAVAILABLE');
      } finally {
        current.task = undefined;
      }
    })();
    return current.task;
  }
}
