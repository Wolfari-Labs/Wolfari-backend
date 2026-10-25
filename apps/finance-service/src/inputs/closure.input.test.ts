import { describe, expect, it } from 'vitest';
import {
  closureCursor,
  parseCancelClosure,
  parseClosurePage,
  parseConfirmClosure,
  parseCreateClosure,
  parseRemindClosure,
} from './closure.input';
const fund = '10000000-0000-4000-8000-000000000001';
const closure = '10000000-0000-4000-8000-000000000002';
describe('closure input', () => {
  it('parses strict create, confirm, cancel and remind bodies', () => {
    expect(parseCreateClosure({ expected_finance_version: 7 })).toEqual({
      expectedFinanceVersion: 7,
    });
    expect(parseConfirmClosure({ snapshot_hash: 'a'.repeat(64) })).toEqual({
      snapshotHash: 'a'.repeat(64),
    });
    expect(parseCancelClosure({ reason: '  Sửa số liệu  ' })).toEqual({ reason: 'Sửa số liệu' });
    expect(parseRemindClosure({})).toEqual({});
  });
  it.each([{}, { expected_finance_version: 0 }, { expected_finance_version: 1, extra: true }])(
    'rejects invalid create body %#',
    (value) => expect(() => parseCreateClosure(value)).toThrow(),
  );
  it.each(['A'.repeat(64), 'a'.repeat(63), 'z'.repeat(64), ''])('rejects hash %s', (hash) =>
    expect(() => parseConfirmClosure({ snapshot_hash: hash })).toThrow(),
  );
  it('binds a microsecond cursor to its Fund', () => {
    const cursor = closureCursor(
      { fundId: fund },
      { at: '2026-10-22T01:02:03.123456Z', id: closure },
    );
    expect(parseClosurePage({ fund_id: fund, cursor }).after).toEqual({
      at: '2026-10-22T01:02:03.123456Z',
      id: closure,
    });
    expect(() =>
      parseClosurePage({ fund_id: '20000000-0000-4000-8000-000000000001', cursor }),
    ).toThrow();
  });
});
