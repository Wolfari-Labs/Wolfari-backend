import { Inject, Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';

/** Private internal configuration; not an API DTO or an issued contribution's snapshot. */
export type PaymentDestinationRecord = Readonly<{
  id: string;
  fundId: string;
  destinationType: 'VIETQR' | 'MOMO_SANDBOX';
  bankCode: string | null;
  accountNumber: string | null;
  accountName: string | null;
  momoPhone: string | null;
  isDefault: boolean;
  active: boolean;
  version: number;
  confirmedByHolderAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

type DestinationRow = {
  id: string;
  fund_id: string;
  destination_type: PaymentDestinationRecord['destinationType'];
  bank_code: string | null;
  account_number: string | null;
  account_name: string | null;
  momo_phone: string | null;
  is_default: boolean;
  active: boolean;
  version: number;
  confirmed_by_holder_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

@Injectable()
export class PaymentDestinationRepository {
  constructor(@Inject(DatabaseProvider) private readonly db: Pick<DatabaseProvider, 'query'>) {}

  /**
   * Reads selected IDs in one Fund, ordered by ID (not caller order); duplicates yield one row.
   * Missing/wrong-Fund IDs are absent, never replaced with a default. Includes inactive and
   * unconfirmed records so the domain can reject them. Caller validates UUIDs and checks access.
   * No lock: these current settings are not safe write context and must not replace stored
   * destination_snapshot on an issued contribution. Do not log or expose account details.
   */
  async findByIds(
    scope: Readonly<{
      fundId: string;
      destinationIds: readonly string[];
    }>,
  ): Promise<PaymentDestinationRecord[]> {
    if (scope.destinationIds.length === 0) return [];
    const { rows } = await this.db.query<DestinationRow>(
      `SELECT id, fund_id, destination_type, bank_code, account_number, account_name,
              momo_phone, is_default, active, version, confirmed_by_holder_at, created_at, updated_at
         FROM public.payment_destinations
        WHERE fund_id = $1 AND id = ANY($2::uuid[])
        ORDER BY id`,
      [scope.fundId, [...scope.destinationIds]],
    );
    return rows.map((row) => ({
      id: row.id,
      fundId: row.fund_id,
      destinationType: row.destination_type,
      bankCode: row.bank_code,
      accountNumber: row.account_number,
      accountName: row.account_name,
      momoPhone: row.momo_phone,
      isDefault: row.is_default,
      active: row.active,
      version: row.version,
      confirmedByHolderAt: row.confirmed_by_holder_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}
