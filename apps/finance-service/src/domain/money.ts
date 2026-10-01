// Money contract: integer VND, stored as PostgreSQL bigint and sent as JSON strings.
const MAX_VND_AMOUNT = 9_223_372_036_854_775_807n;

/** Validate an internal amount, including the result of bigint arithmetic. */
export function assertVndAmount(amount: bigint): void {
  if (typeof amount !== 'bigint') {
    throw new TypeError('VND amount must be a bigint');
  }
  if (amount < 0n || amount > MAX_VND_AMOUNT) {
    throw new RangeError('VND amount must be between 0 and 9223372036854775807');
  }
}

/** Parse a non-negative amount, including a zero budget or balance. */
export function parseVndAmount(value: unknown): bigint {
  // Reject whitespace (including trailing newlines), signs, decimals and JSON numbers.
  if (typeof value !== 'string' || value.length === 0 || /[^0-9]/u.test(value)) {
    throw new TypeError('VND amount must be a string containing only decimal digits');
  }

  const amount = BigInt(value);
  assertVndAmount(amount);
  return amount;
}

/** Contributions, expenses and refunds require an amount greater than zero. */
export function parsePositiveVndAmount(value: unknown): bigint {
  const amount = parseVndAmount(value);
  if (amount === 0n) {
    throw new RangeError('VND amount must be greater than zero');
  }
  return amount;
}

/** Convert an amount to a JSON-safe string; also check the result of arithmetic. */
export function formatVndAmount(amount: bigint): string {
  assertVndAmount(amount);
  return amount.toString();
}
