import {
  assertValidContributionRequestMetadata,
  type CreateContributionRequestCommand,
} from '../domain/contribution-request-creation';
import { InvalidContributionRequestError } from '../domain/contribution-request';
import { parsePositiveVndAmount } from '../domain/money';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Same instant profile as Trip: explicit offset, seconds and up to nine fractional digits.
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export class ContributionRequestInputError extends Error {
  constructor(public readonly field: string) {
    super(`Invalid contribution request field: ${field}`);
    this.name = 'ContributionRequestInputError';
  }
}

function invalid(field: string): never {
  throw new ContributionRequestInputError(field);
}

function object(
  value: unknown,
  allowed: readonly string[],
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid(field);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid(field);
  if (Object.keys(value).some((key) => !allowed.includes(key))) return invalid(field);
  return value as Record<string, unknown>;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) return invalid(field);
  return value.toLowerCase();
}

function instant(value: unknown): Date {
  if (typeof value !== 'string') return invalid('due_at');
  const match = INSTANT.exec(value);
  if (!match || match[0] !== value) return invalid('due_at');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59 ||
    Number(match[10] ?? 0) > 23 ||
    Number(match[11] ?? 0) > 59
  )
    return invalid('due_at');
  // Date keeps milliseconds, matching the current internal command/Trip representation.
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return invalid('due_at');
  return parsed;
}

/**
 * Parse the API078 JSON BODY only. Omitted optional fields become internal nulls;
 * explicit JSON null is not allowed by the published schema. No auth or database access.
 * The future adapter validates the Fund path ID, authenticated identity and idempotency
 * headers separately, then uses assertCanCreateContributionRequest with trusted context.
 */
export function parseCreateContributionRequestInput(
  input: unknown,
): CreateContributionRequestCommand {
  const body = object(
    input,
    ['title', 'contributions', 'due_at', 'note', 'expected_finance_version'],
    'body',
  );
  if (typeof body.title !== 'string') return invalid('title');
  const version = body.expected_finance_version;
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > 2147483647
  ) {
    return invalid('expected_finance_version');
  }
  let note: string | null = null;
  if (Object.hasOwn(body, 'note')) {
    if (typeof body.note !== 'string') return invalid('note');
    note = body.note;
  }
  const dueAt = Object.hasOwn(body, 'due_at') ? instant(body.due_at) : null;
  const metadata = { title: body.title, note, dueAt };
  try {
    assertValidContributionRequestMetadata(metadata);
  } catch (error) {
    if (error instanceof InvalidContributionRequestError) return invalid('metadata');
    throw error;
  }
  if (!Array.isArray(body.contributions) || body.contributions.length === 0)
    return invalid('contributions');
  const members = new Set<string>();
  const contributions: CreateContributionRequestCommand['contributions'][number][] = [];
  for (const [index, raw] of body.contributions.entries()) {
    const field = `contributions[${index}]`;
    const item = object(raw, ['member_user_id', 'amount', 'destination_id'], field);
    const memberUserId = uuid(item.member_user_id, `${field}.member_user_id`);
    const destinationId = uuid(item.destination_id, `${field}.destination_id`);
    if (members.has(memberUserId)) return invalid(`${field}.member_user_id`);
    members.add(memberUserId);
    let amount: bigint;
    try {
      amount = parsePositiveVndAmount(item.amount);
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError)
        return invalid(`${field}.amount`);
      throw error;
    }
    contributions.push({ memberUserId, destinationId, amount });
  }
  return { ...metadata, expectedFinanceVersion: version, contributions };
}
