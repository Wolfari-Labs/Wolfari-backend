import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseProvider } from '@wolfari/database';
import { planBankTransfer, referencesInContent } from '../domain/bank-transfer';
import { FinanceReadError, fundNotOpenReason } from '../finance.errors';
import type { BankTransferRow } from '../projections/bank-transfer-response';

type Client = Pick<DatabaseProvider, 'query'>;
const MAX_INT32 = 2_147_483_647;
export const BANK_TRANSFER_RESOLUTIONS = ['RETURNED_TO_SENDER', 'HANDLED_IN_APP', 'NOT_OURS'] as const;
export type BankTransferResolution = (typeof BANK_TRANSFER_RESOLUTIONS)[number];

export type BankTransferInput = Readonly<{
  provider: string;
  providerTransactionId: string;
  transferType: 'IN' | 'OUT';
  amount: bigint;
  content: string;
  accountNumber: string;
  bankGateway: string | null;
  referenceCode: string | null;
  subAccount: string | null;
  transactionAt: Date | null;
  payload: unknown;
}>;

export type BankTransferResult = Readonly<{
  receiptId: string;
  status: string;
  contributionId: string | null;
  replayed: boolean;
}>;

const columns = `id,provider,provider_transaction_id,transfer_type,amount::text,content,account_number,bank_gateway,
processing_status,review_reason,fund_id,contribution_id,transaction_at,received_at,processed_at,
resolution,resolution_note,resolved_by_user_id,resolved_at`;

type CandidateRow = {
  id: string;
  fund_id: string;
  status: string;
  amount: string;
  version: number;
  destination_snapshot: {
    destination_type?: unknown;
    recipient?: { account_number?: unknown };
  } | null;
  request_status: string;
  fund_status: string;
  current_balance: string;
  finance_version: number;
  trip_id: string;
  has_ledger: boolean;
};

@Injectable()
export class BankTransferRepository {
  constructor(@Inject(DatabaseProvider) private readonly db: DatabaseProvider) {}

  /**
   * Stores the provider transaction once (replay returns the stored outcome) and settles it in the
   * same transaction under the Fund row lock, exactly like a provider payment success: one ledger
   * IN, contribution CONFIRMED by the system actor, audit and outbox. Anything doubtful is kept
   * for the Holder as NEEDS_REVIEW/UNMATCHED and never guessed.
   */
  async receive(input: BankTransferInput, correlation: string): Promise<BankTransferResult> {
    return this.db.withTransaction(async (client) => {
      const inserted = (
        await client.query<{ id: string }>(
          `INSERT INTO bank_transfer_receipts(provider,provider_transaction_id,transfer_type,amount,content,
           account_number,bank_gateway,reference_code,sub_account,transaction_at,payload,processing_status)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'UNMATCHED')
           ON CONFLICT (provider,provider_transaction_id) DO NOTHING RETURNING id`,
          [
            input.provider,
            input.providerTransactionId,
            input.transferType,
            input.amount.toString(),
            input.content,
            input.accountNumber,
            input.bankGateway,
            input.referenceCode,
            input.subAccount,
            input.transactionAt,
            JSON.stringify(input.payload),
          ],
        )
      ).rows[0];
      if (!inserted) {
        const existing = (
          await client.query<{
            id: string;
            processing_status: string;
            contribution_id: string | null;
          }>(
            'SELECT id,processing_status,contribution_id FROM bank_transfer_receipts WHERE provider=$1 AND provider_transaction_id=$2',
            [input.provider, input.providerTransactionId],
          )
        ).rows[0]!;
        return {
          receiptId: existing.id,
          status: existing.processing_status,
          contributionId: existing.contribution_id,
          replayed: true,
        };
      }
      const candidates = input.transferType === 'IN' ? referencesInContent(input.content) : [];
      let candidate: CandidateRow | undefined;
      if (candidates.length === 1) {
        const scope = (
          await client.query<{ fund_id: string }>('SELECT fund_id FROM contributions WHERE id=$1', [
            candidates[0],
          ])
        ).rows[0];
        if (scope) {
          // Same lock order as every Finance writer: Fund row first, then the contribution.
          await client.query('SELECT id FROM funds WHERE id=$1 FOR UPDATE', [scope.fund_id]);
          candidate = (
            await client.query<CandidateRow>(
              `SELECT c.id,c.fund_id,c.status,c.amount::text,c.version,c.destination_snapshot,
               r.status AS request_status,f.status AS fund_status,f.current_balance::text,f.finance_version,f.trip_id,
               EXISTS(SELECT 1 FROM fund_transactions t WHERE t.contribution_id=c.id AND t.transaction_type='CONTRIBUTION') AS has_ledger
               FROM contributions c JOIN contribution_requests r ON r.id=c.request_id JOIN funds f ON f.id=c.fund_id
               WHERE c.id=$1 FOR UPDATE OF c`,
              [candidates[0]],
            )
          ).rows[0];
        }
      }
      const decision = planBankTransfer(
        {
          transferType: input.transferType,
          amount: input.amount,
          accountNumber: input.accountNumber,
        },
        candidates,
        candidate && {
          status: candidate.status,
          amount: BigInt(candidate.amount),
          version: candidate.version,
          destinationType: String(candidate.destination_snapshot?.destination_type ?? ''),
          destinationAccountNumber: String(
            candidate.destination_snapshot?.recipient?.account_number ?? '',
          ),
          requestStatus: candidate.request_status,
          fundStatus: candidate.fund_status,
          financeVersion: candidate.finance_version,
          hasLedgerEntry: candidate.has_ledger,
        },
      );
      let fundId: string | null = candidate?.fund_id ?? null;
      if (!fundId) fundId = await this.fundByAccount(client, input.accountNumber);
      if (decision.status === 'MATCHED' && candidate)
        await this.settle(client, candidate, inserted.id, input, correlation);
      await client.query(
        `UPDATE bank_transfer_receipts SET processing_status=$2,review_reason=$3,fund_id=$4,contribution_id=$5,
         processed_at=clock_timestamp() WHERE id=$1`,
        [
          inserted.id,
          decision.status,
          decision.reason,
          fundId,
          decision.status === 'MATCHED' ? candidate!.id : null,
        ],
      );
      return {
        receiptId: inserted.id,
        status: decision.status,
        contributionId: decision.status === 'MATCHED' ? candidate!.id : null,
        replayed: false,
      };
    });
  }

