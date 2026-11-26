import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseProvider } from '@wolfari/database';
import { classifyPayosStatus, PAYOS_REFERENCE, payosWebhookPaid } from '../domain/payos-payment';
import {
  normalizedAccount,
  PAYOS_CHECKOUT_HOST,
  PAYOS_LINK_MINUTES,
  type PayosError,
  type PayosLink,
  type PayosWebhookData,
} from '../providers/payos.provider';
import { PaymentRepository } from './payment.repository';

type Client = Pick<DatabaseProvider, 'query'>;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const destinationAccount = (snapshot: unknown) =>
  normalizedAccount(String(record(record(snapshot).recipient).account_number ?? ''));
/** Error codes that wait for a Holder decision; the reconciliation worker leaves them alone. */
const HOLDER_REVIEW = ['PREVIOUS_HOLDER_REVIEW_REQUIRED', 'PAYOS_REVIEW_REQUIRED'];

export type PayosDispatchCommand = Readonly<{
  id: string;
  orderCode: number;
  amount: bigint;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  expiredAt: number;
  /** Holder name on the contribution's VietQR destination, for the virtual-account guard. */
  destinationName: string;
}>;

/**
 * payOS side of the payment workflow. It shares PaymentRepository's Fund-first lock order and its
 * single ledger writer (settleSuccess), so a payOS webhook, a reconciliation result and a manual
 * Holder confirmation all converge on at most one IN entry per contribution.
 */
@Injectable()
export class PayosPaymentRepository {
  constructor(
    @Inject(DatabaseProvider) private readonly db: DatabaseProvider,
    private readonly payments: PaymentRepository,
  ) {}

  /** Stores verified webhook evidence once; matching and posting happen in processWebhook. */
  async receiveWebhook(data: PayosWebhookData) {
    return this.db.withTransaction(async (client) => {
      const attempt = (
        await client.query<{
          id: string;
          amount: string;
          provider_payload: unknown;
          destination_snapshot: unknown;
        }>(
          `SELECT id,amount::text,provider_payload,destination_snapshot FROM payment_attempts
           WHERE provider='PAYOS' AND environment='LIVE' AND provider_order_id=$1`,
          [String(data.orderCode)],
        )
      ).rows[0];
      if (attempt) await this.payments.lockAttemptFund(client, attempt.id);
      const linkId = record(attempt?.provider_payload).payment_link_id;
      // Money must land in the destination account or in the payOS virtual account this very
      // link was created with (which forwards to it).
      const payAccount = record(attempt?.provider_payload).pay_account_number;
      const accounts = [
        attempt ? destinationAccount(attempt.destination_snapshot) : '',
        typeof payAccount === 'string' ? payAccount : '',
      ].filter(Boolean);
      const paidInto = [data.accountNumber, data.virtualAccountNumber ?? '']
        .map(normalizedAccount)
        .filter(Boolean);
      let status: 'RECEIVED' | 'NEEDS_REVIEW' = 'RECEIVED';
      let reason: string | null = null;
      if (!attempt) [status, reason] = ['NEEDS_REVIEW', 'ATTEMPT_NOT_FOUND'];
      else if (typeof linkId === 'string' && linkId !== data.paymentLinkId)
        [status, reason] = ['NEEDS_REVIEW', 'PAYMENT_LINK_MISMATCH'];
      else if (data.amount.toString() !== attempt.amount)
        [status, reason] = ['NEEDS_REVIEW', 'AMOUNT_MISMATCH'];
      else if (!paidInto.some((account) => accounts.includes(account)))
        [status, reason] = ['NEEDS_REVIEW', 'ACCOUNT_MISMATCH'];
      else if (!payosWebhookPaid(data.code)) [status, reason] = ['NEEDS_REVIEW', 'NOT_PAID'];
      else if (!PAYOS_REFERENCE.test(data.reference))
        [status, reason] = ['NEEDS_REVIEW', 'REFERENCE_INVALID'];
      // Payer name/account (counterAccount*) are never stored: only what reconciliation needs.
      const payload = {
        source: 'WEBHOOK',
        order_code: String(data.orderCode),
        amount: data.amount.toString(),
        payment_link_id: data.paymentLinkId,
        reference: data.reference,
        code: data.code,
        transaction_date_time: data.transactionDateTime,
      };
      const dedupe = createHash('sha256')
        .update(
          JSON.stringify([data.paymentLinkId, data.reference, payload.amount, data.code, payload.order_code]),
        )
        .digest('hex');
      const row = (
        await client.query<{ id: string; processing_status: string; payment_attempt_id: string | null }>(
          `INSERT INTO payment_webhook_receipts(provider,environment,dedupe_key,payment_attempt_id,
           signature_valid,received_amount,payload,processing_status,review_reason)
           VALUES('PAYOS','LIVE',$1,$2,true,$3,$4::jsonb,$5,$6)
           ON CONFLICT(provider,environment,dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key
           RETURNING id,processing_status,payment_attempt_id`,
          [dedupe, attempt?.id ?? null, payload.amount, JSON.stringify(payload), status, reason],
        )
      ).rows[0]!;
      if (attempt && row.processing_status === 'NEEDS_REVIEW' && row.payment_attempt_id === attempt.id)
        await client.query(
          `UPDATE payment_attempts SET needs_reconciliation=true,
           error_code=CASE WHEN error_code='PREVIOUS_HOLDER_REVIEW_REQUIRED' THEN error_code ELSE 'PAYOS_REVIEW_REQUIRED' END,
           updated_at=clock_timestamp() WHERE id=$1 AND status<>'SUCCEEDED'`,
          [attempt.id],
        );
      return row;
    });
  }

