import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseProvider } from '@wolfari/database';
import type { FinanceV1 } from '@wolfari/contracts/grpc';
import { FinanceReadError } from '../finance.errors';
import type { FundSetupContext } from '../domain/fund-setup';
import {
  assertCreateHandover,
  planHandoverAction,
  handoverScopes,
  type HandoverScope,
} from '../domain/handover-management';
import type { HandoverCreate, HandoverAction } from '../inputs/handover.input';
import { handoverResponse, type HandoverRow } from '../projections/handover-response';
import type { FundWrite, StoredResult } from './fund-command.repository';

export type HandoverWriteCommand =
  | { scope: 'CREATE_HOLDER_HANDOVER'; fundId: string; body: HandoverCreate }
  | {
      scope: Exclude<HandoverScope, 'CREATE_HOLDER_HANDOVER'>;
      fundId: string;
      handoverId: string;
      body: HandoverAction;
    };
export const isHandoverWrite = (input: FundWrite): input is FundWrite & HandoverWriteCommand =>
  (handoverScopes as readonly string[]).includes(input.scope);
type Client = Pick<DatabaseProvider, 'query'>;

/** Caller owns the Fund row lock for every write and snapshot capture. */
export async function captureHandoverSnapshot(
  client: Client,
  fundId: string,
): Promise<FinanceV1.HolderHandoverSnapshot> {
  const row = (
    await client.query<{ snapshot: FinanceV1.HolderHandoverSnapshot; fingerprint_source: unknown }>(
      `SELECT jsonb_build_object(
      'current_balance', f.current_balance::text,
      'reserved_refund', COALESCE((SELECT sum(amount) FROM fund_refunds WHERE fund_id=f.id AND status IN ('PENDING','HOLDER_REPORTED')),0)::text,
      'available_balance', (f.current_balance-COALESCE((SELECT sum(amount) FROM fund_refunds WHERE fund_id=f.id AND status IN ('PENDING','HOLDER_REPORTED')),0))::text,
      'ledger_sequence', COALESCE((SELECT max(sequence) FROM fund_transactions WHERE fund_id=f.id),0)::text,
      'pending_contribution_ids', COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM contributions WHERE fund_id=f.id AND status IN ('PENDING','TRANSFER_REPORTED')),'[]'::jsonb),
      'pending_refund_ids', COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM fund_refunds WHERE fund_id=f.id AND (status IN ('PENDING','HOLDER_REPORTED') OR (status='CONFIRMED' AND reversal_requested_at IS NOT NULL))),'[]'::jsonb),
      'pending_expense_ids', COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM fund_expenses WHERE fund_id=f.id AND deleted_at IS NULL AND status IN ('DRAFT','SUBMITTED')),'[]'::jsonb),
      'pending_payment_ids', COALESCE((SELECT jsonb_agg(p.id ORDER BY p.id) FROM payment_attempts p JOIN contributions c ON c.id=p.contribution_id WHERE c.fund_id=f.id AND (p.status IN ('CREATED','PENDING') OR p.needs_reconciliation)),'[]'::jsonb),
      'payment_destination_ids', COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM payment_destinations WHERE fund_id=f.id AND active),'[]'::jsonb),
      'pending_payment_exception_ids', COALESCE((SELECT jsonb_agg(w.id ORDER BY w.id) FROM payment_webhook_receipts w JOIN payment_attempts p ON p.id=w.payment_attempt_id JOIN contributions c ON c.id=p.contribution_id WHERE c.fund_id=f.id AND w.signature_valid AND w.processing_status IN ('RECEIVED','NEEDS_REVIEW')),'[]'::jsonb)
    ) AS snapshot,
    jsonb_build_object(
      'contributions',COALESCE((SELECT jsonb_agg(jsonb_build_array(id,status,amount,version,updated_at) ORDER BY id) FROM contributions WHERE fund_id=f.id),'[]'::jsonb),
      'refunds',COALESCE((SELECT jsonb_agg(jsonb_build_array(id,status,amount,version,updated_at) ORDER BY id) FROM fund_refunds WHERE fund_id=f.id),'[]'::jsonb),
      'expenses',COALESCE((SELECT jsonb_agg(jsonb_build_array(id,status,amount,version,updated_at) ORDER BY id) FROM fund_expenses WHERE fund_id=f.id),'[]'::jsonb),
      'attempts',COALESCE((SELECT jsonb_agg(jsonb_build_array(p.id,p.status,p.amount,p.needs_reconciliation,p.error_code,p.provider_transaction_id,p.provider_payload->>'phase') ORDER BY p.id) FROM payment_attempts p JOIN contributions c ON c.id=p.contribution_id WHERE c.fund_id=f.id),'[]'::jsonb),
      'destinations',COALESCE((SELECT jsonb_agg(jsonb_build_array(id,active,is_default,version,updated_at) ORDER BY id) FROM payment_destinations WHERE fund_id=f.id),'[]'::jsonb),
      'receipts',COALESCE((SELECT jsonb_agg(jsonb_build_array(w.id,w.processing_status,w.received_amount,w.reviewed_at,w.processed_at) ORDER BY w.id) FROM payment_webhook_receipts w JOIN payment_attempts p ON p.id=w.payment_attempt_id JOIN contributions c ON c.id=p.contribution_id WHERE c.fund_id=f.id AND w.signature_valid),'[]'::jsonb)
    ) AS fingerprint_source FROM funds f WHERE f.id=$1`,
      [fundId],
    )
  ).rows[0];
  if (!row) throw new FinanceReadError('RESOURCE_NOT_FOUND');
  return {
    ...row.snapshot,
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ snapshot: row.snapshot, source: row.fingerprint_source }))
      .digest('hex'),
  };
}