  /** Attribute money without a usable reference to the one Fund whose destination owns the account. */
  private async fundByAccount(client: Client, accountNumber: string) {
    const rows = (
      await client.query<{ fund_id: string }>(
        `SELECT DISTINCT fund_id FROM payment_destinations
         WHERE destination_type='VIETQR' AND upper(regexp_replace(account_number,'\\s','','g'))=upper(regexp_replace($1,'\\s','','g'))`,
        [accountNumber],
      )
    ).rows;
    return rows.length === 1 ? rows[0]!.fund_id : null;
  }

  private async settle(
    client: Client,
    row: CandidateRow,
    receiptId: string,
    input: BankTransferInput,
    correlation: string,
  ) {
    const balance = BigInt(row.current_balance) + input.amount;
    const sequence =
      BigInt(
        (
          await client.query<{ sequence: string }>(
            'SELECT COALESCE(MAX(sequence),0)::text AS sequence FROM fund_transactions WHERE fund_id=$1',
            [row.fund_id],
          )
        ).rows[0]!.sequence,
      ) + 1n;
    if (balance > 9223372036854775807n || sequence > 9223372036854775807n)
      throw new Error('Fund ledger limit reached');
    await client.query(
      `INSERT INTO fund_transactions(fund_id,sequence,direction,transaction_type,amount,balance_after,
       contribution_id,actor_user_id,business_key)
       VALUES($1,$2,'IN','CONTRIBUTION',$3,$4,$5,NULL,$6)`,
      [
        row.fund_id,
        sequence.toString(),
        input.amount.toString(),
        balance.toString(),
        row.id,
        `contribution:${row.id}`,
      ],
    );
    await client.query(
      `UPDATE contributions SET status='CONFIRMED',confirmed_at=clock_timestamp(),confirmed_by_user_id=NULL,
       version=version+1,updated_at=clock_timestamp() WHERE id=$1`,
      [row.id],
    );
    const financeVersion = row.finance_version + 1;
    await client.query(
      `UPDATE funds SET current_balance=$2,finance_version=$3,updated_at=clock_timestamp() WHERE id=$1`,
      [row.fund_id, balance.toString(), financeVersion],
    );
    await client.query(
      `INSERT INTO finance_audit_logs(fund_id,actor_user_id,system_actor,action,entity_type,entity_id,
       from_version,to_version,correlation_id,details)
       VALUES($1,NULL,$2,'CONFIRM_BANK_TRANSFER','Contribution',$3,$4,$5,$6,$7::jsonb)`,
      [
        row.fund_id,
        `BANK_WEBHOOK:${input.provider}`,
        row.id,
        row.version,
        row.version + 1,
        correlation,
        JSON.stringify({
          bank_transfer_receipt_id: receiptId,
          provider: input.provider,
          finance_version: financeVersion,
        }),
      ],
    );
    await client.query(
      `INSERT INTO outbox_events(event_id,event_type,schema_version,aggregate_id,aggregate_version,
       correlation_id,payload,aggregate_type,producer,trip_id,actor_user_id,system_actor)
       VALUES($1,'ContributionUpdated',1,$2,$3,$4,$5::jsonb,'Fund','Finance',$6,NULL,$7)`,
      [
        randomUUID(),
        row.fund_id,
        financeVersion,
        correlation,
        JSON.stringify({
          fund_id: row.fund_id,
          trip_id: row.trip_id,
          contribution_id: row.id,
          status: 'CONFIRMED',
          finance_version: financeVersion,
        }),
        row.trip_id,
        `BANK_WEBHOOK:${input.provider}`,
      ],
    );
  }

