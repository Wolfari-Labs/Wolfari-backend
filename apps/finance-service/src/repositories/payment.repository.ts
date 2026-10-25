import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseProvider } from '@wolfari/database';
import type { FinanceV1 } from '@wolfari/contracts/grpc';
import type { FundSetupContext } from '../domain/fund-setup';
import {
  assertCanCreatePaymentAttempt,
  assertHolderPaymentAction,
  classifyMomoResult,
  PaymentRuleError,
} from '../domain/payment-management';
import type {
  CreatePaymentAttemptInput,
  MomoWebhookInput,
  PaymentExceptionPage,
  ReconcilePaymentAttemptInput,
  ResolvePaymentExceptionInput,
} from '../inputs/payment.input';
import { paymentExceptionCursor } from '../inputs/payment.input';
import { FinanceReadError } from '../finance.errors';
import {
  paymentAttemptResponse,
  paymentExceptionResponse,
  type PaymentAttemptRow,
  type PaymentExceptionRow,
} from '../projections/payment-response';
import type { FundWrite, StoredResult } from './fund-command.repository';
import type { MomoCreateResult, MomoQueryResult } from '../providers/momo-sandbox.provider';

export type PaymentWriteCommand =
  | {
      scope: 'CREATE_PAYMENT_ATTEMPT';
      fundId: string;
      contributionId: string;
      body: CreatePaymentAttemptInput & { merchantId: string };
    }
  | {
      scope: 'RECONCILE_PAYMENT_ATTEMPT';
      fundId: string;
      paymentAttemptId: string;
      body: ReconcilePaymentAttemptInput;
    }
  | {
      scope: 'RESOLVE_PAYMENT_EXCEPTION';
      fundId: string;
      paymentExceptionId: string;
      body: ResolvePaymentExceptionInput;
    };
export const isPaymentWrite = (input: FundWrite): input is FundWrite & PaymentWriteCommand =>
  ['CREATE_PAYMENT_ATTEMPT', 'RECONCILE_PAYMENT_ATTEMPT', 'RESOLVE_PAYMENT_EXCEPTION'].includes(
    input.scope,
  );

type Client = Pick<DatabaseProvider, 'query'>;
type AttemptScope = PaymentAttemptRow & {
  fund_id: string;
  trip_id: string;
  request_id: string;
  member_user_id: string;
  holder_user_id: string;
  request_status: string;
  contribution_status: string;
  contribution_version: number;
  finance_version: number;
  current_balance: string;
  provider_order_id: string;
  client_request_id: string;
  merchant_id: string;
  destination_snapshot: unknown;
  provider_transaction_id: string | null;
};
const attemptColumns = `p.id,p.contribution_id,p.provider,p.environment,p.amount::text,p.currency,
p.status,p.provider_payload,p.needs_reconciliation,p.expires_at,p.error_code,p.created_at,p.updated_at`;
const MAX_INT32 = 2_147_483_647;
const MAX_INT64 = 9_223_372_036_854_775_807n;

const mapRule = (error: unknown) => {
  if (error instanceof PaymentRuleError) return new FinanceReadError(error.code);
  return error;
};
const payloadRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const webhookPayload = (input: MomoWebhookInput) => ({
  partner_code: input.partnerCode,
  order_id: input.orderId,
  request_id: input.requestId,
  amount: input.amount.toString(),
  order_info: input.orderInfo,
  order_type: input.orderType,
  transaction_id: input.transactionId,
  result_code: input.resultCode,
  message: input.message,
  pay_type: input.payType,
  response_time: input.responseTime,
  extra_data: input.extraData,
  signature: input.signature,
});
const webhookDedupe = (input: MomoWebhookInput) =>
  createHash('sha256')
    .update(JSON.stringify(webhookPayload(input)))
    .digest('hex');

@Injectable()
export class PaymentRepository {
  constructor(@Inject(DatabaseProvider) readonly db: DatabaseProvider) {}