  async dispatchCandidates() {
    return (
      await this.db.query<{ id: string }>(
        `SELECT id FROM payment_attempts WHERE provider='PAYOS' AND environment='LIVE'
         AND status='CREATED' ORDER BY created_at,id LIMIT 20`,
      )
    ).rows.map((row) => row.id);
  }
  /** CREATED → PENDING before calling payOS, so a crash mid-call becomes a reconciliation. */
  async claimDispatch(id: string, now = Date.now()): Promise<PayosDispatchCommand | undefined> {
    return this.db.withTransaction(async (client) => {
      const row = await this.payments.lockedAttempt(client, id);
      if (!row || row.provider !== 'PAYOS' || row.status !== 'CREATED') return undefined;
      const payload = record(row.provider_payload);
      const returnUrl = typeof payload.return_url === 'string' ? payload.return_url : '';
      const description = typeof payload.description === 'string' ? payload.description : '';
      const expiredAt = Math.floor(now / 1000) + PAYOS_LINK_MINUTES * 60;
      await client.query(
        `UPDATE payment_attempts SET status='PENDING',expires_at=to_timestamp($3),
         provider_payload=provider_payload||$2::jsonb,updated_at=clock_timestamp() WHERE id=$1`,
        [
          id,
          JSON.stringify({ phase: 'CREATE_DISPATCH', dispatch_started_at: new Date(now).toISOString() }),
          expiredAt,
        ],
      );
      return {
        id,
        orderCode: Number(row.provider_order_id),
        amount: BigInt(row.amount),
        description,
        returnUrl,
        cancelUrl: returnUrl,
        expiredAt,
        destinationName: String(
          record(record(row.destination_snapshot).recipient).account_name ?? '',
        ),
      };
    });
  }
  /** `accountMatches` comes from the provider: payOS must pay into the configured account. */
  async completeDispatch(id: string, link: PayosLink, accountMatches: boolean) {
    await this.db.withTransaction(async (client) => {
      if (!(await this.payments.lockAttemptFund(client, id))) return;
      if (!accountMatches || !link.checkoutUrl) {
        // A link that pays elsewhere is never shown; it expires unused at payOS.
        await client.query(
          `UPDATE payment_attempts SET status='FAILED',needs_reconciliation=false,
           error_code=$2,provider_payload=provider_payload||$3::jsonb,updated_at=clock_timestamp()
           WHERE id=$1 AND status='PENDING'`,
          [
            id,
            accountMatches ? 'PAYOS_LINK_INCOMPLETE' : 'PAYOS_ACCOUNT_MISMATCH',
            JSON.stringify({ phase: 'CREATE_FAILED', payment_link_id: link.paymentLinkId }),
          ],
        );
        return;
      }
      await client.query(
        `UPDATE payment_attempts SET needs_reconciliation=false,error_code=NULL,
         provider_payload=provider_payload||$2::jsonb,updated_at=clock_timestamp()
         WHERE id=$1 AND status='PENDING'`,
        [
          id,
          JSON.stringify({
            phase: 'AWAITING_WEBHOOK',
            payment_link_id: link.paymentLinkId,
            payment_url: link.checkoutUrl,
            // The merchant-side account the QR pays (a virtual account for some banks); the
            // webhook may report it instead of the linked account.
            pay_account_number: link.accountNumber ? normalizedAccount(link.accountNumber) : null,
          }),
        ],
      );
    });
  }
  async failDispatch(id: string, error: PayosError | undefined) {
    await this.db.withTransaction(async (client) => {
      if (!(await this.payments.lockAttemptFund(client, id))) return;
      // A definitive refusal created no link: nothing can be paid. Anything else may have.
      if (error?.kind === 'definitive')
        await client.query(
          `UPDATE payment_attempts SET status='FAILED',needs_reconciliation=false,error_code=$2,
           provider_payload=provider_payload||'{"phase":"CREATE_FAILED"}'::jsonb,updated_at=clock_timestamp()
           WHERE id=$1 AND status='PENDING'`,
          [id, error.code.slice(0, 60)],
        );
      else
        await client.query(
          `UPDATE payment_attempts SET needs_reconciliation=true,error_code='PAYOS_CREATE_UNCERTAIN',
           provider_payload=provider_payload||'{"phase":"QUERY_REQUIRED"}'::jsonb,updated_at=clock_timestamp()
           WHERE id=$1 AND status='PENDING'`,
          [id],
        );
    });
  }
  /** Dispatches cut off mid-call and links past their expiry are checked with payOS. */
  async markStale() {
    const candidates = (
      await this.db.query<{ id: string }>(
        `SELECT id FROM payment_attempts WHERE provider='PAYOS' AND environment='LIVE'
         AND status='PENDING' AND NOT needs_reconciliation
         AND ((provider_payload->>'phase'='CREATE_DISPATCH' AND updated_at<clock_timestamp()-interval '45 seconds')
           OR expires_at<=clock_timestamp())
         ORDER BY updated_at,id LIMIT 100`,
      )
    ).rows;
    for (const candidate of candidates)
      await this.db.withTransaction(async (client) => {
        if (!(await this.payments.lockAttemptFund(client, candidate.id))) return;
        await client.query(
          `UPDATE payment_attempts SET needs_reconciliation=true,
           error_code=CASE WHEN provider_payload->>'phase'='CREATE_DISPATCH' THEN 'PAYOS_CREATE_UNCERTAIN' ELSE 'PAYOS_WEBHOOK_TIMEOUT' END,
           provider_payload=provider_payload||'{"phase":"QUERY_REQUIRED"}'::jsonb,updated_at=clock_timestamp()
           WHERE id=$1 AND status='PENDING' AND NOT needs_reconciliation
           AND ((provider_payload->>'phase'='CREATE_DISPATCH' AND updated_at<clock_timestamp()-interval '45 seconds')
             OR expires_at<=clock_timestamp())`,
          [candidate.id],
        );
      });
  }

