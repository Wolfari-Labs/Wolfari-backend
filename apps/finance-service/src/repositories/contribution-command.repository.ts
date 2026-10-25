import { randomUUID } from 'node:crypto';
import type { FinanceV1 } from '@wolfari/contracts/grpc';
import type { DatabaseProvider } from '@wolfari/database';
import type { FundWrite, StoredResult } from './fund-command.repository';
import type { FundSetupContext } from '../domain/fund-setup';
import { FinanceReadError } from '../finance.errors';
import { prepareContributionRequest } from '../application/prepare-contribution-request';
import { PaymentDestinationRepository } from './payment-destination.repository';
import {
  contributionRequestResponse,
  type NewContributionRequestRow,
} from '../projections/contribution-response';

/** Runs inside the coordinator's operation lock, savepoint and receipt transaction. */
export class ContributionCommandRepository {
  async create(
    client: Pick<DatabaseProvider, 'query'>,
    input: Extract<FundWrite, { scope: 'CREATE_CONTRIBUTION_REQUEST' }>,
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
    // All destination writers take the same Fund lock. Also lock selected rows explicitly.
    const ids = [...new Set(input.body.contributions.map((item) => item.destinationId))].sort();
    await client.query(
      'SELECT id FROM payment_destinations WHERE fund_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
      [input.fundId, ids],
    );
    const destinations = await new PaymentDestinationRepository(client).findByIds({
      fundId: input.fundId,
      destinationIds: ids,
    });
    const prepared = prepareContributionRequest(
      input.body,
      {
        ...authority,
        fundId: input.fundId,
        fundStatus: fund.status,
        financeVersion: fund.finance_version,
      },
      destinations,
    );
    if (fund.finance_version === 2147483647) throw new FinanceReadError('STATE_CONFLICT');
    const request = (
      await client.query<NewContributionRequestRow>(
        `INSERT INTO contribution_requests(fund_id,title,due_at,note,created_by_user_id)
       VALUES($1,$2,$3,$4,$5) RETURNING id,fund_id,title,due_at,note,created_by_user_id,created_at`,
        [input.fundId, prepared.title, prepared.dueAt, prepared.note, input.actor],
      )
    ).rows[0]!;
    const contributionIds: string[] = [];
    const publicContributions: FinanceV1.ContributionView[] = [];
    for (const item of prepared.contributions) {
      const dest = item.destination;
      const snapshot = {
        schema_version: 1,
        destination_id: dest.id,
        fund_id: input.fundId,
        destination_version: dest.version,
        destination_type: dest.destinationType,
        holder_user_id: fund.holder_user_id,
        confirmed_by_holder_at: dest.confirmedByHolderAt!.toISOString(),
        recipient:
          dest.destinationType === 'VIETQR'
            ? {
                bank_code: dest.bankCode,
                account_number: dest.accountNumber,
                account_name: dest.accountName,
              }
            : { momo_phone: dest.momoPhone },
      };
      const id = randomUUID();
      await client.query(
        `INSERT INTO contributions(id,request_id,fund_id,member_user_id,amount,destination_snapshot,destination_version,self_contribution)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [
          id,
          request.id,
          input.fundId,
          item.memberUserId,
          item.amount.toString(),
          JSON.stringify(snapshot),
          dest.version,
          item.memberUserId === fund.holder_user_id,
        ],
      );
      contributionIds.push(id);
      publicContributions.push({
        id,
        request_id: request.id,
        fund_id: input.fundId,
        member_user_id: item.memberUserId,
        amount: item.amount.toString(),
        status: 'PENDING',
        self_contribution: item.memberUserId === fund.holder_user_id,
        version: 1,
        finance_version: fund.finance_version + 1,
      });
    }
    const nextVersion = fund.finance_version + 1;
    await client.query(
      'UPDATE funds SET finance_version=$2,updated_at=clock_timestamp() WHERE id=$1',
      [input.fundId, nextVersion],
    );
    await client.query(
      `INSERT INTO finance_audit_logs(fund_id,actor_user_id,action,entity_type,entity_id,from_version,to_version,correlation_id,details)
       VALUES($1,$2,'CREATE_CONTRIBUTION_REQUEST','ContributionRequest',$3,NULL,1,$4,$5::jsonb)`,
      [
        input.fundId,
        input.actor,
        request.id,
        correlation,
        JSON.stringify({ operation_id: input.operationId, finance_version: nextVersion }),
      ],
    );
    await client.query(
      `INSERT INTO outbox_events(event_id,event_type,schema_version,aggregate_id,aggregate_version,correlation_id,payload,aggregate_type,producer,operation_id,trip_id,actor_user_id)
       VALUES($1,'ContributionRequested',1,$2,$3,$4,$5::jsonb,'Fund','Finance',$6,$7,$8)`,
      [
        randomUUID(),
        input.fundId,
        nextVersion,
        correlation,
        JSON.stringify({
          fund_id: input.fundId,
          trip_id: input.tripId,
          request_id: request.id,
          contribution_ids: contributionIds,
          finance_version: nextVersion,
        }),
        input.operationId,
        input.tripId,
        input.actor,
      ],
    );
    return {
      version: 1,
      tripId: input.tripId,
      contributionRequest: {
        ...contributionRequestResponse(request),
        contributions: publicContributions,
        finance_version: nextVersion,
      },
    };
  }
}
