import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import type { FinanceV1 } from '@wolfari/contracts/grpc';
import { FinanceReadError, readUuid } from '../finance.errors';
import {
  ManualContributionInputError,
  parseManualContributionInput,
} from '../inputs/manual-contribution.input';
import type { ManualWrite } from '../repositories/manual-contribution.repository';
import { ReceiptService } from '../receipts/receipt.service';
import { FundQueryService } from './fund-query.service';
import { FundCommandService } from './fund-command.service';

@Injectable()
export class ManualContributionService {
  constructor(
    private readonly db: DatabaseProvider,
    private readonly queries: FundQueryService,
    private readonly commands: FundCommandService,
    private readonly files: ReceiptService,
  ) {}
  async run(
    scope: ManualWrite['scope'],
    request: FinanceV1.ReportContributionTransferRequest &
      FinanceV1.RejectContributionTransferRequest,
    correlation: string,
    deadline: number,
  ) {
    const operationId = readUuid(request.operation_id),
      actor = readUuid(request.actor_user_id),
      id = readUuid(request.contribution_id);
    let body;
    try {
      body = parseManualContributionInput(scope, {
        expected_version: request.expected_version,
        expected_finance_version: request.expected_finance_version,
        ...(request.evidence_object_key === undefined
          ? {}
          : { evidence_object_key: request.evidence_object_key }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      });
    } catch (error) {
      if (error instanceof ManualContributionInputError)
        throw new FinanceReadError('VALIDATION_FAILED');
      throw error;
    }
    const row = (
      await this.db.query<{
        fund_id: string;
        request_id: string;
        trip_id: string;
        member_user_id: string;
        transfer_evidence_object_key: string | null;
      }>(
        'SELECT c.fund_id,c.request_id,f.trip_id,c.member_user_id,c.transfer_evidence_object_key FROM contributions c JOIN funds f ON f.id=c.fund_id WHERE c.id=$1',
        [id],
      )
    ).rows[0];
    if (!row) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const current = await this.queries.getFund(
      { trip_id: row.trip_id, actor_user_id: actor },
      correlation,
      deadline,
    );
    if (actor !== (scope === 'REPORT_TRANSFER' ? row.member_user_id : current.fund?.holder_user_id))
      throw new FinanceReadError('PERMISSION_DENIED');
    return this.commands.run(
      {
        scope,
        operationId,
        actor,
        tripId: row.trip_id,
        fundId: row.fund_id,
        requestId: row.request_id,
        contributionId: id,
        body,
      },
      correlation,
      deadline,
      async () => {
        if (body.evidenceObjectKey !== undefined) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
          try {
            await this.files.prepareAttachment(
              row.fund_id,
              body.evidenceObjectKey,
              actor,
              controller.signal,
              body.evidenceObjectKey === row.transfer_evidence_object_key ? id : undefined,
            );
          } finally {
            clearTimeout(timer);
          }
        }
      },
    );
  }
}