  async reconciliationCandidates() {
    return (
      await this.db.query<{ id: string }>(
        `SELECT id FROM payment_attempts WHERE provider='PAYOS' AND environment='LIVE'
         AND needs_reconciliation AND status<>'SUCCEEDED'
         AND (error_code IS NULL OR error_code <> ALL($1::text[]))
         AND updated_at<=clock_timestamp()-interval '30 seconds'
         ORDER BY updated_at,id LIMIT 20`,
        [HOLDER_REVIEW],
      )
    ).rows.map((row) => row.id);
  }
  async reconciliationCommand(id: string) {
    const row = await this.payments.attemptScope(id);
    return row && row.provider === 'PAYOS'
      ? {
          id: row.id,
          orderCode: Number(row.provider_order_id),
          amount: BigInt(row.amount),
          createdAt: new Date(row.created_at),
        }
      : undefined;
  }
  async completeQuery(id: string, link: PayosLink) {
    await this.db.withTransaction(async (client) => {
      const row = await this.payments.lockedAttempt(client, id);
      if (!row || row.provider !== 'PAYOS') return;
      if (link.orderCode !== Number(row.provider_order_id) || link.amount !== BigInt(row.amount)) {
        await this.reviewFromQuery(client, row, link, 'QUERY_MISMATCH');
        return;
      }
      const outcome = classifyPayosStatus(link.status);
      if (outcome === 'SUCCEEDED') {
        if (!link.reference) {
          await this.reviewFromQuery(client, row, link, 'QUERY_TRANSACTION_MISSING');
          return;
        }
        const settled = await this.payments.settleSuccess(client, row.id, {
          transactionId: link.reference,
          correlation: randomUUID(),
          actor: null,
          system: 'PAYOS_RECONCILIATION',
        });
        if (!settled) await this.reviewFromQuery(client, row, link, 'QUERY_SUCCESS_CONFLICT');
        return;
      }
      if (outcome === 'REVIEW') {
        await this.reviewFromQuery(client, row, link, 'UNDERPAID');
        return;
      }
      // A stale non-paid answer can never revoke money already posted for this attempt.
      if (row.status === 'SUCCEEDED') return;
      if (outcome === 'PENDING') {
        const payload = record(row.provider_payload);
        const open = !row.expires_at || new Date(row.expires_at).getTime() > Date.now();
        await client.query(
          `UPDATE payment_attempts SET needs_reconciliation=$2,error_code=$3,
           provider_payload=provider_payload||$4::jsonb,updated_at=clock_timestamp()
           WHERE id=$1 AND status<>'SUCCEEDED'`,
          [
            id,
            !open,
            open ? null : 'PAYOS_LINK_STILL_OPEN',
            JSON.stringify({
              phase: open ? 'AWAITING_WEBHOOK' : 'QUERY_REQUIRED',
              payment_link_id: link.paymentLinkId,
              // GET has no checkoutUrl; the hosted page is addressed by the link id.
              ...(typeof payload.payment_url === 'string'
                ? {}
                : { payment_url: `https://${PAYOS_CHECKOUT_HOST}/web/${link.paymentLinkId}` }),
            }),
          ],
        );
        return;
      }
      await client.query(
        `UPDATE payment_attempts SET status=$2,needs_reconciliation=false,reconciled_at=clock_timestamp(),
         error_code=$3,provider_payload=provider_payload||$4::jsonb,updated_at=clock_timestamp()
         WHERE id=$1 AND status<>'SUCCEEDED'`,
        [
          id,
          outcome === 'EXPIRED' ? 'EXPIRED' : 'FAILED',
          `PAYOS_${link.status}`,
          JSON.stringify({ phase: 'CLOSED', payment_link_id: link.paymentLinkId }),
        ],
      );
    });
  }
  async failQuery(id: string, error: PayosError | undefined, now = Date.now()) {
    await this.db.withTransaction(async (client) => {
      const row = await this.payments.lockedAttempt(client, id);
      if (!row || row.provider !== 'PAYOS' || row.status === 'SUCCEEDED') return;
      // payOS keeps refusing to describe an order long after its link expired: no link exists
      // that could still take money, so the attempt is closed and the member may try again.
      // A late webhook for it would still post through settleSuccess.
      const expired =
        row.expires_at !== null &&
        new Date(row.expires_at).getTime() + 15 * 60_000 < now &&
        new Date(row.created_at).getTime() + 30 * 60_000 < now;
      if (error?.kind === 'definitive' && expired)
        await client.query(
          `UPDATE payment_attempts SET status='FAILED',needs_reconciliation=false,
           error_code='PAYOS_LINK_UNAVAILABLE',updated_at=clock_timestamp()
           WHERE id=$1 AND status<>'SUCCEEDED'`,
          [id],
        );
      else
        await client.query(
          `UPDATE payment_attempts SET needs_reconciliation=true,error_code=$2,
           updated_at=clock_timestamp() WHERE id=$1 AND status<>'SUCCEEDED'`,
          [id, error?.kind === 'definitive' ? 'PAYOS_QUERY_REJECTED' : 'PAYOS_QUERY_UNAVAILABLE'],
        );
    });
  }
  private async reviewFromQuery(
    client: Client,
    row: { id: string; fund_id: string; amount: string; provider_order_id: string },
    link: PayosLink,
    reason: string,
  ) {
    await this.payments.lockFund(client, row.fund_id);
    const payload = {
      source: 'QUERY',
      order_code: String(link.orderCode),
      amount: link.amount.toString(),
      amount_paid: link.amountPaid?.toString(),
      status: link.status,
      payment_link_id: link.paymentLinkId,
      reference: link.reference,
    };
    const key = createHash('sha256')
      .update(JSON.stringify({ attempt: row.id, ...payload, reason }))
      .digest('hex');
    await client.query(
      `INSERT INTO payment_webhook_receipts(provider,environment,dedupe_key,payment_attempt_id,
       signature_valid,received_amount,payload,processing_status,review_reason)
       VALUES('PAYOS','LIVE',$1,$2,true,$3,$4::jsonb,'NEEDS_REVIEW',$5)
       ON CONFLICT(provider,environment,dedupe_key) DO NOTHING`,
      [key, row.id, (link.amountPaid ?? link.amount).toString(), JSON.stringify(payload), reason],
    );
    await client.query(
      `UPDATE payment_attempts SET needs_reconciliation=true,
       error_code=CASE WHEN error_code='PREVIOUS_HOLDER_REVIEW_REQUIRED' THEN error_code ELSE 'PAYOS_REVIEW_REQUIRED' END,
       updated_at=clock_timestamp() WHERE id=$1`,
      [row.id],
    );
  }

