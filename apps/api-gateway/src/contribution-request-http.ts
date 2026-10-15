import {
  onlyKeys,
  RequestError,
  responseRecord,
  requiredString,
  requiredInteger,
  timestampToIso,
  uuid,
} from './trip-http';

/** Reject JSON types/unknown fields before protobuf can coerce or discard them. */
export function validateContributionRequestBody(body: Record<string, unknown>): void {
  onlyKeys(body, ['title', 'contributions', 'due_at', 'note', 'expected_finance_version']);
  if (
    typeof body.title !== 'string' ||
    !body.title.trim() ||
    [...body.title].length > 200 ||
    body.title.includes('\u0000')
  )
    throw new RequestError('Invalid title');
  for (const key of ['due_at', 'note'])
    if (Object.hasOwn(body, key) && typeof body[key] !== 'string')
      throw new RequestError('Invalid optional field');
  if (!Array.isArray(body.contributions) || !body.contributions.length)
    throw new RequestError('Empty allocations');
  const members = new Set<string>();
  for (const raw of body.contributions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new RequestError('Invalid allocation');
    const row = raw as Record<string, unknown>;
    onlyKeys(row, ['member_user_id', 'amount', 'destination_id']);
    for (const key of ['member_user_id', 'destination_id'])
      if (typeof row[key] !== 'string' || !uuid.test(row[key]))
        throw new RequestError('Invalid ID');
    const member = (row.member_user_id as string).toLowerCase();
    if (members.has(member)) throw new RequestError('Duplicate member');
    members.add(member);
    if (typeof row.amount !== 'string' || !row.amount.length || /[^0-9]/u.test(row.amount))
      throw new RequestError('Invalid amount');
    const canonical = row.amount.replace(/^0+/, '');
    if (!canonical || canonical.length > 19 || BigInt(canonical) > 9223372036854775807n)
      throw new RequestError('Invalid amount');
  }
}
export const contributionStatuses = [
  'PENDING',
  'TRANSFER_REPORTED',
  'CONFIRMED',
  'WAIVED',
  'CANCELLED',
  'REVERSED',
] as const;
const identifier = (value: unknown) => {
  const result = requiredString(value);
  if (!uuid.test(result)) throw new Error('Invalid ID');
  return result;
};
const versionNumber = (value: unknown) => {
  const result = requiredInteger(value);
  if (result > 2147483647) throw new Error('Invalid version');
  return result;
};
const money = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new Error('Invalid amount');
  return value;
};
const nullableTime = (value: unknown) => (value === undefined ? null : timestampToIso(value));
const nullableString = (value: unknown) => (value === undefined ? null : requiredString(value));
export function projectContribution(value: unknown) {
  const row = responseRecord(value);
  if (
    !contributionStatuses.includes(row.status as (typeof contributionStatuses)[number]) ||
    typeof row.self_contribution !== 'boolean'
  )
    throw new Error('Invalid contribution');
  return {
    id: identifier(row.id),
    request_id: identifier(row.request_id),
    fund_id: identifier(row.fund_id),
    member_user_id: identifier(row.member_user_id),
    amount: money(row.amount),
    status: row.status as string,
    self_contribution: row.self_contribution,
    version: versionNumber(row.version),
    finance_version: versionNumber(row.finance_version),
    member_reported_at: nullableTime(row.member_reported_at),
    confirmed_at: nullableTime(row.confirmed_at),
    confirmed_by_user_id:
      row.confirmed_by_user_id === undefined ? null : identifier(row.confirmed_by_user_id),
    waived_reason: nullableString(row.waived_reason),
    cancelled_reason: nullableString(row.cancelled_reason),
  };
}
export function projectContributionRequest(value: unknown, created = true) {
  const row = responseRecord(value);
  const id = (value: unknown) => {
    const result = requiredString(value);
    if (!uuid.test(result)) throw new Error('Invalid ID');
    return result;
  };
  const version = versionNumber(row.version);
  const title = requiredString(row.title);
  if (
    (created &&
      (version !== 1 ||
        row.status !== 'OPEN' ||
        row.amount_per_member !== undefined ||
        row.closed_at !== undefined)) ||
    !['OPEN', 'CLOSED', 'CANCELLED'].includes(String(row.status)) ||
    !title.trim() ||
    [...title].length > 200 ||
    title.includes('\u0000') ||
    (row.note !== undefined && typeof row.note !== 'string')
  )
    throw new Error('Invalid new request');
  // Legacy receipts have neither field. Never synthesize historical allocations from live rows.
  const legacy = created && row.finance_version === undefined && row.contributions === undefined;
  const financeVersion = legacy ? undefined : versionNumber(row.finance_version);
  const raw = row.contributions ?? [];
  if (!Array.isArray(raw) || (!legacy && created && !raw.length))
    throw new Error('Invalid allocations');
  const contributions = raw.map(projectContribution);
  if (
    new Set(contributions.map((c) => c.id)).size !== contributions.length ||
    new Set(contributions.map((c) => c.member_user_id)).size !== contributions.length ||
    contributions.some(
      (c) =>
        c.fund_id !== row.fund_id ||
        c.request_id !== row.id ||
        c.finance_version !== financeVersion ||
        (created &&
          (c.status !== 'PENDING' ||
            c.version !== 1 ||
            c.member_reported_at !== null ||
            c.confirmed_at !== null ||
            c.confirmed_by_user_id !== null ||
            c.waived_reason !== null ||
            c.cancelled_reason !== null)),
    )
  )
    throw new Error('Allocation scope mismatch');
  return {
    id: id(row.id),
    fund_id: id(row.fund_id),
    title,
    status: row.status as string,
    version,
    created_by_user_id: id(row.created_by_user_id),
    created_at: timestampToIso(row.created_at),
    due_at: row.due_at === undefined ? null : timestampToIso(row.due_at),
    note: row.note ?? null,
    amount_per_member: row.amount_per_member === undefined ? null : money(row.amount_per_member),
    closed_at: nullableTime(row.closed_at),
    ...(legacy ? {} : { contributions, finance_version: financeVersion }),
  };
}

