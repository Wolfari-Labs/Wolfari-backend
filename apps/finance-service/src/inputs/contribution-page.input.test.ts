import { describe, it, expect } from 'vitest';
import { contributionCursor, parseContributionPage } from './contribution-page.input';
const id = '10000000-0000-4000-8000-000000000001';
const scope = { kind: 'contributions' as const, fundId: id, status: 'CONFIRMED', memberId: id };
const after = { at: '2026-10-15T00:00:00.123456Z', id };
describe('Contribution paging inputs', () => {
  it('preserves six digits, binds endpoint/Fund/filters and normalizes UUID filters', () => {
    const cursor = contributionCursor(scope, after);
    expect(
      parseContributionPage('contributions', {
        fund_id: id,
        member_user_id: id.toUpperCase(),
        status: 'CONFIRMED',
        cursor,
      }).after,
    ).toEqual(after);
    for (const patch of [
      { status: 'PENDING' },
      { member_user_id: undefined },
      { fund_id: id.replace(/1$/, '2') },
    ])
      expect(() =>
        parseContributionPage('contributions', {
          fund_id: id,
          member_user_id: id,
          status: 'CONFIRMED',
          cursor,
          ...patch,
        }),
      ).toThrow('VALIDATION_FAILED');
    expect(() => parseContributionPage('requests', { fund_id: id, cursor })).toThrow(
      'VALIDATION_FAILED',
    );
  });
  it.each([0, 101, 1.5, '20', null, NaN])('rejects invalid limit %s', (limit) => {
    expect(() => parseContributionPage('requests', { fund_id: id, limit })).toThrow(
      'VALIDATION_FAILED',
    );
  });
  it.each([
    '',
    '%%%%',
    'a'.repeat(1025),
    Buffer.from('{}').toString('base64url'),
    Buffer.from(
      JSON.stringify([1, 'requests', id, null, null, '2026-02-30T00:00:00.000000Z', id]),
    ).toString('base64url'),
  ])('rejects malformed cursor', (cursor) => {
    expect(() => parseContributionPage('requests', { fund_id: id, cursor })).toThrow(
      'VALIDATION_FAILED',
    );
  });
  it('rejects noncanonical encoding, extra keys and invalid status, uses default and boundaries', () => {
    const cursor = contributionCursor(scope, after);
    expect(() =>
      parseContributionPage('contributions', { fund_id: id, cursor: cursor + '=' }),
    ).toThrow();
    expect(() => parseContributionPage('requests', { fund_id: id, status: 'PENDING' })).toThrow();
    expect(() =>
      parseContributionPage('contributions', { fund_id: id, status: 'pending' }),
    ).toThrow();
    for (const limit of [undefined, 1, 100])
      expect(parseContributionPage('requests', { fund_id: id, limit }).limit).toBe(limit ?? 20);
  });
});
