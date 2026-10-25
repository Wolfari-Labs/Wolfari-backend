import { FinanceReadError, readUuid, UUID } from '../finance.errors';

export const contributionStatuses = [
  'PENDING',
  'TRANSFER_REPORTED',
  'CONFIRMED',
  'WAIVED',
  'CANCELLED',
  'REVERSED',
] as const;
export type ContributionPageScope = {
  kind: 'requests' | 'contributions';
  fundId: string;
  status?: string;
  memberId?: string;
};
export type ContributionPage = ContributionPageScope & {
  limit: number;
  after?: { at: string; id: string };
};
const invalid = (): never => {
  throw new FinanceReadError('VALIDATION_FAILED');
};
// Retain PostgreSQL microseconds: Date alone would lose rows within the same millisecond.
function validInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value))
    return false;
  const ms = value.slice(0, 23) + 'Z';
  const date = new Date(ms);
  return (
    Number(value.slice(0, 4)) > 0 && Number.isFinite(date.getTime()) && date.toISOString() === ms
  );
}
export function contributionCursor(
  scope: ContributionPageScope,
  after: { at: string; id: string },
): string {
  if (!validInstant(after.at) || !UUID.test(after.id)) throw new Error('Invalid database cursor');
  return Buffer.from(
    JSON.stringify([
      1,
      scope.kind,
      scope.fundId,
      scope.status ?? null,
      scope.memberId ?? null,
      after.at,
      after.id,
    ]),
  ).toString('base64url');
}
export function parseContributionPage(
  kind: ContributionPageScope['kind'],
  input: {
    fund_id?: unknown;
    limit?: unknown;
    cursor?: unknown;
    status?: unknown;
    member_user_id?: unknown;
  },
): ContributionPage {
  const fundId = readUuid(input.fund_id);
  const limit = input.limit === undefined ? 20 : input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) invalid();
  if (
    input.status !== undefined &&
    (typeof input.status !== 'string' ||
      !contributionStatuses.includes(input.status as (typeof contributionStatuses)[number]))
  )
    invalid();
  if (kind === 'requests' && (input.status !== undefined || input.member_user_id !== undefined))
    invalid();
  const scope: ContributionPageScope = {
    kind,
    fundId,
    status: input.status as string | undefined,
    memberId: input.member_user_id === undefined ? undefined : readUuid(input.member_user_id),
  };
  let after: ContributionPage['after'];
  if (input.cursor !== undefined) {
    if (
      typeof input.cursor !== 'string' ||
      input.cursor.length > 1024 ||
      !/^[A-Za-z0-9_-]+$/.test(input.cursor)
    )
      invalid();
    try {
      const raw: unknown = JSON.parse(
        Buffer.from(input.cursor as string, 'base64url').toString('utf8'),
      );
      if (
        !Array.isArray(raw) ||
        raw.length !== 7 ||
        !validInstant(raw[5]) ||
        typeof raw[6] !== 'string' ||
        !UUID.test(raw[6]) ||
        raw[6] !== raw[6].toLowerCase()
      )
        return invalid();
      after = { at: raw[5] as string, id: raw[6] as string };
      if (contributionCursor(scope, after) !== input.cursor) invalid();
    } catch {
      invalid();
    }
  }
  return { ...scope, limit: limit as number, after };
}
