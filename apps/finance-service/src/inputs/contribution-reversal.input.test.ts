import { describe, expect, it } from 'vitest';
import {
  ContributionReversalInputError,
  parseContributionReversalInput,
} from './contribution-reversal.input';

const valid = {
  reason: '  Ghi nhận nhầm khoản thu  ',
  expected_version: 3,
  expected_finance_version: 7,
};

describe('contribution reversal input', () => {
  it('normalizes the reason and preserves integer versions', () => {
    expect(parseContributionReversalInput(valid)).toEqual({
      reason: 'Ghi nhận nhầm khoản thu',
      expectedVersion: 3,
      expectedFinanceVersion: 7,
    });
  });

  it.each([
    {},
    { ...valid, reason: '' },
    { ...valid, reason: ' \n ' },
    { ...valid, reason: 'a\0b' },
    { ...valid, reason: 'x'.repeat(1025) },
    { ...valid, expected_version: 0 },
    { ...valid, expected_finance_version: 1.5 },
    { ...valid, amount: '1' },
  ])('rejects malformed or extra fields %#', (value) => {
    expect(() => parseContributionReversalInput(value)).toThrow(ContributionReversalInputError);
  });
});