  async webhookCandidates() {
    return (
      await this.db.query<{ id: string }>(
        `SELECT id FROM payment_webhook_receipts WHERE provider='PAYOS' AND environment='LIVE'
         AND processing_status='RECEIVED' ORDER BY received_at,id LIMIT 20`,
      )
    ).rows.map((row) => row.id);
  }
  async processWebhook(id: string) {
    return this.db.withTransaction(async (client) => {
      const scope = (
        await client.query<{ payment_attempt_id: string | null }>(
          `SELECT payment_attempt_id FROM payment_webhook_receipts
           WHERE id=$1 AND provider='PAYOS' AND processing_status='RECEIVED' AND signature_valid`,
          [id],
        )
      ).rows[0];
      if (
        !scope?.payment_attempt_id ||
        !(await this.payments.lockAttemptFund(client, scope.payment_attempt_id))
      )
        return;
      const receipt = (
        await client.query<{
          id: string;
          payment_attempt_id: string | null;
          processing_status: string;
          payload: unknown;
        }>(
          `SELECT id,payment_attempt_id,processing_status,payload FROM payment_webhook_receipts
           WHERE id=$1 FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (
        !receipt ||
        receipt.processing_status !== 'RECEIVED' ||
        receipt.payment_attempt_id !== scope.payment_attempt_id
      )
        return;
      const payload = record(receipt.payload);
      const settled = await this.payments.settleSuccess(client, scope.payment_attempt_id, {
        transactionId: String(payload.reference ?? ''),
        receiptId: receipt.id,
        correlation: receipt.id,
        actor: null,
        system: 'PAYOS_WEBHOOK',
      });
      if (!settled)
        await client.query(
          `UPDATE payment_webhook_receipts SET processing_status='NEEDS_REVIEW',
           review_reason='LATE_OR_CONFLICTING_SUCCESS' WHERE id=$1`,
          [receipt.id],
        );
    });
  }
}
