import { describe, expect, it } from 'vitest';
import { closureReadinessRoute, projectClosureReadiness } from './closure-http';

const id = '10000000-0000-4000-8000-000000000001';

describe('closure readiness HTTP (API133)', () => {
  it('matches only the readiness path of one fund', () => {
    expect(closureReadinessRoute(`/api/v1/funds/${id}/closure-readiness`)).toBe(id);
    expect(closureReadinessRoute(`/api/v1/funds/${id}/closure-readiness/x`)).toBeUndefined();
    expect(closureReadinessRoute(`/api/v1/funds/${id}/closures`)).toBeUndefined();
  });

  it('projects known blockers and omits zero proto3 defaults', () => {
    expect(
      projectClosureReadiness({
        fund_status: 'OPEN',
        current_balance: '150000',
        blockers: [
          { kind: 'CONTRIBUTIONS_OPEN', count: 2 },
          { kind: 'BALANCE_NOT_ZERO', count: 1 },
        ],
      }),
    ).toEqual({
      ready: false,
      fund_status: 'OPEN',
      current_balance: '150000',
      blockers: [
        { kind: 'CONTRIBUTIONS_OPEN', count: 2 },
        { kind: 'BALANCE_NOT_ZERO', count: 1 },
      ],
      bank_transfers_needing_review: 0,
    });
    expect(
      projectClosureReadiness({ ready: true, fund_status: 'OPEN', current_balance: '0' }),
    ).toMatchObject({ ready: true, blockers: [] });
  });

  it('rejects unknown kinds and a ready flag that contradicts the blockers', () => {
    expect(() =>
      projectClosureReadiness({
        fund_status: 'OPEN',
        current_balance: '0',
        blockers: [{ kind: 'SOMETHING_NEW', count: 1 }],
      }),
    ).toThrow();
    expect(() =>
      projectClosureReadiness({
        ready: true,
        fund_status: 'OPEN',
        current_balance: '0',
        blockers: [{ kind: 'EXPENSES_OPEN', count: 1 }],
      }),
    ).toThrow();
    expect(() =>
      projectClosureReadiness({ ready: true, fund_status: 'CLOSING', current_balance: '0' }),
    ).toThrow();
  });
});
