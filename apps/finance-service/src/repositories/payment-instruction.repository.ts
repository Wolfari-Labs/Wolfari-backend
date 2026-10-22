import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import type { PaymentInstructionRow } from '../domain/payment-instruction';

@Injectable()
export class PaymentInstructionRepository {
  constructor(private readonly database: DatabaseProvider) {}
  async scope(id: string, actor: string) {
    return (
      await this.database.query<{ fund_id: string }>(
        'SELECT fund_id FROM contributions WHERE id=$1 AND member_user_id=$2',
        [id, actor],
      )
    ).rows[0];
  }
  async read(id: string, actor: string, fund: string) {
    // All private fields, lifecycle and payment blockers share one SQL snapshot.
    return (
      await this.database.query<PaymentInstructionRow>(
        `SELECT c.id,c.fund_id,f.trip_id,c.member_user_id,f.holder_user_id,c.amount::text,f.currency,
       c.status,f.status AS fund_status,r.status AS request_status,c.destination_version,c.destination_snapshot,
       (EXISTS(SELECT 1 FROM payment_attempts p WHERE p.contribution_id=c.id AND
          (p.needs_reconciliation OR p.status IN ('CREATED','PENDING','SUCCEEDED'))) OR
        EXISTS(SELECT 1 FROM fund_transactions t WHERE t.contribution_id=c.id AND t.transaction_type='CONTRIBUTION')) AS blocked_payment
       FROM contributions c JOIN funds f ON f.id=c.fund_id
       JOIN contribution_requests r ON r.id=c.request_id AND r.fund_id=c.fund_id
       WHERE c.id=$1 AND c.member_user_id=$2 AND c.fund_id=$3`,
        [id, actor, fund],
      )
    ).rows[0];
  }
}
