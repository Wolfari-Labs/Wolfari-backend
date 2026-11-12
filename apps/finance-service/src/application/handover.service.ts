import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import type { FinanceV1 } from '@wolfari/contracts/grpc';
import { FinanceReadError, readUuid } from '../finance.errors';
import { HandoverRepository, type HandoverWriteCommand } from '../repositories/handover.repository';
import { parseHandoverCreate, parseHandoverAction } from '../inputs/handover.input';
import { handoverResponse } from '../projections/handover-response';
import { FundCommandService } from './fund-command.service';
import { FundQueryService } from './fund-query.service';

@Injectable()
export class HandoverService {
  constructor(
    private readonly db: DatabaseProvider,
    private readonly rows: HandoverRepository,
    private readonly auth: FundQueryService,
    private readonly commands: FundCommandService,
  ) {}
  async list(request: FinanceV1.ListHolderHandoversRequest, correlation: string, deadline: number) {
    const fundId = readUuid(request.fund_id),
      actor = readUuid(request.actor_user_id);
    await this.auth.authorizeFundRead(fundId, actor, correlation, deadline);
    return { items: await this.rows.list(fundId) };
  }
  async get(request: FinanceV1.GetHolderHandoverRequest, correlation: string, deadline: number) {
    const found = await this.rows.find(readUuid(request.handover_id));
    if (!found) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    await this.auth.authorizeFundRead(
      found.row.fund_id,
      readUuid(request.actor_user_id),
      correlation,
      deadline,
    );
    return { handover: handoverResponse(found.row, found.financeVersion) };
  }
  async create(
    request: FinanceV1.CreateHolderHandoverRequest,
    correlation: string,
    deadline: number,
  ) {
    return this.run(
      {
        scope: 'CREATE_HOLDER_HANDOVER',
        fundId: readUuid(request.fund_id),
        body: parseHandoverCreate(request),
      },
      request.operation_id,
      request.actor_user_id,
      correlation,
      deadline,
    );
  }
  async manage(
    scope: Exclude<HandoverWriteCommand['scope'], 'CREATE_HOLDER_HANDOVER'>,
    request: FinanceV1.HolderHandoverActionRequest,
    correlation: string,
    deadline: number,
  ) {
    const handoverId = readUuid(request.handover_id),
      found = await this.rows.find(handoverId);
    if (!found) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const kinds = {
      ACCEPT_HOLDER_HANDOVER: 'accept',
      REFRESH_HOLDER_HANDOVER: 'refresh',
      CONFIRM_HOLDER_HANDOVER: 'confirm',
      CANCEL_HOLDER_HANDOVER: 'cancel',
    } as const;
    return this.run(
      {
        scope,
        fundId: found.row.fund_id,
        handoverId,
        body: parseHandoverAction(request, kinds[scope]),
      },
      request.operation_id,
      request.actor_user_id,
      correlation,
      deadline,
    );
  }
  private async run(
    mutation: HandoverWriteCommand,
    operationId: unknown,
    actor: unknown,
    correlation: string,
    deadline: number,
  ) {
    const fund = (
      await this.db.query<{ trip_id: string }>('SELECT trip_id FROM funds WHERE id=$1', [
        mutation.fundId,
      ])
    ).rows[0];
    if (!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    return this.commands.run(
      {
        ...mutation,
        operationId: readUuid(operationId),
        actor: readUuid(actor),
        tripId: fund.trip_id,
      },
      correlation,
      deadline,
    );
  }
}
