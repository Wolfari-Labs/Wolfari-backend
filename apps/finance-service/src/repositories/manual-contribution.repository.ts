import { randomUUID } from 'node:crypto';
import type { DatabaseProvider } from '@wolfari/database';
import type { FundSetupContext } from '../domain/fund-setup';
import {
  planManualContributionTransition,
  type ContributionStatus,
} from '../domain/contribution-transition';
import { assertContributionActionAllowed } from '../domain/contribution-permissions';
import type { ManualContributionInput } from '../inputs/manual-contribution.input';
import { FinanceReadError } from '../finance.errors';
import {
  contributionResponse,
  type ContributionReadRow,
} from '../projections/contribution-response';
import type { ReceiptRepository } from '../receipts/receipt.repository';
import type { FundWrite, StoredResult } from './fund-command.repository';

export type ManualWrite = {
  scope: 'REPORT_TRANSFER' | 'CONFIRM_RECEIVED' | 'REJECT_TRANSFER';
  fundId: string;
  requestId: string;
  contributionId: string;
  body: ManualContributionInput;
};
export const isManualWrite = (input: FundWrite): input is FundWrite & ManualWrite =>
  ['REPORT_TRANSFER', 'CONFIRM_RECEIVED', 'REJECT_TRANSFER'].includes(input.scope);

const columns =
  'id,request_id,fund_id,member_user_id,amount::text,status,self_contribution,version,member_reported_at,confirmed_at,confirmed_by_user_id,waived_reason,cancelled_reason,rejected_reason';