  /**
   * Holder closes a NEEDS_REVIEW transfer with a recorded outcome. No ledger or balance effect;
   * the Fund version moves so concurrent closure requests and other screens see the change.
   * A repeated operation id returns the stored result instead of failing.
   */
  async resolve(
    input: Readonly<{
      fundId: string;
      transferId: string;
      actor: string;
      operationId: string;
      resolution: BankTransferResolution;
      note: string;
      expectedFinanceVersion: number;
    }>,
    correlation: string,
  ): Promise<{ row: BankTransferRow; financeVersion: number }> {
    return this.db.withTransaction(async (client) => {
      const fund = (
        await client.query<{ holder_user_id: string; status: string; finance_version: number }>(
          'SELECT holder_user_id,status,finance_version FROM funds WHERE id=$1 FOR UPDATE',
          [input.fundId],
        )
      ).rows[0];
      if (!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
      const row = (
        await client.query<BankTransferRow & { fund_id: string | null; resolution_operation_id: string | null }>(
          `SELECT ${columns},resolution_operation_id FROM bank_transfer_receipts WHERE id=$1 FOR UPDATE`,
          [input.transferId],
        )
      ).rows[0];
      if (!row || row.fund_id !== input.fundId) throw new FinanceReadError('RESOURCE_NOT_FOUND');
      if (row.processing_status === 'RESOLVED' && row.resolution_operation_id === input.operationId) {
        if (row.resolution !== input.resolution || row.resolution_note !== input.note)
          throw new FinanceReadError('IDEMPOTENCY_CONFLICT');
        return { row, financeVersion: fund.finance_version };
      }
      if (fund.holder_user_id !== input.actor) throw new FinanceReadError('PERMISSION_DENIED');
      if (fund.status !== 'OPEN') throw new FinanceReadError('STATE_CONFLICT', fundNotOpenReason(fund.status));
      if (row.processing_status !== 'NEEDS_REVIEW')
        throw new FinanceReadError('STATE_CONFLICT', 'INVALID_TRANSITION');
      if (fund.finance_version !== input.expectedFinanceVersion)
        throw new FinanceReadError('VERSION_CONFLICT');
      if (fund.finance_version >= MAX_INT32) throw new FinanceReadError('STATE_CONFLICT');
      const resolved = (
        await client.query<BankTransferRow>(
          `UPDATE bank_transfer_receipts SET processing_status='RESOLVED',resolution=$2,resolution_note=$3,
           resolved_by_user_id=$4,resolved_at=clock_timestamp(),resolution_operation_id=$5
           WHERE id=$1 RETURNING ${columns}`,
          [row.id, input.resolution, input.note, input.actor, input.operationId],
        )
      ).rows[0]!;
      const financeVersion = (
        await client.query<{ finance_version: number }>(
          'UPDATE funds SET finance_version=finance_version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING finance_version',
          [input.fundId],
        )
      ).rows[0]!.finance_version;
      await client.query(
        `INSERT INTO finance_audit_logs(fund_id,actor_user_id,system_actor,action,entity_type,entity_id,
         from_version,to_version,correlation_id,details)
         VALUES($1,$2,NULL,'RESOLVE_BANK_TRANSFER','BankTransferReceipt',$3,$4,$5,$6,$7::jsonb)`,
        [
          input.fundId,
          input.actor,
          row.id,
          fund.finance_version,
          financeVersion,
          correlation,
          JSON.stringify({
            operation_id: input.operationId,
            resolution: input.resolution,
            review_reason: row.review_reason,
          }),
        ],
      );
      return { row: resolved, financeVersion };
    });
  }

  async fundHolder(fundId: string): Promise<string | null> {
    const row = (
      await this.db.query<{ holder_user_id: string }>(
        'SELECT holder_user_id FROM funds WHERE id=$1',
        [fundId],
      )
    ).rows[0];
    return row?.holder_user_id ?? null;
  }

  async list(fundId: string): Promise<BankTransferRow[]> {
    return (
      await this.db.query<BankTransferRow>(
        `SELECT ${columns} FROM bank_transfer_receipts WHERE fund_id=$1 ORDER BY received_at DESC,id DESC LIMIT 100`,
        [fundId],
      )
    ).rows;
  }
}
