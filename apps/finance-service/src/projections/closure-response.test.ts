import { describe, expect, it } from 'vitest';
import { closureResponse } from './closure-response';
const id = '10000000-0000-4000-8000-000000000001';
describe('closure response', () => {
  it('returns immutable JSON as a string and preserves pending confirmations', () => {
    const value = closureResponse(
      {
        id,
        fund_id: id,
        requested_by_user_id: id,
        status: 'PENDING_CONFIRMATIONS',
        snapshot_finance_version: 4,
        snapshot_schema_version: 1,
        snapshot_json: { schema_version: 1, required_user_ids: [id] },
        snapshot_hash: 'a'.repeat(64),
        requested_at: '2026-10-22T00:00:00.000Z',
        cancelled_at: null,
        cancelled_reason: null,
        closed_at: null,
      },
      [{ user_id: id, confirmed_at: null }],
      4,
    );
    expect(JSON.parse(value.snapshot_json!)).toMatchObject({ schema_version: 1 });
    expect(value.confirmations).toEqual([{ user_id: id, confirmed_at: undefined }]);
    expect(value.cancelled_at).toBeUndefined();
  });
});
