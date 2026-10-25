import { Inject, Injectable } from '@nestjs/common';
import { FinanceReadError, readUuid } from '../finance.errors';
import { FundQueryService } from './fund-query.service';
import { PaymentInstructionRepository } from '../repositories/payment-instruction.repository';
import { paymentInstruction } from '../domain/payment-instruction';

@Injectable()
export class PaymentInstructionService {
  constructor(
    @Inject(FundQueryService)
    private readonly auth: Pick<FundQueryService, 'authorizePaymentInstruction'>,
    @Inject(PaymentInstructionRepository)
    private readonly rows: Pick<PaymentInstructionRepository, 'scope' | 'read'>,
  ) {}
  async get(
    input: { contribution_id?: unknown; actor_user_id?: unknown },
    correlation: string,
    deadline: number,
  ) {
    const id = readUuid(input.contribution_id),
      actor = readUuid(input.actor_user_id);
    const scope = await this.rows.scope(id, actor);
    if (!scope) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    await this.auth.authorizePaymentInstruction(scope.fund_id, actor, correlation, deadline);
    const row = await this.rows.read(id, actor, scope.fund_id);
    if (Date.now() >= deadline) throw new FinanceReadError('SERVICE_UNAVAILABLE');
    if (!row || row.id !== id || row.member_user_id !== actor || row.fund_id !== scope.fund_id)
      throw new FinanceReadError('RESOURCE_NOT_FOUND');
    return { instruction: paymentInstruction(row) };
  }
}
