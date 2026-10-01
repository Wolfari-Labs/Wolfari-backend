import { describe, expect, it } from 'vitest';
import { formatVndAmount, parsePositiveVndAmount, parseVndAmount } from './money';

describe('VND money contract', () => {
  it('allows a zero budget or balance, but not a zero contribution, expense or refund', () => {
    expect(parseVndAmount('0')).toBe(0n);
    expect(formatVndAmount(0n)).toBe('0');
    expect(parsePositiveVndAmount('1')).toBe(1n);
    expect(() => parsePositiveVndAmount('0')).toThrow(RangeError);
    expect(() => parsePositiveVndAmount('000')).toThrow(RangeError);
  });

  it('accepts leading zeros permitted by the input contract and emits normalized digits', () => {
    expect(formatVndAmount(parsePositiveVndAmount('000150000'))).toBe('150000');
  });

  it('preserves exact amounts and arithmetic beyond the safe JavaScript number range', () => {
    const balance = parseVndAmount('9007199254740993');
    const expense = parsePositiveVndAmount('2');

    expect(formatVndAmount(balance)).toBe('9007199254740993');
    expect(formatVndAmount(balance - expense)).toBe('9007199254740991');
    expect(formatVndAmount(balance + expense)).toBe('9007199254740995');
  });

  it('round-trips the maximum PostgreSQL bigint and rejects overflow', () => {
    const maximum = parsePositiveVndAmount('9223372036854775807');

    expect(formatVndAmount(maximum)).toBe('9223372036854775807');
    expect(() => parseVndAmount('9223372036854775808')).toThrow(RangeError);
    expect(() => formatVndAmount(maximum + 1n)).toThrow(RangeError);
  });

  const invalidInputs = [
    '',
    ' ',
    ' 100',
    '100 ',
    '100\n',
    '100\r\n',
    '1\t00',
    '-1',
    '+1',
    '1.5',
    '1,000',
    '1e3',
    '0x10',
    'NaN',
    'Infinity',
    '１２３',
    100,
    100n,
    null,
    undefined,
    true,
    ['100'],
    { amount: '100' },
  ];

  it.each(invalidInputs.map((value) => ({ value })))(
    'rejects invalid API input $value',
    ({ value }) => {
      expect(() => parseVndAmount(value)).toThrow(TypeError);
      expect(() => parsePositiveVndAmount(value)).toThrow(TypeError);
    },
  );

  it('rejects a negative arithmetic result before serialization', () => {
    const result = parseVndAmount('100') - parsePositiveVndAmount('101');
    expect(() => formatVndAmount(result)).toThrow(RangeError);
  });

  it('serializes Money as a JSON string without losing precision', () => {
    const amount = parseVndAmount('9007199254740993');
    expect(JSON.stringify({ amount: formatVndAmount(amount) })).toBe(
      '{"amount":"9007199254740993"}',
    );
  });
});