@Injectable()
export class HandoverRepository {
  constructor(@Inject(DatabaseProvider) private readonly db: Client) {}
  async find(id: string): Promise<{ row: HandoverRow; financeVersion: number } | undefined> {
    const result = (
      await this.db.query<{ row: HandoverRow; finance_version: number }>(
        `SELECT to_jsonb(h) AS row,f.finance_version FROM fund_holder_handovers h JOIN funds f ON f.id=h.fund_id WHERE h.id=$1`,
        [id],
      )
    ).rows[0];
    if (result?.row.status === 'ACCEPTED')
      result.row.snapshot_stale_override =
        (await captureHandoverSnapshot(this.db, result.row.fund_id)).fingerprint !==
        result.row.snapshot?.fingerprint;
    return result && { row: result.row, financeVersion: result.finance_version };
  }
  async list(fundId: string) {
    const rows = (
      await this.db.query<{ row: HandoverRow; finance_version: number }>(
        `SELECT to_jsonb(h) AS row,f.finance_version FROM fund_holder_handovers h JOIN funds f ON f.id=h.fund_id WHERE h.fund_id=$1 ORDER BY h.created_at DESC,h.id DESC LIMIT 100`,
        [fundId],
      )
    ).rows;
    for (const item of rows)
      if (item.row.status === 'ACCEPTED')
        item.row.snapshot_stale_override =
          (await captureHandoverSnapshot(this.db, fundId)).fingerprint !==
          item.row.snapshot?.fingerprint;
    return rows.map((x) => handoverResponse(x.row, x.finance_version));
  }
  async execute(
    client: Client,
    input: FundWrite & HandoverWriteCommand,
    authority: FundSetupContext,
    correlation: string,
  ): Promise<StoredResult> {
    const fund = (
      await client.query<{ holder_user_id: string; status: string; finance_version: number }>(
        'SELECT holder_user_id,status,finance_version FROM funds WHERE id=$1 AND trip_id=$2 FOR UPDATE',
        [input.fundId, input.tripId],
      )
    ).rows[0];
    if (!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const context = {
      ...authority,
      holderUserId: fund.holder_user_id,
      fundStatus: fund.status,
      financeVersion: fund.finance_version,
    };
    let row: HandoverRow;
    let fromVersion: number | null = null;
    let financeVersion = fund.finance_version;
    if (input.scope === 'CREATE_HOLDER_HANDOVER') {
      assertCreateHandover(input.body, context);
      const existing = await client.query(
        `SELECT id FROM fund_holder_handovers WHERE fund_id=$1 AND status IN ('NOMINATED','ACCEPTED')`,
        [input.fundId],
      );
      if (existing.rowCount) throw new FinanceReadError('STATE_CONFLICT');
      row = (
        await client.query<HandoverRow>(
          `INSERT INTO fund_holder_handovers(fund_id,old_holder_user_id,new_holder_user_id,nominated_by_user_id) VALUES($1,$2,$3,$4) RETURNING *`,
          [input.fundId, fund.holder_user_id, input.body.newHolderUserId, input.actor],
        )
      ).rows[0]!;
    } else {
      row = (
        await client.query<HandoverRow>(
          'SELECT * FROM fund_holder_handovers WHERE id=$1 AND fund_id=$2 FOR UPDATE',
          [input.handoverId, input.fundId],
        )
      ).rows[0]!;
      if (!row) throw new FinanceReadError('RESOURCE_NOT_FOUND');
      fromVersion = row.version;
      const plan = planHandoverAction(
        input.scope,
        input.body,
        {
          status: row.status,
          version: row.version,
          oldHolderUserId: row.old_holder_user_id,
          newHolderUserId: row.new_holder_user_id,
          snapshotFinanceVersion: row.snapshot_finance_version,
          oldConfirmed: row.old_holder_confirmed_at !== null,
          newConfirmed: row.new_holder_confirmed_at !== null,
        },
        context,
      );
      if (input.scope === 'ACCEPT_HOLDER_HANDOVER' || input.scope === 'REFRESH_HOLDER_HANDOVER') {
        const snapshot = await captureHandoverSnapshot(client, input.fundId);
        row = (
          await client.query<HandoverRow>(
            `UPDATE fund_holder_handovers SET status='ACCEPTED',accepted_at=COALESCE(accepted_at,clock_timestamp()),snapshot_finance_version=$2,snapshot=$3::jsonb,old_holder_confirmed_at=NULL,new_holder_confirmed_at=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
            [row.id, financeVersion, JSON.stringify(snapshot)],
          )
        ).rows[0]!;
      } else if (input.scope === 'CANCEL_HOLDER_HANDOVER') {
        row = (
          await client.query<HandoverRow>(
            `UPDATE fund_holder_handovers SET status='CANCELLED',cancelled_at=clock_timestamp(),cancellation_reason=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
            [row.id, input.body.reason],
          )
        ).rows[0]!;
      } else {
        const snapshot = await captureHandoverSnapshot(client, input.fundId);
        // Guard also against unversioned provider-attempt state transitions.
        if (snapshot.fingerprint !== row.snapshot?.fingerprint)
          throw new FinanceReadError('VERSION_CONFLICT');
        const old = input.actor === row.old_holder_user_id;
        row = (
          await client.query<HandoverRow>(
            `UPDATE fund_holder_handovers SET
          old_holder_confirmed_at=CASE WHEN $2 THEN clock_timestamp() ELSE old_holder_confirmed_at END,
          new_holder_confirmed_at=CASE WHEN $2 THEN new_holder_confirmed_at ELSE clock_timestamp() END,
          status=CASE WHEN $3 THEN 'COMPLETED' ELSE status END,
          completed_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,
          version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
            [row.id, old, plan.complete],
          )
        ).rows[0]!;
        if (plan.complete) {
          financeVersion += 1;
          await client.query(
            'UPDATE funds SET holder_user_id=$2,finance_version=$3,updated_at=clock_timestamp() WHERE id=$1',
            [input.fundId, row.new_holder_user_id, financeVersion],
          );
          // Existing contribution/attempt snapshots remain immutable for late-money reconciliation.
          await client.query(
            `UPDATE payment_destinations SET active=false,is_default=false,confirmed_by_holder_at=NULL,version=version+1,updated_at=clock_timestamp() WHERE fund_id=$1`,
            [input.fundId],
          );
        }
      }
    }
    await client.query(
      `INSERT INTO finance_audit_logs(fund_id,actor_user_id,action,entity_type,entity_id,from_version,to_version,correlation_id,details) VALUES($1,$2,$3,'HolderHandover',$4,$5,$6,$7,$8::jsonb)`,
      [
        input.fundId,
        input.actor,
        input.scope,
        row.id,
        fromVersion,
        row.version,
        correlation,
        JSON.stringify({
          operation_id: input.operationId,
          finance_version: financeVersion,
          snapshot_finance_version: row.snapshot_finance_version,
          old_holder_user_id: row.old_holder_user_id,
          new_holder_user_id: row.new_holder_user_id,
          reason: input.scope === 'CANCEL_HOLDER_HANDOVER' ? input.body.reason : undefined,
        }),
      ],
    );
    return { version: 1, tripId: input.tripId, handover: handoverResponse(row, financeVersion) };
  }
}
