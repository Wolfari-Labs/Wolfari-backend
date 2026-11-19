import { describe, expect, it } from 'vitest';
import { parseBankTransferResolution } from './bank-transfer.input';

const id = '10000000-0000-4000-8000-000000000001';
const valid = {
  operation_id: id,
  actor_user_id: id,
  fund_id: id,
  bank_transfer_id: id,
  resolution: 'HANDLED_IN_APP',
  note: '  Đã xác nhận tay khoản góp của An  ',
  expected_finance_version: 7,
};

describe('bank transfer resolution input', () => {
  it('accepts a known outcome, trims the note and keeps the Fund version', () => {
    expect(parseBankTransferResolution(valid)).toEqual({
      operationId: id,
      actor: id,
      fundId: id,
      transferId: id,
      resolution: 'HANDLED_IN_APP',
      note: 'Đã xác nhận tay khoản góp của An',
      expectedFinanceVersion: 7,
    });
  });

  it('rejects unknown outcomes, blank or oversized notes, bad ids and versions', () => {
    for (const change of [
      { resolution: 'MATCHED' },
      { note: '   ' },
      { note: 'x'.repeat(501) },
      { note: undefined },
      { operation_id: 'nope' },
      { bank_transfer_id: undefined },
      { expected_finance_version: 0 },
      { expected_finance_version: 1.5 },
      { expected_finance_version: '7' },
    ])
      expect(() => parseBankTransferResolution({ ...valid, ...change }), JSON.stringify(change)).toThrow(
        'VALIDATION_FAILED',
      );
  });
});
