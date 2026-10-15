import { DatabaseProvider } from '@wolfari/database';
import {
  parseContributionManagementInput,
  type ContributionManagementScope,
} from '../inputs/contribution-management.input';
import { Injectable } from '@nestjs/common';
import type { FinanceV1 } from '@wolfari/contracts/grpc';
import { FundRepository } from '../repositories/fund.repository';
import { FundCommandService } from './fund-command.service';
import {
  parseCreateContributionRequestInput,
  ContributionRequestInputError,
} from '../inputs/create-contribution-request.input';
import { FinanceReadError, readUuid } from '../finance.errors';

@Injectable()
export class ContributionCommandService {
  constructor(
    private readonly funds: FundRepository,
    private readonly commands: FundCommandService,
    private readonly db: DatabaseProvider,
  ) {}
  async manage(
    scope: ContributionManagementScope,
    request: FinanceV1.UpdateContributionRequestRequest &
      FinanceV1.UpdateContributionAmountRequest &
      FinanceV1.WaiveContributionRequest,
    correlation: string,
    deadline: number,
  ) {
    const operationId = readUuid(request.operation_id),
      actor = readUuid(request.actor_user_id);
    try {
      const fields =
        scope === 'UPDATE_CONTRIBUTION_REQUEST'
          ? { title: request.title, due_at: request.due_at, note: request.note }
          : scope === 'UPDATE_CONTRIBUTION_AMOUNT'
            ? { amount: request.amount }
            : { reason: request.reason };
      const body = parseContributionManagementInput(scope, {
        ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
        expected_version: request.expected_version,
        expected_finance_version: request.expected_finance_version,
      });
      let fundId: string, requestId: string, contributionId: string | undefined;
      if (scope === 'UPDATE_CONTRIBUTION_REQUEST') {
        fundId = readUuid(request.fund_id);
        requestId = readUuid(request.request_id);
      } else {
        contributionId = readUuid(request.contribution_id);
        const row = (
          await this.db.query<{ fund_id: string; request_id: string }>(
            'SELECT fund_id,request_id FROM contributions WHERE id=$1',
            [contributionId],
          )
        ).rows[0];
        if (!row) throw new FinanceReadError('RESOURCE_NOT_FOUND');
        fundId = row.fund_id;
        requestId = row.request_id;
      }
      const fund = await this.funds.findScopeById(fundId);
      if (!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
      return await this.commands.run(
        { scope, operationId, actor, fundId, requestId, contributionId, tripId: fund.tripId, body },
        correlation,
        deadline,
      );
    } catch (error) {
      if (error instanceof ContributionRequestInputError)
        throw new FinanceReadError('VALIDATION_FAILED');
      throw error;
    }
  }
  async create(
    request: FinanceV1.CreateContributionRequestRequest,
    correlation: string,
    deadline: number,
  ): Promise<FinanceV1.CreateContributionRequestResponse> {
    const operationId = readUuid(request.operation_id),
      actor = readUuid(request.actor_user_id),
      fundId = readUuid(request.fund_id);
    try {
      const body = parseCreateContributionRequestInput({
        title: request.title,
        contributions: request.contributions?.map((item) => ({
          member_user_id: item.member_user_id,
          amount: item.amount,
          destination_id: item.destination_id,
        })),
        ...(request.due_at === undefined ? {} : { due_at: request.due_at }),
        ...(request.note === undefined ? {} : { note: request.note }),
        expected_finance_version: request.expected_finance_version,
      });
      const fund = await this.funds.findScopeById(fundId);
      if (!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
      return await this.commands.run(
        {
          scope: 'CREATE_CONTRIBUTION_REQUEST',
          operationId,
          actor,
          fundId,
          tripId: fund.tripId,
          body,
        },
        correlation,
        deadline,
      );
    } catch (error) {
      if (error instanceof ContributionRequestInputError)
        throw new FinanceReadError('VALIDATION_FAILED');
      throw error;
    }
  }
}
