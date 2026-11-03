import { Inject, Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import { FinanceReadError } from '../finance.errors';
import { contributionCursor, type ContributionPage } from '../inputs/contribution-page.input';
import type {
  ContributionReadRow,
  ContributionRequestReadRow,
} from '../projections/contribution-response';

// Explicit public SQL columns. Rejection feedback is readable; bank snapshots/evidence remain private.
const contributionColumns = `c.id,c.request_id,c.fund_id,c.member_user_id,c.amount::text,c.status,
 c.self_contribution,c.member_reported_at,c.confirmed_at,c.confirmed_by_user_id,
 c.waived_reason,c.cancelled_reason,c.rejected_reason,c.version`;
const instant = `to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
@Injectable()
export class ContributionListRepository {
  constructor(@Inject(DatabaseProvider) private readonly db: Pick<DatabaseProvider, 'query'>) {}

  async list(page: ContributionPage): Promise<{
    financeVersion: number;
    items: (ContributionRequestReadRow | ContributionReadRow)[];
    nextCursor?: string;
  }> {
    const requests = page.kind === 'requests';
    // Table and SQL fragments are chosen from constants, never from user text.
    const table = requests ? 'contribution_requests' : 'contributions';
    const result = await this.db.query<{
      finance_version: number;
      items: { row: ContributionRequestReadRow | ContributionReadRow; at: string; id: string }[];
    }>(
      `WITH page AS (
      SELECT p.id,p.created_at FROM ${table} p WHERE p.fund_id=$1
        AND ($2::timestamptz IS NULL OR (p.created_at,p.id)<($2::timestamptz,$3::uuid))
        ${requests ? '' : 'AND ($5::text IS NULL OR p.status=$5) AND ($6::uuid IS NULL OR p.member_user_id=$6)'}
      ORDER BY p.created_at DESC,p.id DESC LIMIT $4
    ), public_rows AS (
      ${
        requests
          ? `SELECT r.id,r.fund_id,r.title,r.due_at,r.note,r.status,r.version,r.created_by_user_id,
        r.created_at,r.closed_at,r.amount_per_member::text,
        COALESCE((SELECT jsonb_agg(to_jsonb(public_c) ORDER BY public_c.id) FROM
          (SELECT ${contributionColumns} FROM contributions c WHERE c.request_id=r.id AND c.fund_id=$1) public_c),'[]'::jsonb) AS contributions
        FROM contribution_requests r JOIN page p ON p.id=r.id`
          : `SELECT ${contributionColumns} FROM contributions c JOIN page p ON p.id=c.id`
      }
    ) SELECT f.finance_version,COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'row',to_jsonb(r),'at',${instant},'id',p.id) ORDER BY p.created_at DESC,p.id DESC)
      FROM page p JOIN public_rows r ON r.id=p.id),'[]'::jsonb) AS items
      FROM funds f WHERE f.id=$1`,
      requests
        ? [page.fundId, page.after?.at ?? null, page.after?.id ?? null, page.limit + 1]
        : [
            page.fundId,
            page.after?.at ?? null,
            page.after?.id ?? null,
            page.limit + 1,
            page.status ?? null,
            page.memberId ?? null,
          ],
    );
    const row = result.rows[0];
    if (!row) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const items = row.items.slice(0, page.limit);
    const last = items.at(-1);
    return {
      financeVersion: row.finance_version,
      items: items.map((item) => item.row),
      nextCursor:
        row.items.length > page.limit && last ? contributionCursor(page, last) : undefined,
    };
  }
}
