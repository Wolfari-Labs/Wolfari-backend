import { describe, expect, it, vi } from 'vitest';
import { PaymentDestinationRepository } from './payment-destination.repository';

const scope = {
  fundId: '40000000-0000-4000-8000-000000000001',
  destinationIds: ['50000000-0000-4000-8000-000000000001'],
};
const time = new Date('2026-10-01T00:00:00Z');
const row = {
  id: scope.destinationIds[0],
  fund_id: scope.fundId,
  destination_type: 'VIETQR',
  bank_code: 'TEST',
  account_number: '00000123',
  account_name: 'TEST HOLDER',
  momo_phone: null,
  is_default: true,
  active: true,
  version: 2,
  confirmed_by_holder_at: time,
  created_at: time,
  updated_at: time,
};

describe('PaymentDestinationRepository', () => {
  it('skips the database for an empty selection', async () => {
    const query = vi.fn();
    expect(
      await new PaymentDestinationRepository({ query }).findByIds({ ...scope, destinationIds: [] }),
    ).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns no fallback for absent or wrong-Fund IDs', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    expect(await new PaymentDestinationRepository({ query }).findByIds(scope)).toEqual([]);
  });

  it('preserves account strings, dates and version without copying unselected fields', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ...row, unexpected: 'not projected' }] });
    expect(await new PaymentDestinationRepository({ query }).findByIds(scope)).toEqual([
      {
        id: row.id,
        fundId: scope.fundId,
        destinationType: 'VIETQR',
        bankCode: 'TEST',
        accountNumber: '00000123',
        accountName: 'TEST HOLDER',
        momoPhone: null,
        isDefault: true,
        active: true,
        version: 2,
        confirmedByHolderAt: time,
        createdAt: time,
        updatedAt: time,
      },
    ]);
  });

  it('keeps nullable bank fields for a MoMo sandbox destination', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          ...row,
          destination_type: 'MOMO_SANDBOX',
          bank_code: null,
          account_number: null,
          account_name: null,
          momo_phone: '0900000000',
        },
      ],
    });
    expect((await new PaymentDestinationRepository({ query }).findByIds(scope))[0]).toMatchObject({
      destinationType: 'MOMO_SANDBOX',
      bankCode: null,
      accountNumber: null,
      accountName: null,
      momoPhone: '0900000000',
    });
  });

  it('retains inactive and unconfirmed configuration for domain validation', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ ...row, active: false, is_default: false, confirmed_by_holder_at: null }],
    });
    expect((await new PaymentDestinationRepository({ query }).findByIds(scope))[0]).toMatchObject({
      active: false,
      isDefault: false,
      confirmedByHolderAt: null,
    });
  });

  it('binds the Fund and selected IDs without interpolating them or mutating the input', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const ids = Object.freeze([scope.destinationIds[0], scope.destinationIds[0]]);
    await new PaymentDestinationRepository({ query }).findByIds({ ...scope, destinationIds: ids });
    expect(query).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('fund_id = $1 AND id = ANY($2::uuid[])'),
      [scope.fundId, ids],
    );
    expect(query.mock.calls[0][0]).not.toContain(scope.fundId);
    expect(query.mock.calls[0][1][1]).not.toBe(ids);
    expect(ids).toEqual([scope.destinationIds[0], scope.destinationIds[0]]);
  });

  it('propagates database errors instead of treating them as missing destinations', async () => {
    const failure = new Error('database unavailable');
    const query = vi.fn().mockRejectedValue(failure);
    await expect(new PaymentDestinationRepository({ query }).findByIds(scope)).rejects.toBe(
      failure,
    );
  });
});
