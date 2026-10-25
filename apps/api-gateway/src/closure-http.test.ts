import { describe, expect, it } from 'vitest';
import { closureRoute, projectClosure } from './closure-http';
const id = '10000000-0000-4000-8000-000000000001';
describe('closure HTTP', () => {
  it('recognizes API120-125 without accepting extra segments', () => {
    expect(closureRoute(`/api/v1/funds/${id}/closures`)).toEqual({
      kind: 'collection',
      fundId: id,
    });
    expect(closureRoute(`/api/v1/closures/${id}`)).toEqual({
      kind: 'item',
      closureId: id,
      action: undefined,
    });
    for (const action of ['confirm', 'cancel', 'remind'])
      expect(closureRoute(`/api/v1/closures/${id}/${action}`)).toEqual({
        kind: 'item',
        closureId: id,
        action,
      });
    expect(closureRoute(`/api/v1/closures/${id}/confirm/extra`)).toBeUndefined();
  });
  it('projects only a consistent public snapshot and confirmation set', () => {
    const snapshot = {
      schema_version: 1,
      fund: {
        id,
        trip_id: id,
        holder_user_id: id,
        currency: 'VND',
        budget_amount: null,
        current_balance: '0',
        finance_version: 2,
      },
      required_user_ids: [id],
      contribution_requests: [],
      contributions: [],
      expenses: [],
      financial_notes: [],
      refunds: [],
      ledger: [],
    };
    const value = projectClosure({
      id,
      fund_id: id,
      requested_by_user_id: id,
      status: 'PENDING_CONFIRMATIONS',
      snapshot_finance_version: 2,
      snapshot_schema_version: 1,
      snapshot_json: JSON.stringify(snapshot),
      snapshot_hash: 'a'.repeat(64),
      requested_at: { seconds: '1', nanos: 0 },
      confirmations: [{ user_id: id }],
      finance_version: 2,
    });
    expect(value.snapshot).toMatchObject({ schema_version: 1, ledger: [] });
    expect(value.confirmations).toEqual([{ user_id: id, confirmed_at: null }]);
    expect(() =>
      projectClosure({
        id,
        fund_id: id,
        requested_by_user_id: id,
        status: 'PENDING_CONFIRMATIONS',
        snapshot_finance_version: 2,
        snapshot_schema_version: 1,
        snapshot_json: JSON.stringify({ ...snapshot, account_number: 'private' }),
        snapshot_hash: 'a'.repeat(64),
        requested_at: { seconds: '1', nanos: 0 },
        confirmations: [{ user_id: id }],
        finance_version: 2,
      }),
    ).toThrow('Invalid closure snapshot');
    expect(() =>
      projectClosure({
        id,
        fund_id: id,
        requested_by_user_id: id,
        status: 'PENDING_CONFIRMATIONS',
        snapshot_finance_version: 2,
        snapshot_schema_version: 1,
        snapshot_json: JSON.stringify({
          ...snapshot,
          fund: { ...snapshot.fund, finance_version: 3 },
        }),
        snapshot_hash: 'a'.repeat(64),
        requested_at: { seconds: '1', nanos: 0 },
        confirmations: [{ user_id: id }],
        finance_version: 2,
      }),
    ).toThrow('Closure snapshot mismatch');
  });
});
