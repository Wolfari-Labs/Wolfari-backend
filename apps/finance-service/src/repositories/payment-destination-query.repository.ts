import { Inject, Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';

/** API list projection, separate from PR #6's selected-ID contribution configuration reader. */
export type DestinationListRow = {
  id: string;
  fund_id: string;
  destination_type: 'VIETQR' | 'MOMO_SANDBOX';
  is_default: boolean;
  active: boolean;
  version: number;
  confirmed_by_holder_at: Date | null;
  bank_code?: string | null;
  account_number?: string | null;
  account_name?: string | null;
  momo_phone?: string | null;
};

@Injectable()
export class PaymentDestinationQueryRepository {
  constructor(@Inject(DatabaseProvider) private readonly db: Pick<DatabaseProvider, 'query'>) {}

  /** includePrivate is derived by the service after current Trip authorization, never from HTTP. */
  async listByFund(fundId: string, includePrivate: boolean): Promise<DestinationListRow[]> {
    const privateColumns = includePrivate
      ? ', bank_code, account_number, account_name, momo_phone'
      : '';
    const { rows } = await this.db.query<DestinationListRow>(
      `SELECT id, fund_id, destination_type, is_default, active, version, confirmed_by_holder_at${privateColumns}
       FROM public.payment_destinations WHERE fund_id = $1 ORDER BY id`,
      [fundId],
    );
    return rows;
  }
}
