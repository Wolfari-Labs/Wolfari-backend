import { randomUUID } from 'node:crypto';
import type { DatabaseProvider } from '@wolfari/database';
import type { FundSetupContext } from '../domain/fund-setup';
import { calculateLedgerReversal, LedgerReversalNotAllowedError } from '../domain/ledger-reversal';
import { InsufficientAvailableBalanceError, type RefundForBalance } from '../domain/fund-balance';
import { assertContributionActionAllowed } from '../domain/contribution-permissions';
import type { ContributionReversalInput } from '../inputs/contribution-reversal.input';
import { FinanceReadError } from '../finance.errors';
import {
  contributionResponse,
  type ContributionReadRow,
} from '../projections/contribution-response';
import type { FundWrite, StoredResult } from './fund-command.repository';

export type ContributionReversalWrite = {
  scope: 'REVERSE_CONTRIBUTION';
  fundId: string;
  requestId: string;
  contributionId: string;
  body: ContributionReversalInput;
};

export const isContributionReversalWrite = (
  input: FundWrite,
): input is FundWrite & ContributionReversalWrite => input.scope === 'REVERSE_CONTRIBUTION';

const columns =
  'id,request_id,fund_id,member_user_id,amount::text,status,self_contribution,version,member_reported_at,confirmed_at,confirmed_by_user_id,waived_reason,cancelled_reason,rejected_reason';
type Client = Pick<DatabaseProvider, 'query'>;

export class ContributionReversalRepository {
  async execute(
    client: Client,
    input: FundWrite & ContributionReversalWrite,
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
    let contribution = (
      await client.query<ContributionReadRow>(
        `SELECT ${columns} FROM contributions WHERE id=$1 AND fund_id=$2 AND request_id=$3 FOR UPDATE`,
        [input.contributionId, input.fundId, input.requestId],
      )
    ).rows[0];
    if (!request || !contribution) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    assertContributionActionAllowed('REVERSE_CONTRIBUTION', {
      actorUserId: input.actor,
      memberUserId: contribution.member_user_id,
      holderUserId: fund.holder_user_id,
      activeMemberUserIds: authority.activeMemberUserIds,
    });
    if (
      fund.status !== 'OPEN' ||
      request.status !== 'OPEN' ||
      authority.tripArchived ||
      contribution.status !== 'CONFIRMED'
    )
      throw new FinanceReadError('STATE_CONFLICT');
    if (
      contribution.version !== input.body.expectedVersion ||
      fund.finance_version !== input.body.expectedFinanceVersion
    )
      throw new FinanceReadError('VERSION_CONFLICT');
    if (contribution.version === 2147483647 || fund.finance_version === 2147483647)
      throw new FinanceReadError('STATE_CONFLICT');

    const attempts = (
      await client.query<{ status: string; needs_reconciliation: boolean }>(
        'SELECT status,needs_reconciliation FROM payment_attempts WHERE contribution_id=$1 ORDER BY id FOR UPDATE',
        [contribution.id],
      )
    ).rows;
    if (
      attempts.some(
        (attempt) =>
          attempt.needs_reconciliation || ['CREATED', 'PENDING'].includes(attempt.status),
      ) ||
      attempts.filter((attempt) => attempt.status === 'SUCCEEDED').length > 1
    )
      throw new FinanceReadError('STATE_CONFLICT');

    const originals = (
      await client.query<{
        id: string;
        direction: string;
        amount: string;
        reversal_of_id: string | null;
      }>(
        `SELECT id,direction,amount::text,reversal_of_id FROM fund_transactions
         WHERE fund_id=$1 AND contribution_id=$2 ORDER BY id FOR UPDATE`,
        [input.fundId, contribution.id],
      )
    ).rows;
    if (originals.length !== 1) throw new FinanceReadError('SERVICE_UNAVAILABLE');
    const original = originals[0]!;
    const direction = original.direction.trimEnd();
    if (
      direction !== 'IN' ||
      BigInt(original.amount) !== BigInt(contribution.amount) ||
      original.reversal_of_id !== null
    )
      throw new FinanceReadError('SERVICE_UNAVAILABLE');
    const existing = await client.query(
      'SELECT id FROM fund_transactions WHERE reversal_of_id=$1 FOR UPDATE',
      [original.id],
    );
    const refunds = (
      await client.query<{ amount: string; status: RefundForBalance['status'] }>(
        'SELECT amount::text,status FROM fund_refunds WHERE fund_id=$1 ORDER BY id FOR UPDATE',
        [input.fundId],
      )
    ).rows.map((refund) => ({ amount: BigInt(refund.amount), status: refund.status }));
    let effect;
    try {
      effect = calculateLedgerReversal(
        {
          id: original.id,
          direction,
          amount: BigInt(original.amount),
          reversalOfId: original.reversal_of_id,
        },
        {
          currentBalance: BigInt(fund.current_balance),
          refunds,
          hasExistingReversal: Boolean(existing.rowCount),
        },
      );
    } catch (error) {
      if (
        error instanceof LedgerReversalNotAllowedError ||
        error instanceof InsufficientAvailableBalanceError ||
        error instanceof RangeError
      )
        throw new FinanceReadError('STATE_CONFLICT');
      throw error;
    }
    const last = (
      await client.query<{ sequence: string }>(
        'SELECT COALESCE(MAX(sequence),0)::text AS sequence FROM fund_transactions WHERE fund_id=$1',
        [input.fundId],
      )
    ).rows[0]!;
    const sequence = BigInt(last.sequence) + 1n;
    if (sequence > 9223372036854775807n) throw new FinanceReadError('STATE_CONFLICT');
    const reversalId = randomUUID();
    await client.query(
      `INSERT INTO fund_transactions(id,fund_id,sequence,direction,transaction_type,amount,balance_after,reversal_of_id,actor_user_id,reason,business_key)
       VALUES($1,$2,$3,'OUT','REVERSAL',$4,$5,$6,$7,$8,$9)`,
      [
        reversalId,
        input.fundId,
        sequence.toString(),
        effect.amount.toString(),
        effect.balanceAfter.toString(),
        effect.reversalOfId,
        input.actor,
        input.body.reason,
        `reversal:contribution:${contribution.id}`,
      ],
    );
    contribution = (
      await client.query<ContributionReadRow>(
        `UPDATE contributions SET status='REVERSED',version=version+1,updated_at=clock_timestamp()
         WHERE id=$1 RETURNING ${columns}`,
        [contribution.id],
      )
    ).rows[0]!;
    const financeVersion = fund.finance_version + 1;
    await client.query(
      'UPDATE funds SET current_balance=$2,finance_version=$3,updated_at=clock_timestamp() WHERE id=$1',
      [input.fundId, effect.balanceAfter.toString(), financeVersion],
    );
    await client.query(
      `INSERT INTO finance_audit_logs(fund_id,actor_user_id,action,entity_type,entity_id,from_version,to_version,correlation_id,details)
       VALUES($1,$2,'REVERSE_CONTRIBUTION','Contribution',$3,$4,$5,$6,$7::jsonb)`,
      [
        input.fundId,
        input.actor,
        contribution.id,
        contribution.version - 1,
        contribution.version,
        correlation,
        JSON.stringify({
          operation_id: input.operationId,
          finance_version: financeVersion,
          reason: input.body.reason,
          original_ledger_id: original.id,
          reversal_ledger_id: reversalId,
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
          contribution_id: contribution.id,
          status: 'REVERSED',
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
      contribution: contributionResponse(contribution, financeVersion),
    };
  }
}