type Client = Pick<DatabaseProvider, 'query'>;
export class ManualContributionRepository {
  constructor(private readonly files: Pick<ReceiptRepository, 'bind'>) {}
  async execute(
    client: Client,
    input: FundWrite & ManualWrite,
    authority: FundSetupContext,
    correlation: string,
  ): Promise<StoredResult> {
    const fund = (
      await client.query<{
        holder_user_id: string;
        status: 'OPEN' | 'CLOSING' | 'CLOSED';
        finance_version: number;
        current_balance: string;
      }>(
        'SELECT holder_user_id,status,finance_version,current_balance::text FROM funds WHERE id=$1 AND trip_id=$2 FOR UPDATE',
        [input.fundId, input.tripId],
      )
    ).rows[0];
    if (!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const request = (
      await client.query<{ status: string }>(
        'SELECT status FROM contribution_requests WHERE id=$1 AND fund_id=$2 FOR UPDATE',
        [input.requestId, input.fundId],
      )
    ).rows[0];
    let row = (
      await client.query<
        ContributionReadRow & {
          status: ContributionStatus;
          transfer_evidence_object_key: string | null;
        }
      >(
        `SELECT ${columns},transfer_evidence_object_key FROM contributions WHERE id=$1 AND fund_id=$2 AND request_id=$3 FOR UPDATE`,
        [input.contributionId, input.fundId, input.requestId],
      )
    ).rows[0];
    if (!request || !row) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const permission = {
      actorUserId: input.actor,
      memberUserId: row.member_user_id,
      holderUserId: fund.holder_user_id,
      activeMemberUserIds: authority.activeMemberUserIds,
    };
    assertContributionActionAllowed(input.scope, permission);
    if (input.body.command.action !== input.scope) throw new FinanceReadError('VALIDATION_FAILED');
    if (request.status !== 'OPEN' || authority.tripArchived)
      throw new FinanceReadError('STATE_CONFLICT');
    const attempts = (
      await client.query<{ status: string; needs_reconciliation: boolean }>(
        'SELECT status,needs_reconciliation FROM payment_attempts WHERE contribution_id=$1 ORDER BY id FOR UPDATE',
        [row.id],
      )
    ).rows;
    if (
      attempts.some(
        (a) => a.needs_reconciliation || ['CREATED', 'PENDING', 'SUCCEEDED'].includes(a.status),
      )
    )
      throw new FinanceReadError('STATE_CONFLICT');
    const original = await client.query(
      "SELECT id FROM fund_transactions WHERE contribution_id=$1 AND transaction_type='CONTRIBUTION'",
      [row.id],
    );
    let effect;
    try {
      effect = planManualContributionTransition(input.body.command, {
        ...permission,
        status: row.status,
        amount: BigInt(row.amount),
        version: row.version,
        fundStatus: fund.status,
        financeVersion: fund.finance_version,
        currentBalance: BigInt(fund.current_balance),
        hasOriginalReceipt: Boolean(original.rowCount),
      });
    } catch (error) {
      if (error instanceof RangeError) throw new FinanceReadError('STATE_CONFLICT');
      throw error;
    }
    if (row.version === 2147483647 || fund.finance_version === 2147483647)
      throw new FinanceReadError('STATE_CONFLICT');
    const financeVersion = fund.finance_version + 1;
    const evidence = input.body.evidenceObjectKey;
    if (evidence !== undefined) {
      if (input.scope !== 'REPORT_TRANSFER') throw new FinanceReadError('VALIDATION_FAILED');
      await this.files.bind(
        client,
        input.fundId,
        evidence,
        input.actor,
        { contributionId: row.id },
        evidence === row.transfer_evidence_object_key,
      );
    }
    if (effect.ledgerEntry) {
      const last = (
        await client.query<{ sequence: string }>(
          'SELECT COALESCE(MAX(sequence),0)::text AS sequence FROM fund_transactions WHERE fund_id=$1',
          [input.fundId],
        )
      ).rows[0]!;
      const sequence = BigInt(last.sequence) + 1n;
      if (sequence > 9223372036854775807n) throw new FinanceReadError('STATE_CONFLICT');
      await client.query(
        `INSERT INTO fund_transactions(fund_id,sequence,direction,transaction_type,amount,balance_after,contribution_id,actor_user_id,business_key)
        VALUES($1,$2,'IN','CONTRIBUTION',$3,$4,$5,$6,$7)`,
        [
          input.fundId,
          sequence.toString(),
          effect.ledgerEntry.amount.toString(),
          effect.ledgerEntry.balanceAfter.toString(),
          row.id,
          input.actor,
          `contribution:${row.id}`,
        ],
      );
    }
    row = (
      await client.query<typeof row>(
        `UPDATE contributions SET status=$2,self_contribution=$3,
      member_reported_at=CASE WHEN $4='REPORT_TRANSFER' THEN clock_timestamp() ELSE member_reported_at END,
      confirmed_at=CASE WHEN $4='CONFIRM_RECEIVED' THEN clock_timestamp() ELSE confirmed_at END,
      confirmed_by_user_id=CASE WHEN $4='CONFIRM_RECEIVED' THEN $5::uuid ELSE confirmed_by_user_id END,
      rejected_reason=CASE WHEN $4='REJECT_TRANSFER' THEN $6 ELSE rejected_reason END,
      transfer_evidence_object_key=COALESCE($7,transfer_evidence_object_key),version=version+1,updated_at=clock_timestamp()
      WHERE id=$1 RETURNING ${columns},transfer_evidence_object_key`,
        [
          row.id,
          effect.nextStatus,
          effect.selfContribution,
          input.scope,
          input.actor,
          effect.rejectionReason,
          evidence ?? null,
        ],
      )
    ).rows[0]!;
    await client.query(
      'UPDATE funds SET current_balance=$2,finance_version=$3,updated_at=clock_timestamp() WHERE id=$1',
      [
        input.fundId,
        effect.ledgerEntry?.balanceAfter.toString() ?? fund.current_balance,
        financeVersion,
      ],
    );
    await client.query(
      `INSERT INTO finance_audit_logs(fund_id,actor_user_id,action,entity_type,entity_id,from_version,to_version,correlation_id,details)
      VALUES($1,$2,$3,'Contribution',$4,$5,$6,$7,$8::jsonb)`,
      [
        input.fundId,
        input.actor,
        input.scope,
        row.id,
        row.version - 1,
        row.version,
        correlation,
        JSON.stringify({
          operation_id: input.operationId,
          finance_version: financeVersion,
          ...(effect.rejectionReason === null ? {} : { reason: effect.rejectionReason }),
        }),
      ],
    );
    await client.query(
      `INSERT INTO outbox_events(event_id,event_type,schema_version,aggregate_id,aggregate_version,correlation_id,payload,aggregate_type,producer,operation_id,trip_id,actor_user_id)
      VALUES($1,'ContributionUpdated',1,$2,$3,$4,$5::jsonb,'Fund','Finance',$6,$7,$8)`,
      [
        randomUUID(),
        input.fundId,
        financeVersion,
        correlation,
        JSON.stringify({
          fund_id: input.fundId,
          trip_id: input.tripId,
          contribution_id: row.id,
          status: row.status,
          finance_version: financeVersion,
        }),
        input.operationId,
        input.tripId,
        input.actor,
      ],
    );
    return {
      version: 1,
      tripId: input.tripId,
      contribution: contributionResponse(row, financeVersion),
    };
  }
}
