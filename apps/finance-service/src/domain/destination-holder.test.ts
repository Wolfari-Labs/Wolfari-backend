import { describe, expect, it } from 'vitest';
import { destinationHolder, previousHolderReceiptAudit } from './destination-holder';
const fund = '10000000-0000-4000-8000-000000000001';
const previous = '20000000-0000-4000-8000-000000000001';
const current = '30000000-0000-4000-8000-000000000001';
const snapshot = {
  schema_version: 1,
  fund_id: fund,
  holder_user_id: previous,
  destination_id: current,
  destination_version: 1,
  destination_type: 'VIETQR',
  confirmed_by_holder_at: '2026-11-12T00:00:00Z',
  recipient: { bank_code: 'VCB', account_number: '001', account_name: 'TEST' },
};
describe('immutable previous Holder routing', () => {
  it('requires explicit receipt of money by a new Holder and audits no bank data', () => {
    expect(destinationHolder(snapshot, fund)).toBe(previous);
    expect(previousHolderReceiptAudit(previous, previous)).toEqual({});
    expect(() => previousHolderReceiptAudit(previous, current)).toThrow();
    expect(previousHolderReceiptAudit(previous, current, true)).toEqual({
      previous_holder_transfer_confirmed: true,
      previous_holder_user_id: previous,
      current_holder_user_id: current,
    });
  });
  it.each([
    null,
    {},
    { ...snapshot, fund_id: current },
    { ...snapshot, holder_user_id: 'invalid' },
    { ...snapshot, recipient: null },
    { ...snapshot, schema_version: 2 },
    { ...snapshot, destination_version: 0 },
  ])('fails closed on malformed stored snapshot %j', (value) => {
    expect(() => destinationHolder(value, fund)).toThrow();
  });
});
