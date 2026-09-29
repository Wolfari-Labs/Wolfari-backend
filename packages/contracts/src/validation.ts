const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONEY_PATTERN = /^(0|[1-9][0-9]*)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

export function assertUuid(value: string, field = 'value'): void {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${field} must be a UUID`);
}

export function assertMoney(value: string, field = 'money'): void {
  if (!MONEY_PATTERN.test(value) || BigInt(value) > MAX_SIGNED_BIGINT) {
    throw new TypeError(`${field} must be an unsigned decimal string within PostgreSQL bigint range`);
  }
}

export function assertCalendarDate(value: string, field = 'date'): void {
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new TypeError(`${field} must use YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new TypeError(`${field} must be a valid calendar date`);
  }
}

export function assertSpecifiedEnum(value: number | undefined, field = 'enum'): void {
  if (value === undefined || value === 0) throw new TypeError(`${field} must not be UNSPECIFIED`);
}
