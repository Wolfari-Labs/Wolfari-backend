import { Inject, Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import { FinanceReadError } from '../finance.errors';

export type FinanceFile = {
  object_key: string;
  fund_id: string;
  uploader_user_id: string;
  sha256: string;
  mime_type: string;
  size_bytes: number;
  state: 'UPLOADING' | 'READY' | 'DELETING';
  contribution_id: string | null;
  expense_id: string | null;
};
type Transaction = Parameters<Parameters<DatabaseProvider['withTransaction']>[0]>[0];

@Injectable()
export class ReceiptRepository {
  constructor(@Inject(DatabaseProvider) private readonly db: DatabaseProvider) {}

  async create(file: Omit<FinanceFile, 'state' | 'contribution_id' | 'expense_id'>) {
    await this.db.withTransaction(async (tx) => {
      const fund = await tx.query('SELECT status FROM funds WHERE id=$1 FOR UPDATE', [
        file.fund_id,
      ]);
      if (!fund.rows[0]) throw new FinanceReadError('RESOURCE_NOT_FOUND');
      if (fund.rows[0].status !== 'OPEN') throw new FinanceReadError('STATE_CONFLICT');
      await tx.query(
        `INSERT INTO finance_files
        (object_key,fund_id,uploader_user_id,sha256,mime_type,size_bytes)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          file.object_key,
          file.fund_id,
          file.uploader_user_id,
          file.sha256,
          file.mime_type,
          file.size_bytes,
        ],
      );
    });
  }
  async ready(key: string) {
    const result = await this.db.query(
      `UPDATE finance_files SET state='READY'
      WHERE object_key=$1 AND state='UPLOADING'`,
      [key],
    );
    if (result.rowCount !== 1) throw new FinanceReadError('SERVICE_UNAVAILABLE');
  }
  async pendingAttachment(fund: string, key: string, uploader: string): Promise<FinanceFile> {
    const result = await this.db.query<FinanceFile>(
      `SELECT * FROM finance_files WHERE fund_id=$1 AND object_key=$2 AND uploader_user_id=$3
       AND state='READY' AND bound_at IS NULL`,
      [fund, key, uploader],
    );
    if (!result.rows[0]) throw new FinanceReadError('STATE_CONFLICT');
    return result.rows[0];
  }
  async readable(fund: string, key: string, actor: string): Promise<FinanceFile> {
    const result = await this.db.query<FinanceFile>(
      `SELECT ff.* FROM finance_files ff
      JOIN funds f ON f.id=ff.fund_id
      LEFT JOIN contributions c ON c.id=ff.contribution_id AND c.fund_id=ff.fund_id
      LEFT JOIN fund_expenses e ON e.id=ff.expense_id AND e.fund_id=ff.fund_id AND e.deleted_at IS NULL
      WHERE ff.fund_id=$1 AND ff.object_key=$2 AND ff.state='READY' AND ff.bound_at IS NOT NULL
        AND (e.id IS NOT NULL OR (c.id IS NOT NULL AND ($3=c.member_user_id OR $3=f.holder_user_id)))`,
      [fund, key, actor],
    );
    if (!result.rows[0]) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    return result.rows[0];
  }

  /** Internal future business writer: caller holds Fund lock and Trip mutation guard.
   * Object must first be verified by ReceiptStorage.verify; no storage RPC inside this transaction.
   * Lock order is Fund -> file; READY is rechecked here against the cleanup claimant.
   */
  async bind(
    tx: Transaction,
    fund: string,
    key: string,
    uploader: string,
    target: { contributionId: string } | { expenseId: string },
  ) {
    await tx.query('SELECT id FROM funds WHERE id=$1 FOR UPDATE', [fund]);
    const result = await tx.query<FinanceFile>(
      'SELECT * FROM finance_files WHERE fund_id=$1 AND object_key=$2 FOR UPDATE',
      [fund, key],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.uploader_user_id !== uploader ||
      row.state !== 'READY' ||
      row.contribution_id ||
      row.expense_id
    )
      throw new FinanceReadError('STATE_CONFLICT');
    await tx.query(
      `UPDATE finance_files SET contribution_id=$2,expense_id=$3,bound_at=clock_timestamp()
      WHERE object_key=$1`,
      [
        key,
        'contributionId' in target ? target.contributionId : null,
        'expenseId' in target ? target.expenseId : null,
      ],
    );
  }

  async claimExpired(): Promise<string | undefined> {
    return this.db.withTransaction(async (tx) => {
      // Selection is unlocked. Recheck after Fund lock so attachment and deletion serialize.
      const candidate = await tx.query<{
        object_key: string;
        fund_id: string;
      }>(`SELECT object_key,fund_id
        FROM finance_files WHERE bound_at IS NULL AND cleanup_after <= clock_timestamp()
        ORDER BY cleanup_after,object_key LIMIT 1`);
      const row = candidate.rows[0];
      if (!row) return;
      await tx.query('SELECT id FROM funds WHERE id=$1 FOR UPDATE', [row.fund_id]);
      const claimed = await tx.query(
        `UPDATE finance_files SET state='DELETING',
        cleanup_after=clock_timestamp()+interval '1 hour'
        WHERE object_key=$1 AND bound_at IS NULL AND cleanup_after <= clock_timestamp() RETURNING object_key`,
        [row.object_key],
      );
      // Keep tombstones and revisit them: a delayed object write after a crash must also be removed.
      return claimed.rowCount === 1 ? row.object_key : undefined;
    });
  }
}
