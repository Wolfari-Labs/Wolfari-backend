import { randomUUID } from 'node:crypto';
import type { DatabaseProvider } from '@wolfari/database';
import type { FundSetupContext } from '../domain/fund-setup';
import { planContributionManagement } from '../domain/contribution-management';
import type {
  ContributionManagementCommand,
  ContributionManagementScope,
} from '../inputs/contribution-management.input';
import { FinanceReadError } from '../finance.errors';
import {
  contributionResponse,
  contributionRequestReadResponse,
  type ContributionReadRow,
  type ContributionRequestReadRow,
} from '../projections/contribution-response';
import type { FundWrite, StoredResult } from './fund-command.repository';

export type ManagementWrite = {
  scope: ContributionManagementScope;
  fundId: string;
  requestId: string;
  contributionId?: string;
  body: ContributionManagementCommand;
};
const columns =
  'id,request_id,fund_id,member_user_id,amount::text,status,self_contribution,version,member_reported_at,confirmed_at,confirmed_by_user_id,waived_reason,cancelled_reason';
type Client = Pick<DatabaseProvider, 'query'>;
/** All payment writers must acquire the same Fund lock before inspecting/changing children. */
export class ContributionManagementRepository {
  async execute(
    client: Client,
    input: FundWrite & ManagementWrite,
    authority: FundSetupContext,
    correlation: string,
  ): Promise<StoredResult> {
    const fund = (
      await client.query<{ status: string; finance_version: number }>(
        'SELECT status,finance_version FROM funds WHERE id=$1 AND trip_id=$2 FOR UPDATE',
        [input.fundId, input.tripId],
      )
    ).rows[0];
    if (!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    let request = (
      await client.query<ContributionRequestReadRow>(
        'SELECT id,fund_id,title,created_by_user_id,created_at,due_at,note,closed_at,amount_per_member::text,status,version FROM contribution_requests WHERE id=$1 AND fund_id=$2 FOR UPDATE',
        [input.requestId, input.fundId],
      )
    ).rows[0];
    if (!request) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const requestEdit = input.scope === 'UPDATE_CONTRIBUTION_REQUEST';
    if (!requestEdit && !input.contributionId) throw new FinanceReadError('VALIDATION_FAILED');
    let rows = (
      await client.query<ContributionReadRow>(
        `SELECT ${columns} FROM contributions WHERE fund_id=$1 AND request_id=$2 AND ($3::uuid IS NULL OR id=$3) ORDER BY id FOR UPDATE`,
        [input.fundId, input.requestId, requestEdit ? null : input.contributionId],
      )
    ).rows;
    const target = rows[0];
    if (!requestEdit && !target) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const ids = rows.map((row) => row.id);
    const attempts = (
      await client.query<{ status: string; needs_reconciliation: boolean }>(
        'SELECT status,needs_reconciliation FROM payment_attempts WHERE contribution_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [ids],
      )
    ).rows;
    const ledger = await client.query(
      "SELECT id FROM fund_transactions WHERE contribution_id=ANY($1::uuid[]) AND transaction_type='CONTRIBUTION' LIMIT 1",
      [ids],
    );
    const plan = planContributionManagement(input.scope, input.body, {
      owner:
        authority.actorUserId === authority.ownerUserId &&
        authority.activeMemberUserIds.has(authority.actorUserId),
      fundOpen: fund.status === 'OPEN' && !authority.tripArchived,
      requestOpen: request.status === 'OPEN',
      version: requestEdit ? request.version : target!.version,
      financeVersion: fund.finance_version,
      title: request.title,
      note: request.note,
      dueAt: request.due_at === null ? null : new Date(request.due_at),
      amount: target?.amount,
      pending: target?.status === 'PENDING',
      memberActive: Boolean(target && authority.activeMemberUserIds.has(target.member_user_id)),
      allPending: rows.every((row) => row.status === 'PENDING'),
      blockedPayment:
        Boolean(ledger.rowCount) ||
        attempts.some(
          (a) => a.needs_reconciliation || ['CREATED', 'PENDING', 'SUCCEEDED'].includes(a.status),
        ),
    });
    if (plan.changed) {
      if (requestEdit) {
        request = (
          await client.query<ContributionRequestReadRow>(
            `UPDATE contribution_requests SET title=COALESCE($3,title),
            due_at=CASE WHEN $4::boolean THEN $5::timestamptz ELSE due_at END,
            note=COALESCE($6,note),version=version+1 WHERE id=$1 AND fund_id=$2
            RETURNING id,fund_id,title,created_by_user_id,created_at,due_at,note,closed_at,amount_per_member::text,status,version`,
            [
              input.requestId,
              input.fundId,
              input.body.title ?? null,
              input.body.dueAt !== undefined &&
                input.body.dueAt.getTime() !==
                  (request.due_at === null ? undefined : new Date(request.due_at).getTime()),
              input.body.dueAt ?? null,
              input.body.note ?? null,
            ],
          )
        ).rows[0]!;
      } else {
        // History and destination snapshots are deliberately absent from the SET clause.
        const assignment =
          input.scope === 'UPDATE_CONTRIBUTION_AMOUNT'
            ? 'amount=$3::bigint'
            : input.scope === 'WAIVE_CONTRIBUTION'
              ? "status='WAIVED',waived_reason=$3,waived_at=clock_timestamp()"
              : "status='CANCELLED',cancelled_reason=$3,cancelled_at=clock_timestamp()";
        rows = (
          await client.query<ContributionReadRow>(
            `UPDATE contributions SET ${assignment},version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND fund_id=$2 RETURNING ${columns}`,
            [
              input.contributionId,
              input.fundId,
              input.scope === 'UPDATE_CONTRIBUTION_AMOUNT'
                ? input.body.amount!.toString()
                : input.body.reason,
            ],
          )
        ).rows;
      }
      await client.query(
        'UPDATE funds SET finance_version=$2,updated_at=clock_timestamp() WHERE id=$1',
        [input.fundId, plan.financeVersion],
      );
      await client.query(
        `INSERT INTO finance_audit_logs(fund_id,actor_user_id,action,entity_type,entity_id,from_version,to_version,correlation_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          input.fundId,
          input.actor,
          input.scope,
          requestEdit ? 'ContributionRequest' : 'Contribution',
          requestEdit ? input.requestId : input.contributionId,
          plan.version - 1,
          plan.version,
          correlation,
          JSON.stringify({ operation_id: input.operationId, finance_version: plan.financeVersion }),
        ],
      );
      for (const row of rows.filter(
        (row) => !requestEdit || ['PENDING', 'TRANSFER_REPORTED'].includes(row.status),
      )) {
        await client.query(
          `INSERT INTO outbox_events(event_id,event_type,schema_version,aggregate_id,aggregate_version,correlation_id,payload,aggregate_type,producer,operation_id,trip_id,actor_user_id) VALUES($1,'ContributionUpdated',1,$2,$3,$4,$5::jsonb,'Fund','Finance',$6,$7,$8)`,
          [
            randomUUID(),
            input.fundId,
            plan.financeVersion,
            correlation,
            JSON.stringify({
              fund_id: input.fundId,
              trip_id: input.tripId,
              contribution_id: row.id,
              status: row.status,
              finance_version: plan.financeVersion,
            }),
            input.operationId,
            input.tripId,
            input.actor,
          ],
        );
      }
    }
    return requestEdit
      ? {
          version: 1,
          tripId: input.tripId,
          contributionRequest: contributionRequestReadResponse(
            { ...request, contributions: rows },
            plan.financeVersion,
          ),
        }
      : {
          version: 1,
          tripId: input.tripId,
          contribution: contributionResponse(rows[0]!, plan.financeVersion),
        };
  }
}
