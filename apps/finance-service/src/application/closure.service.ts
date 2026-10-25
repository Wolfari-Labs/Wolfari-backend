import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import type { FinanceV1 } from '@wolfari/contracts/grpc';
import { FinanceReadError, readUuid } from '../finance.errors';
import {
  parseCancelClosure,
  parseClosurePage,
  parseConfirmClosure,
  parseCreateClosure,
  parseRemindClosure,
} from '../inputs/closure.input';
import { ClosureRepository, type ClosureWriteCommand } from '../repositories/closure.repository';
import { FundCommandService } from './fund-command.service';
import { FundQueryService } from './fund-query.service';

@Injectable()
export class ClosureService {
  constructor(
    private readonly db: DatabaseProvider,
    private readonly rows: ClosureRepository,
    private readonly auth: FundQueryService,
    private readonly commands: FundCommandService,
  ) {}
  async list(request: FinanceV1.ListClosuresRequest, correlation: string, deadline: number) {
    const actor = readUuid(request.actor_user_id);
    const page = parseClosurePage(request);
    await this.auth.authorizeFundRead(page.fundId, actor, correlation, deadline);
    const result = await this.rows.list(page);
    return { items: result.items, next_cursor: result.nextCursor };
  }
  async get(request: FinanceV1.GetClosureRequest, correlation: string, deadline: number) {
    const actor = readUuid(request.actor_user_id);
    const closureId = readUuid(request.closure_id);
    const scope = await this.rows.scope(closureId);
    if (!scope) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    await this.auth.authorizeFundRead(scope.fund_id, actor, correlation, deadline);
    const closure = await this.rows.get(closureId);
    if (!closure) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    return { closure };
  }
  async create(request: FinanceV1.CreateClosureRequest, correlation: string, deadline: number) {
    return this.run(
      {
        scope: 'CREATE_CLOSURE',
        fundId: readUuid(request.fund_id),
        body: parseCreateClosure({ expected_finance_version: request.expected_finance_version }),
      },
      request.operation_id,
      request.actor_user_id,
      correlation,
      deadline,
    );
  }
  async confirm(request: FinanceV1.ConfirmClosureRequest, correlation: string, deadline: number) {
    return this.action(
      'CONFIRM_CLOSURE',
      request.closure_id,
      parseConfirmClosure({ snapshot_hash: request.snapshot_hash }),
      request.operation_id,
      request.actor_user_id,
      correlation,
      deadline,
    );
  }
  async cancel(request: FinanceV1.CancelClosureRequest, correlation: string, deadline: number) {
    return this.action(
      'CANCEL_CLOSURE',
      request.closure_id,
      parseCancelClosure({ reason: request.reason }),
      request.operation_id,
      request.actor_user_id,
      correlation,
      deadline,
    );
  }
  async remind(request: FinanceV1.RemindClosureRequest, correlation: string, deadline: number) {
    return this.action(
      'REMIND_CLOSURE',
      request.closure_id,
      parseRemindClosure({}),
      request.operation_id,
      request.actor_user_id,
      correlation,
      deadline,
    );
  }
  private async action(
    scope: 'CONFIRM_CLOSURE' | 'CANCEL_CLOSURE' | 'REMIND_CLOSURE',
    closure: unknown,
    body: ClosureWriteCommand['body'],
    operation: unknown,
    actor: unknown,
    correlation: string,
    deadline: number,
  ) {
    const closureId = readUuid(closure);
    const found = await this.rows.scope(closureId);
    if (!found) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    return this.run(
      { scope, fundId: found.fund_id, closureId, body } as ClosureWriteCommand,
      operation,
      actor,
      correlation,
      deadline,
    );
  }
  private async run(
    mutation: ClosureWriteCommand,
    operation: unknown,
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
        operationId: readUuid(operation),
        actor: readUuid(actor),
        tripId: fund.trip_id,
      },
      correlation,
      deadline,
    );
  }
}
