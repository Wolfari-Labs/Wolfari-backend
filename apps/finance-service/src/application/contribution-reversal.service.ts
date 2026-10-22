import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import type { FinanceV1 } from '@wolfari/contracts/grpc';
import { FinanceReadError, readUuid } from '../finance.errors';
import {
  ContributionReversalInputError,
  parseContributionReversalInput,
} from '../inputs/contribution-reversal.input';
import { FundQueryService } from './fund-query.service';
import { FundCommandService } from './fund-command.service';

@Injectable()
export class ContributionReversalService {
  constructor(
    private readonly db: DatabaseProvider,
    private readonly queries: FundQueryService,
    private readonly commands: FundCommandService,
  ) {}

  async run(request: FinanceV1.ReverseContributionRequest, correlation: string, deadline: number) {
    const operationId = readUuid(request.operation_id),
      actor = readUuid(request.actor_user_id),
      contributionId = readUuid(request.contribution_id);
    let body;
    try {
      body = parseContributionReversalInput({
        reason: request.reason,
        expected_version: request.expected_version,
        expected_finance_version: request.expected_finance_version,
      });
    } catch (error) {
      if (error instanceof ContributionReversalInputError)
        throw new FinanceReadError('VALIDATION_FAILED');
      throw error;
    }
    const row = (
      await this.db.query<{ fund_id: string; request_id: string; trip_id: string }>(
        'SELECT c.fund_id,c.request_id,f.trip_id FROM contributions c JOIN funds f ON f.id=c.fund_id WHERE c.id=$1',
        [contributionId],
      )
    ).rows[0];
    if (!row) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const current = await this.queries.getFund(
      { trip_id: row.trip_id, actor_user_id: actor },
      correlation,
      deadline,
    );
    if (current.fund?.holder_user_id !== actor) throw new FinanceReadError('PERMISSION_DENIED');
    return this.commands.run(
      {
        scope: 'REVERSE_CONTRIBUTION',
        operationId,
        actor,
        tripId: row.trip_id,
        fundId: row.fund_id,
        requestId: row.request_id,
        contributionId,
        body,
      },
      correlation,
      deadline,
    );
  }
}