  async attempt(id: string, client: Client = this.db) {
    return (
      await client.query<PaymentAttemptRow>(
        `SELECT ${attemptColumns} FROM payment_attempts p WHERE p.id=$1`,
        [id],
      )
    ).rows[0];
  }
  async attemptScope(id: string, client: Client = this.db): Promise<AttemptScope | undefined> {
    return (
      await client.query<AttemptScope>(
        `SELECT ${attemptColumns},c.fund_id,f.trip_id,c.request_id,c.member_user_id,
        f.holder_user_id,r.status AS request_status,c.status AS contribution_status,
        c.version AS contribution_version,f.finance_version,f.current_balance::text,
        p.provider_order_id,p.client_request_id,p.merchant_id,p.destination_snapshot,
        p.provider_transaction_id
        FROM payment_attempts p JOIN contributions c ON c.id=p.contribution_id
        JOIN contribution_requests r ON r.id=c.request_id JOIN funds f ON f.id=c.fund_id
        WHERE p.id=$1`,
        [id],
      )
    ).rows[0];
  }
  async contributionScope(id: string) {
    return (
      await this.db.query<{
        fund_id: string;
        trip_id: string;
        request_id: string;
        member_user_id: string;
        holder_user_id: string;
      }>(
        `SELECT c.fund_id,f.trip_id,c.request_id,c.member_user_id,f.holder_user_id
         FROM contributions c JOIN funds f ON f.id=c.fund_id WHERE c.id=$1`,
        [id],
      )
    ).rows[0];
  }
  async fundScope(id: string) {
    return (
      await this.db.query<{ trip_id: string; holder_user_id: string }>(
        'SELECT trip_id,holder_user_id FROM funds WHERE id=$1',
        [id],
      )
    ).rows[0];
  }
  async exceptionScope(id: string) {
    return (
      await this.db.query<{ fund_id: string; trip_id: string; holder_user_id: string }>(
        `SELECT c.fund_id,f.trip_id,f.holder_user_id FROM payment_webhook_receipts w
         JOIN payment_attempts p ON p.id=w.payment_attempt_id
         JOIN contributions c ON c.id=p.contribution_id JOIN funds f ON f.id=c.fund_id
         WHERE w.id=$1`,
        [id],
      )
    ).rows[0];
  }
  async getException(id: string, client: Client = this.db) {
    return (
      await client.query<PaymentExceptionRow>(
        `SELECT id,payment_attempt_id,processing_status,review_reason,received_at,reviewed_at
         FROM payment_webhook_receipts WHERE id=$1 AND signature_valid AND review_reason IS NOT NULL`,
        [id],
      )
    ).rows[0];
  }
  async listExceptions(page: PaymentExceptionPage): Promise<{
    items: FinanceV1.PaymentExceptionView[];
    nextCursor?: string;
  }> {
    const instant = `to_char(w.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const result = await this.db.query<PaymentExceptionRow & { cursor_at: string }>(
      `SELECT w.id,w.payment_attempt_id,w.processing_status,w.review_reason,w.received_at,w.reviewed_at,
       ${instant} AS cursor_at FROM payment_webhook_receipts w
       JOIN payment_attempts p ON p.id=w.payment_attempt_id JOIN contributions c ON c.id=p.contribution_id
       WHERE c.fund_id=$1 AND w.signature_valid AND w.review_reason IS NOT NULL
       AND ($2::timestamptz IS NULL OR (w.received_at,w.id)<($2::timestamptz,$3::uuid))
       ORDER BY w.received_at DESC,w.id DESC LIMIT $4`,
      [page.fundId, page.after?.at ?? null, page.after?.id ?? null, page.limit + 1],
    );
    const rows = result.rows.slice(0, page.limit);
    const last = rows.at(-1);
    return {
      items: rows.map(paymentExceptionResponse),
      nextCursor:
        result.rows.length > page.limit && last
          ? paymentExceptionCursor(page, { at: last.cursor_at, id: last.id })
          : undefined,
    };
  }

  private async lockedAttempt(client: Client, id: string) {
    return (
      await client.query<AttemptScope>(
        `SELECT ${attemptColumns},c.fund_id,f.trip_id,c.request_id,c.member_user_id,
        f.holder_user_id,r.status AS request_status,c.status AS contribution_status,
        c.version AS contribution_version,f.finance_version,f.current_balance::text,
        p.provider_order_id,p.client_request_id,p.merchant_id,p.destination_snapshot,
        p.provider_transaction_id
        FROM payment_attempts p JOIN contributions c ON c.id=p.contribution_id
        JOIN contribution_requests r ON r.id=c.request_id JOIN funds f ON f.id=c.fund_id
        WHERE p.id=$1 FOR UPDATE OF f,r,c,p`,
        [id],
      )
    ).rows[0];
  }
  private destination(value: unknown, fund: string, holder: string) {
    const snapshot = payloadRecord(value);
    const recipient = payloadRecord(snapshot.recipient);
    if (
      snapshot.schema_version !== 1 ||
      snapshot.fund_id !== fund ||
      snapshot.destination_type !== 'MOMO_SANDBOX' ||
      snapshot.holder_user_id !== holder ||
      typeof snapshot.destination_id !== 'string' ||
      typeof snapshot.destination_version !== 'number' ||
      typeof snapshot.confirmed_by_holder_at !== 'string' ||
      !Number.isFinite(new Date(snapshot.confirmed_by_holder_at).getTime()) ||
      typeof recipient.momo_phone !== 'string' ||
      !recipient.momo_phone
    )
      throw new FinanceReadError('STATE_CONFLICT');
    return snapshot;
  }

  async execute(
    client: Client,
    input: FundWrite & PaymentWriteCommand,
    authority: FundSetupContext,
    correlation: string,
  ): Promise<StoredResult> {
    try {
      if (input.scope === 'CREATE_PAYMENT_ATTEMPT')
        return await this.createAttempt(client, input, authority, correlation);
      if (input.scope === 'RECONCILE_PAYMENT_ATTEMPT')
        return await this.requestReconciliation(client, input, authority, correlation);
      return await this.resolveException(client, input, authority, correlation);
    } catch (error) {
      throw mapRule(error);
    }
  }

  private async createAttempt(
    client: Client,
    input: FundWrite & Extract<PaymentWriteCommand, { scope: 'CREATE_PAYMENT_ATTEMPT' }>,
    authority: FundSetupContext,
    correlation: string,
  ): Promise<StoredResult> {
    const row = (
      await client.query<{
        fund_id: string;
        trip_id: string;
        request_id: string;
        member_user_id: string;
        amount: string;
        contribution_status: string;
        contribution_version: number;
        destination_snapshot: unknown;
        request_status: string;
        holder_user_id: string;
        fund_status: 'OPEN' | 'CLOSING' | 'CLOSED';
        finance_version: number;
      }>(
        `SELECT c.fund_id,f.trip_id,c.request_id,c.member_user_id,c.amount::text,
         c.status AS contribution_status,c.version AS contribution_version,c.destination_snapshot,
         r.status AS request_status,f.holder_user_id,f.status AS fund_status,f.finance_version
         FROM contributions c JOIN contribution_requests r ON r.id=c.request_id
         JOIN funds f ON f.id=c.fund_id WHERE c.id=$1 AND c.fund_id=$2 AND f.trip_id=$3
         FOR UPDATE OF f,r,c`,
        [input.contributionId, input.fundId, input.tripId],
      )
    ).rows[0];
    if (!row) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    assertCanCreatePaymentAttempt(input.body, {
      ...authority,
      actorUserId: input.actor,
      memberUserId: row.member_user_id,
      holderUserId: row.holder_user_id,
      fundStatus: row.fund_status,
      requestStatus: row.request_status,
      contributionStatus: row.contribution_status,
      contributionVersion: row.contribution_version,
      financeVersion: row.finance_version,
    });
    const amount = BigInt(row.amount);
    if (amount < 1_000n || amount > 50_000_000n) throw new FinanceReadError('STATE_CONFLICT');
    const snapshot = this.destination(row.destination_snapshot, row.fund_id, row.holder_user_id);
    const existing = await client.query(
      `SELECT 1 FROM payment_attempts WHERE contribution_id=$1 AND
       (status IN ('CREATED','PENDING','SUCCEEDED') OR needs_reconciliation) FOR UPDATE`,
      [input.contributionId],
    );
    if (existing.rowCount) throw new FinanceReadError('STATE_CONFLICT');
    const ledger = await client.query(
      "SELECT 1 FROM fund_transactions WHERE contribution_id=$1 AND transaction_type='CONTRIBUTION'",
      [input.contributionId],
    );
    if (ledger.rowCount || row.finance_version >= MAX_INT32)
      throw new FinanceReadError('STATE_CONFLICT');
    const id = randomUUID();
    const attempt = (
      await client.query<PaymentAttemptRow>(
        `INSERT INTO payment_attempts(id,contribution_id,provider,environment,amount,currency,
         client_request_id,status,provider_payload,merchant_id,provider_order_id,destination_snapshot)
         VALUES($1,$2,'MOMO_SANDBOX','SANDBOX',$3,'VND',$4,'CREATED',$5::jsonb,$6,$7,$8::jsonb)
         RETURNING id,contribution_id,provider,environment,amount::text,currency,status,provider_payload,
         needs_reconciliation,expires_at,error_code,created_at,updated_at`,
        [
          id,
          input.contributionId,
          amount.toString(),
          input.operationId,
          JSON.stringify({ schema_version: 1, phase: 'READY_TO_CREATE' }),
          input.body.merchantId,
          `WLF-${id}`,
          JSON.stringify(snapshot),
        ],
      )
    ).rows[0]!;
    const financeVersion = row.finance_version + 1;
    await client.query(
      'UPDATE funds SET finance_version=$2,updated_at=clock_timestamp() WHERE id=$1',
      [input.fundId, financeVersion],
    );
    await this.audit(client, {
      fundId: input.fundId,
      actor: input.actor,
      system: null,
      action: input.scope,
      entity: 'PaymentAttempt',
      entityId: id,
      from: row.finance_version,
      to: financeVersion,
      correlation,
      details: { operation_id: input.operationId, contribution_id: input.contributionId },
    });
    return { version: 1, tripId: input.tripId, paymentAttempt: paymentAttemptResponse(attempt) };
  }

  private async requestReconciliation(
    client: Client,
    input: FundWrite & Extract<PaymentWriteCommand, { scope: 'RECONCILE_PAYMENT_ATTEMPT' }>,
    authority: FundSetupContext,
    correlation: string,
  ): Promise<StoredResult> {
    const row = await this.lockedAttempt(client, input.paymentAttemptId);
    if (!row || row.fund_id !== input.fundId || row.trip_id !== input.tripId)
      throw new FinanceReadError('RESOURCE_NOT_FOUND');
    assertHolderPaymentAction(
      input.actor,
      row.holder_user_id,
      authority.activeMemberUserIds,
      row.finance_version >= 1 ? await this.fundStatus(client, input.fundId) : 'CLOSED',
    );
    if (row.status === 'SUCCEEDED' || row.finance_version >= MAX_INT32)
      throw new FinanceReadError('STATE_CONFLICT');
    const changed = !row.needs_reconciliation;
    const next = (
      await client.query<PaymentAttemptRow>(
        `UPDATE payment_attempts SET needs_reconciliation=true,error_code=NULL,
         provider_payload=provider_payload||$2::jsonb,updated_at=clock_timestamp() WHERE id=$1
         RETURNING id,contribution_id,provider,environment,amount::text,currency,status,provider_payload,
         needs_reconciliation,expires_at,error_code,created_at,updated_at`,
        [
          row.id,
          JSON.stringify({
            reconcile_requested_at: new Date().toISOString(),
            reconcile_reason: input.body.reason,
          }),
        ],
      )
    ).rows[0]!;
    const nextVersion = row.finance_version + (changed ? 1 : 0);
    if (changed)
      await client.query(
        'UPDATE funds SET finance_version=$2,updated_at=clock_timestamp() WHERE id=$1',
        [input.fundId, nextVersion],
      );
    await this.audit(client, {
      fundId: input.fundId,
      actor: input.actor,
      system: null,
      action: input.scope,
      entity: 'PaymentAttempt',
      entityId: row.id,
      from: row.finance_version,
      to: nextVersion,
      correlation,
      details: { operation_id: input.operationId, reason: input.body.reason },
    });
    return { version: 1, tripId: input.tripId, paymentAttempt: paymentAttemptResponse(next) };
  }

  private async fundStatus(client: Client, fundId: string) {
    return (
      await client.query<{ status: 'OPEN' | 'CLOSING' | 'CLOSED' }>(
        'SELECT status FROM funds WHERE id=$1',
        [fundId],
      )
    ).rows[0]?.status;
  }

  private async resolveException(
    client: Client,
    input: FundWrite & Extract<PaymentWriteCommand, { scope: 'RESOLVE_PAYMENT_EXCEPTION' }>,
    authority: FundSetupContext,
    correlation: string,
  ): Promise<StoredResult> {
    const fund = (
      await client.query<{
        holder_user_id: string;
        status: 'OPEN' | 'CLOSING' | 'CLOSED';
        finance_version: number;
      }>(
        'SELECT holder_user_id,status,finance_version FROM funds WHERE id=$1 AND trip_id=$2 FOR UPDATE',
        [input.fundId, input.tripId],
      )
    ).rows[0];
    if (!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    assertHolderPaymentAction(
      input.actor,
      fund.holder_user_id,
      authority.activeMemberUserIds,
      fund.status,
    );
    if (fund.finance_version !== input.body.expectedFinanceVersion)
      throw new FinanceReadError('VERSION_CONFLICT');
    if (fund.finance_version >= MAX_INT32) throw new FinanceReadError('STATE_CONFLICT');
    let exception = (
      await client.query<PaymentExceptionRow & { payload: unknown; signature_valid: boolean }>(
        `SELECT id,payment_attempt_id,processing_status,review_reason,received_at,reviewed_at,
         payload,signature_valid FROM payment_webhook_receipts WHERE id=$1 FOR UPDATE`,
        [input.paymentExceptionId],
      )
    ).rows[0];
    if (
      !exception ||
      !exception.signature_valid ||
      exception.processing_status !== 'NEEDS_REVIEW' ||
      exception.reviewed_at
    )
      throw new FinanceReadError(exception ? 'STATE_CONFLICT' : 'RESOURCE_NOT_FOUND');
    const payload = payloadRecord(exception.payload);
    const resultCode = Number(payload.result_code);
    if (!Number.isInteger(resultCode)) throw new FinanceReadError('STATE_CONFLICT');
    if (input.body.resolution === 'NO_FINANCIAL_EFFECT') {
      if (resultCode === 0 && typeof payload.transaction_id === 'string')
        throw new FinanceReadError('STATE_CONFLICT');
      exception = (
        await client.query<typeof exception>(
          `UPDATE payment_webhook_receipts SET processing_status='IGNORED',review_reason=$2,
           reviewed_by_user_id=$3,reviewed_at=clock_timestamp(),processed_at=clock_timestamp()
           WHERE id=$1 RETURNING id,payment_attempt_id,processing_status,review_reason,received_at,
           reviewed_at,payload,signature_valid`,
          [exception.id, input.body.reason, input.actor],
        )
      ).rows[0]!;
      await client.query(
        'UPDATE funds SET finance_version=finance_version+1,updated_at=clock_timestamp() WHERE id=$1',
        [input.fundId],
      );
    } else {
      const attemptId = input.body.linkedAttemptId!;
      const attempt = await this.lockedAttempt(client, attemptId);
      if (!attempt || attempt.fund_id !== input.fundId || attempt.provider !== 'MOMO_SANDBOX')
        throw new FinanceReadError('RESOURCE_NOT_FOUND');
      if (
        String(payload.partner_code) !== attempt.merchant_id ||
        String(payload.amount) !== attempt.amount
      )
        throw new FinanceReadError('STATE_CONFLICT');
      await client.query('UPDATE payment_webhook_receipts SET payment_attempt_id=$2 WHERE id=$1', [
        exception.id,
        attempt.id,
      ]);
      if (classifyMomoResult(resultCode) === 'SUCCEEDED') {
        const settlement = await this.settleSuccess(client, attempt.id, {
          transactionId: String(payload.transaction_id),
          receiptId: exception.id,
          correlation,
          actor: input.actor,
          system: null,
        });
        if (!settlement) throw new FinanceReadError('STATE_CONFLICT');
        await client.query(
          `UPDATE payment_webhook_receipts SET review_reason=$2,reviewed_by_user_id=$3,
           reviewed_at=clock_timestamp() WHERE id=$1`,
          [exception.id, input.body.reason, input.actor],
        );
      } else {
        const nextStatus = classifyMomoResult(resultCode) === 'FAILED' ? 'FAILED' : 'PENDING';
        await client.query(
          `UPDATE payment_attempts SET status=$2,needs_reconciliation=$3,
           error_code=$4,updated_at=clock_timestamp() WHERE id=$1`,
          [attempt.id, nextStatus, nextStatus === 'PENDING', `MOMO_${resultCode}`],
        );
        await client.query(
          `UPDATE payment_webhook_receipts SET processing_status='PROCESSED',review_reason=$2,
           reviewed_by_user_id=$3,reviewed_at=clock_timestamp(),processed_at=clock_timestamp()
           WHERE id=$1`,
          [exception.id, input.body.reason, input.actor],
        );
        await client.query(
          'UPDATE funds SET finance_version=finance_version+1,updated_at=clock_timestamp() WHERE id=$1',
          [input.fundId],
        );
      }
      exception = (
        await client.query<PaymentExceptionRow>(
          `SELECT id,payment_attempt_id,processing_status,review_reason,received_at,reviewed_at
         FROM payment_webhook_receipts WHERE id=$1`,
          [exception.id],
        )
      ).rows[0]! as typeof exception;
    }
    const nextFund = (
      await client.query<{ finance_version: number }>(
        'SELECT finance_version FROM funds WHERE id=$1',
        [input.fundId],
      )
    ).rows[0]!;
    await this.audit(client, {
      fundId: input.fundId,
      actor: input.actor,
      system: null,
      action: input.scope,
      entity: 'PaymentException',
      entityId: exception.id,
      from: fund.finance_version,
      to: nextFund.finance_version,
      correlation,
      details: { operation_id: input.operationId, resolution: input.body.resolution },
    });
    return {
      version: 1,
      tripId: input.tripId,
      paymentException: paymentExceptionResponse(exception),
    };
  }

  async receiveWebhook(input: MomoWebhookInput, signatureValid: boolean, expectedPartner: string) {
    const attempt = (
      await this.db.query<{
        id: string;
        merchant_id: string;
        client_request_id: string;
        contribution_id: string;
        amount: string;
      }>(
        `SELECT id,merchant_id,client_request_id,contribution_id,amount::text FROM payment_attempts
         WHERE provider='MOMO_SANDBOX' AND environment='SANDBOX' AND provider_order_id=$1`,
        [input.orderId],
      )
    ).rows[0];
    let status: 'RECEIVED' | 'IGNORED' | 'NEEDS_REVIEW' = 'RECEIVED';
    let reason: string | null = null;
    if (!signatureValid) {
      status = 'IGNORED';
      reason = 'INVALID_SIGNATURE';
    } else if (!attempt) {
      status = 'NEEDS_REVIEW';
      reason = 'ATTEMPT_NOT_FOUND';
    } else if (input.partnerCode !== expectedPartner || input.partnerCode !== attempt.merchant_id) {
      status = 'NEEDS_REVIEW';
      reason = 'MERCHANT_MISMATCH';
    } else if (input.requestId !== attempt.client_request_id) {
      status = 'NEEDS_REVIEW';
      reason = 'REQUEST_MISMATCH';
    } else if (input.amount.toString() !== attempt.amount) {
      status = 'NEEDS_REVIEW';
      reason = 'AMOUNT_MISMATCH';
    } else if (input.orderInfo !== `Wolfari contribution ${attempt.contribution_id}`) {
      status = 'NEEDS_REVIEW';
      reason = 'ORDER_INFO_MISMATCH';
    } else if (classifyMomoResult(input.resultCode) === 'PENDING') {
      status = 'NEEDS_REVIEW';
      reason = 'AUTHORIZED_OR_PENDING';
    }
    return this.db.withTransaction(async (client) => {
      const row = (
        await client.query<PaymentExceptionRow & { signature_valid: boolean }>(
          `INSERT INTO payment_webhook_receipts(provider,environment,dedupe_key,payment_attempt_id,
           signature_valid,received_amount,payload,processing_status,review_reason)
           VALUES('MOMO_SANDBOX','SANDBOX',$1,$2,$3,$4,$5::jsonb,$6,$7)
           ON CONFLICT(provider,environment,dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key
           RETURNING id,payment_attempt_id,processing_status,review_reason,received_at,reviewed_at,signature_valid`,
          [
            webhookDedupe(input),
            attempt?.id ?? null,
            signatureValid,
            input.amount.toString(),
            JSON.stringify(webhookPayload(input)),
            status,
            reason,
          ],
        )
      ).rows[0]!;
      if (attempt && signatureValid && status === 'NEEDS_REVIEW')
        await client.query(
          'UPDATE payment_attempts SET needs_reconciliation=true,updated_at=clock_timestamp() WHERE id=$1',
          [attempt.id],
        );
      return row;
    });
  }

  async dispatchCandidates() {
    return (
      await this.db.query<{ id: string }>(
        `SELECT id FROM payment_attempts WHERE provider='MOMO_SANDBOX' AND environment='SANDBOX'
         AND status='CREATED' ORDER BY created_at,id LIMIT 20`,
      )
    ).rows.map((row) => row.id);
  }
  async markStaleDispatches() {
    await this.db.query(
      `UPDATE payment_attempts SET needs_reconciliation=true,error_code='MOMO_CREATE_UNCERTAIN',
       provider_payload=provider_payload||'{"phase":"QUERY_REQUIRED"}'::jsonb,updated_at=clock_timestamp()
       WHERE status='PENDING' AND NOT needs_reconciliation
       AND provider_payload->>'phase'='CREATE_DISPATCH' AND updated_at<clock_timestamp()-interval '45 seconds'`,
    );
    await this.db.query(
      `UPDATE payment_attempts SET needs_reconciliation=true,error_code='MOMO_IPN_TIMEOUT',
       provider_payload=provider_payload||'{"phase":"QUERY_REQUIRED"}'::jsonb,updated_at=clock_timestamp()
       WHERE status='PENDING' AND NOT needs_reconciliation AND expires_at<=clock_timestamp()`,
    );
  }
  async claimDispatch(id: string) {
    return this.db.withTransaction(async (client) => {
      const row = await this.lockedAttempt(client, id);
      if (!row || row.status !== 'CREATED') return undefined;
      await client.query(
        `UPDATE payment_attempts SET status='PENDING',provider_payload=provider_payload||$2::jsonb,
         updated_at=clock_timestamp() WHERE id=$1`,
        [
          id,
          JSON.stringify({
            phase: 'CREATE_DISPATCH',
            dispatch_started_at: new Date().toISOString(),
          }),
        ],
      );
      return {
        id: row.id,
        amount: BigInt(row.amount),
        orderId: row.provider_order_id,
        requestId: row.client_request_id,
        orderInfo: `Wolfari contribution ${row.contribution_id}`,
      };
    });
  }
  async completeDispatch(id: string, result: MomoCreateResult) {
    const state = classifyMomoResult(result.resultCode);
    await this.db.query(
      `UPDATE payment_attempts SET status=$2::varchar,
       needs_reconciliation=$3,error_code=$4,expires_at=CASE WHEN $2::varchar='PENDING' THEN clock_timestamp()+interval '15 minutes' ELSE expires_at END,
       provider_payload=provider_payload||$5::jsonb,updated_at=clock_timestamp()
       WHERE id=$1 AND status='PENDING'`,
      [
        id,
        state === 'FAILED' ? 'FAILED' : 'PENDING',
        state === 'PENDING' && result.resultCode !== 0,
        result.resultCode === 0 ? null : `MOMO_${result.resultCode}`,
        JSON.stringify({
          phase:
            result.resultCode === 0
              ? 'AWAITING_IPN'
              : state === 'PENDING'
                ? 'QUERY_REQUIRED'
                : 'CREATE_FAILED',
          result_code: result.resultCode,
          response_time: result.responseTime,
          ...(result.paymentUrl ? { payment_url: result.paymentUrl } : {}),
        }),
      ],
    );
  }
  async failDispatch(id: string) {
    await this.db.query(
      `UPDATE payment_attempts SET status='PENDING',needs_reconciliation=true,
       error_code='MOMO_CREATE_UNCERTAIN',provider_payload=provider_payload||'{"phase":"QUERY_REQUIRED"}'::jsonb,
       updated_at=clock_timestamp() WHERE id=$1 AND status='PENDING'`,
      [id],
    );
  }
  async reconciliationCandidates() {
    return (
      await this.db.query<{ id: string }>(
        `SELECT id FROM payment_attempts WHERE provider='MOMO_SANDBOX' AND environment='SANDBOX'
         AND needs_reconciliation AND status<>'SUCCEEDED'
         AND updated_at<=clock_timestamp()-interval '30 seconds'
         ORDER BY updated_at,id LIMIT 20`,
      )
    ).rows.map((row) => row.id);
  }
  async reconciliationCommand(id: string) {
    const row = await this.attemptScope(id);
    return row
      ? {
          id: row.id,
          orderId: row.provider_order_id,
          requestId: randomUUID(),
          amount: BigInt(row.amount),
        }
      : undefined;
  }
  async completeQuery(id: string, result: MomoQueryResult) {
    const row = await this.attemptScope(id);
    if (!row) return;
    if (
      result.orderId !== row.provider_order_id ||
      (result.amount !== undefined && result.amount !== BigInt(row.amount))
    ) {
      await this.queryException(row, result, 'QUERY_MISMATCH');
      return;
    }
    const state = classifyMomoResult(result.resultCode);
    if (state === 'SUCCEEDED') {
      if (!result.transactionId) {
        await this.queryException(row, result, 'QUERY_TRANSACTION_MISSING');
        return;
      }
      await this.db.withTransaction(async (client) => {
        const settled = await this.settleSuccess(client, row.id, {
          transactionId: result.transactionId!,
          correlation: randomUUID(),
          actor: null,
          system: 'MOMO_RECONCILIATION',
        });
        if (!settled)
          await this.insertQueryException(client, row, result, 'QUERY_SUCCESS_CONFLICT');
      });
      return;
    }
    await this.db.query(
      `UPDATE payment_attempts SET status=$2,needs_reconciliation=$3,reconciled_at=clock_timestamp(),
       error_code=$4,provider_payload=provider_payload||$5::jsonb,updated_at=clock_timestamp() WHERE id=$1`,
      [
        id,
        state,
        state === 'PENDING',
        `MOMO_${result.resultCode}`,
        JSON.stringify({
          query_result_code: result.resultCode,
          query_response_time: result.responseTime,
        }),
      ],
    );
  }
  async failQuery(id: string) {
    await this.db.query(
      `UPDATE payment_attempts SET needs_reconciliation=true,error_code='MOMO_QUERY_UNAVAILABLE',
       updated_at=clock_timestamp() WHERE id=$1 AND status<>'SUCCEEDED'`,
      [id],
    );
  }
  private async queryException(row: AttemptScope, result: MomoQueryResult, reason: string) {
    await this.db.withTransaction((client) =>
      this.insertQueryException(client, row, result, reason),
    );
  }
  private async insertQueryException(
    client: Client,
    row: AttemptScope,
    result: MomoQueryResult,
    reason: string,
  ) {
    const payload = {
      source: 'QUERY',
      partner_code: row.merchant_id,
      order_id: result.orderId,
      request_id: row.client_request_id,
      amount: result.amount?.toString(),
      transaction_id: result.transactionId,
      result_code: result.resultCode,
      message: result.message,
      response_time: result.responseTime,
    };
    const key = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await client.query(
      `INSERT INTO payment_webhook_receipts(provider,environment,dedupe_key,payment_attempt_id,
       signature_valid,received_amount,payload,processing_status,review_reason)
       VALUES('MOMO_SANDBOX','SANDBOX',$1,$2,true,$3,$4::jsonb,'NEEDS_REVIEW',$5)
       ON CONFLICT(provider,environment,dedupe_key) DO NOTHING`,
      [key, row.id, result.amount?.toString() ?? null, JSON.stringify(payload), reason],
    );
    await client.query(
      'UPDATE payment_attempts SET needs_reconciliation=true,error_code=$2,updated_at=clock_timestamp() WHERE id=$1',
      [row.id, reason],
    );
  }

  async webhookCandidates() {
    return (
      await this.db.query<{ id: string }>(
        `SELECT id FROM payment_webhook_receipts WHERE provider='MOMO_SANDBOX'
         AND environment='SANDBOX' AND processing_status='RECEIVED' ORDER BY received_at,id LIMIT 20`,
      )
    ).rows.map((row) => row.id);
  }
  async processWebhook(id: string) {
    return this.db.withTransaction(async (client) => {
      const receipt = (
        await client.query<PaymentExceptionRow & { payload: unknown; signature_valid: boolean }>(
          `SELECT id,payment_attempt_id,processing_status,review_reason,received_at,reviewed_at,
           payload,signature_valid FROM payment_webhook_receipts WHERE id=$1 FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (!receipt || receipt.processing_status !== 'RECEIVED' || !receipt.payment_attempt_id)
        return;
      const payload = payloadRecord(receipt.payload);
      const code = Number(payload.result_code);
      if (!Number.isInteger(code)) throw new Error('Invalid stored MoMo payload');
      const state = classifyMomoResult(code);
      if (state === 'SUCCEEDED') {
        const settled = await this.settleSuccess(client, receipt.payment_attempt_id, {
          transactionId: String(payload.transaction_id),
          receiptId: receipt.id,
          correlation: receipt.id,
          actor: null,
          system: 'MOMO_IPN',
        });
        if (!settled)
          await client.query(
            `UPDATE payment_webhook_receipts SET processing_status='NEEDS_REVIEW',
             review_reason='LATE_OR_CONFLICTING_SUCCESS' WHERE id=$1`,
            [receipt.id],
          );
      } else if (state === 'FAILED') {
        await client.query(
          `UPDATE payment_attempts SET status='FAILED',needs_reconciliation=false,reconciled_at=clock_timestamp(),
           error_code=$2,updated_at=clock_timestamp() WHERE id=$1 AND status<>'SUCCEEDED'`,
          [receipt.payment_attempt_id, `MOMO_${code}`],
        );
        await client.query(
          `UPDATE payment_webhook_receipts SET processing_status='PROCESSED',processed_at=clock_timestamp()
           WHERE id=$1`,
          [receipt.id],
        );
      } else {
        await client.query(
          `UPDATE payment_webhook_receipts SET processing_status='NEEDS_REVIEW',
           review_reason='AUTHORIZED_OR_PENDING' WHERE id=$1`,
          [receipt.id],
        );
        await client.query(
          'UPDATE payment_attempts SET needs_reconciliation=true,updated_at=clock_timestamp() WHERE id=$1',
          [receipt.payment_attempt_id],
        );
      }
    });
  }

  private async settleSuccess(
    client: Client,
    attemptId: string,
    source: {
      transactionId: string;
      receiptId?: string;
      correlation: string;
      actor: string | null;
      system: string | null;
    },
  ) {
    if (!/^\d{1,40}$/.test(source.transactionId)) return false;
    const row = await this.lockedAttempt(client, attemptId);
    if (!row) return false;
    const duplicate = (
      await client.query<{ id: string }>(
        `SELECT id FROM payment_attempts WHERE provider=$1 AND environment=$2
         AND provider_transaction_id=$3 AND id<>$4 FOR UPDATE`,
        [row.provider, row.environment, source.transactionId, row.id],
      )
    ).rows[0];
    const original = await client.query(
      "SELECT id FROM fund_transactions WHERE contribution_id=$1 AND transaction_type='CONTRIBUTION'",
      [row.contribution_id],
    );
    if (
      duplicate ||
      row.finance_version >= MAX_INT32 ||
      row.contribution_version >= MAX_INT32 ||
      row.request_status !== 'OPEN' ||
      row.contribution_status !== 'PENDING' ||
      (await this.fundStatus(client, row.fund_id)) !== 'OPEN' ||
      original.rowCount
    ) {
      await client.query(
        `UPDATE payment_attempts SET needs_reconciliation=true,error_code='PAYMENT_SUCCESS_CONFLICT',
         updated_at=clock_timestamp() WHERE id=$1`,
        [row.id],
      );
      return false;
    }
    const balance = BigInt(row.current_balance) + BigInt(row.amount);
    if (balance > MAX_INT64) return false;
    const sequence =
      BigInt(
        (
          await client.query<{ sequence: string }>(
            'SELECT COALESCE(MAX(sequence),0)::text AS sequence FROM fund_transactions WHERE fund_id=$1',
            [row.fund_id],
          )
        ).rows[0]!.sequence,
      ) + 1n;
    if (sequence > MAX_INT64) return false;
    await client.query(
      `INSERT INTO fund_transactions(fund_id,sequence,direction,transaction_type,amount,balance_after,
       contribution_id,actor_user_id,business_key)
       VALUES($1,$2,'IN','CONTRIBUTION',$3,$4,$5,$6,$7)`,
      [
        row.fund_id,
        sequence.toString(),
        row.amount,
        balance.toString(),
        row.contribution_id,
        source.actor,
        `contribution:${row.contribution_id}`,
      ],
    );
    await client.query(
      `UPDATE contributions SET status='CONFIRMED',confirmed_at=clock_timestamp(),
       confirmed_by_user_id=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1`,
      [row.contribution_id, source.actor],
    );
    await client.query(
      `UPDATE payment_attempts SET status='SUCCEEDED',provider_transaction_id=$2,
       needs_reconciliation=false,reconciled_at=clock_timestamp(),error_code=NULL,
       provider_payload=provider_payload||'{"phase":"SUCCEEDED"}'::jsonb,updated_at=clock_timestamp()
       WHERE id=$1`,
      [row.id, source.transactionId],
    );
    await client.query(
      `UPDATE funds SET current_balance=$2,finance_version=finance_version+1,
       updated_at=clock_timestamp() WHERE id=$1`,
      [row.fund_id, balance.toString()],
    );
    if (source.receiptId)
      await client.query(
        `UPDATE payment_webhook_receipts SET processing_status='PROCESSED',processed_at=clock_timestamp(),
         reviewed_at=CASE WHEN review_reason IS NULL THEN reviewed_at ELSE clock_timestamp() END
         WHERE id=$1`,
        [source.receiptId],
      );
    const financeVersion = row.finance_version + 1;
    await this.audit(client, {
      fundId: row.fund_id,
      actor: source.actor,
      system: source.system,
      action: 'CONFIRM_PROVIDER_PAYMENT',
      entity: 'Contribution',
      entityId: row.contribution_id,
      from: row.contribution_version,
      to: row.contribution_version + 1,
      correlation: source.correlation,
      details: { payment_attempt_id: row.id, finance_version: financeVersion },
    });
    await client.query(
      `INSERT INTO outbox_events(event_id,event_type,schema_version,aggregate_id,aggregate_version,
       correlation_id,payload,aggregate_type,producer,trip_id,actor_user_id,system_actor)
       VALUES($1,'ContributionUpdated',1,$2,$3,$4,$5::jsonb,'Fund','Finance',$6,$7,$8)`,
      [
        randomUUID(),
        row.fund_id,
        financeVersion,
        source.correlation,
        JSON.stringify({
          fund_id: row.fund_id,
          trip_id: row.trip_id,
          contribution_id: row.contribution_id,
          status: 'CONFIRMED',
          finance_version: financeVersion,
        }),
        row.trip_id,
        source.actor,
        source.system,
      ],
    );
    return true;
  }

  private async audit(
    client: Client,
    input: {
      fundId: string;
      actor: string | null;
      system: string | null;
      action: string;
      entity: string;
      entityId: string;
      from: number | null;
      to: number;
      correlation: string;
      details: Record<string, unknown>;
    },
  ) {
    await client.query(
      `INSERT INTO finance_audit_logs(fund_id,actor_user_id,system_actor,action,entity_type,
       entity_id,from_version,to_version,correlation_id,details)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [
        input.fundId,
        input.actor,
        input.system,
        input.action,
        input.entity,
        input.entityId,
        input.from,
        input.to,
        input.correlation,
        JSON.stringify(input.details),
      ],
    );
  }
}