export function contributionPageQuery(url: URL, requests: boolean) {
  const raw = url.searchParams.get('limit');
  if (raw !== null && !/^(?:[1-9][0-9]?|100)$/.test(raw)) throw new RequestError('Invalid limit');
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null && (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 1024))
    throw new RequestError('Invalid cursor');
  const status = url.searchParams.get('status'),
    member = url.searchParams.get('member_user_id');
  if (
    !requests &&
    ((status !== null &&
      !contributionStatuses.includes(status as (typeof contributionStatuses)[number])) ||
      (member !== null && !uuid.test(member)))
  )
    throw new RequestError('Invalid filter');
  return {
    ...(raw === null ? {} : { limit: Number(raw) }),
    ...(cursor === null ? {} : { cursor }),
    ...(status === null ? {} : { status }),
    ...(member === null ? {} : { member_user_id: member.toLowerCase() }),
  };
}
export function projectContributionPage(
  value: unknown,
  fundId: string,
  requests: boolean,
  query: { limit?: number; status?: string; member_user_id?: string },
) {
  const result = responseRecord(value),
    raw = result.items ?? [];
  if (!Array.isArray(raw) || raw.length > (query.limit ?? 20)) throw new Error('Invalid page');
  const items = raw.map((row) =>
    requests ? projectContributionRequest(row, false) : projectContribution(row),
  );
  if (
    new Set(items.map((row) => row.id)).size !== items.length ||
    items.some(
      (row) =>
        row.fund_id !== fundId ||
        (query.status !== undefined && row.status !== query.status) ||
        (query.member_user_id !== undefined &&
          (!('member_user_id' in row) || row.member_user_id !== query.member_user_id)) ||
        row.finance_version !== items[0]?.finance_version,
    )
  )
    throw new Error('Page scope mismatch');
  const cursor = result.next_cursor;
  if (
    cursor !== undefined &&
    (typeof cursor !== 'string' ||
      cursor.length > 1024 ||
      !/^[A-Za-z0-9_-]+$/.test(cursor) ||
      !items.length)
  )
    throw new Error('Invalid cursor');
  return { items, next_cursor: cursor ?? null };
}
