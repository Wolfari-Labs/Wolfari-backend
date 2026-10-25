import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { PaymentInstructionService } from './payment-instruction.service';
import { paymentInstruction, type PaymentInstructionRow } from '../domain/payment-instruction';
import { projectPaymentInstruction } from '../../../api-gateway/src/payment-instruction-http';

const id = '10000000-0000-4000-8000-000000000001';
function fixture(): PaymentInstructionRow {
  return {
    id,
    fund_id: id,
    trip_id: id,
    member_user_id: id,
    holder_user_id: id,
    amount: '300000',
    currency: 'VND',
    status: 'PENDING',
    fund_status: 'OPEN',
    request_status: 'OPEN',
    destination_version: 2,
    blocked_payment: false,
    destination_snapshot: {
      schema_version: 1,
      fund_id: id,
      destination_id: id,
      destination_version: 2,
      holder_user_id: id,
      confirmed_by_holder_at: '2026-10-22T00:00:00Z',
      destination_type: 'VIETQR',
      recipient: { bank_code: 'VCB', account_number: '0001234567', account_name: 'TEST A & B' },
    },
  };
}
describe('Private TEST payment instruction', () => {
  it('keeps leading zeroes, encodes text, emits a unique full UUID reference and whitelists HTTP fields', () => {
    const row = fixture(),
      original = structuredClone(row);
    const value = paymentInstruction(row),
      url = new URL(value.qr_url);
    expect(value.bank_bin).toBe('970436');
    expect(value.account_number).toBe('0001234567');
    expect(url.searchParams.get('accountName')).toBe('TEST A & B');
    expect(url.searchParams.get('amount')).toBe('300000');
    expect(value.reference).toMatch(/^[A-Z0-9]{25}$/);
    expect(
      paymentInstruction({ ...row, id: '10000000-0000-4000-8000-000000000002' }).reference,
    ).not.toBe(value.reference);
    expect(paymentInstruction(row)).toEqual(value);
    expect(row).toEqual(original);
    expect(
      projectPaymentInstruction(
        { ...value, destination_snapshot: {}, evidence_object_key: 'secret' },
        id,
      ),
    ).toEqual(value);
    expect(() =>
      projectPaymentInstruction({ ...value, qr_url: 'https://evil.test/' }, id),
    ).toThrow();
    expect(() => projectPaymentInstruction({ ...value, environment: 'PRODUCTION' }, id)).toThrow();
  });
  it.each(['TRANSFER_REPORTED', 'CONFIRMED', 'WAIVED', 'CANCELLED', 'REVERSED'])(
    'blocks %s',
    (status) => {
      expect(() => paymentInstruction({ ...fixture(), status })).toThrow('STATE_CONFLICT');
    },
  );
  it.each([
    { fund_status: 'CLOSING' },
    { request_status: 'CLOSED' },
    { blocked_payment: true },
    { holder_user_id: '20000000-0000-4000-8000-000000000001' },
    { amount: '9007199254740993' },
  ])('blocks unusable instruction %j', (change) => {
    expect(() => paymentInstruction({ ...fixture(), ...change })).toThrow('STATE_CONFLICT');
  });
  it.each([
    { schema_version: 2 },
    { fund_id: 'wrong' },
    { destination_version: 3 },
    { confirmed_by_holder_at: 'bad' },
  ])('rejects corrupt snapshot %j', (change) => {
    const row = fixture();
    row.destination_snapshot = { ...(row.destination_snapshot as object), ...change };
    expect(() => paymentInstruction(row)).toThrow('SERVICE_UNAVAILABLE');
  });
  it.each([
    { bank_code: 'TEST' },
    { account_number: '12345678901234567890' },
    { account_number: '../abc' },
  ])('does not guess/truncate account or bank %j', (change) => {
    const row = fixture();
    const snapshot = row.destination_snapshot as { recipient: object };
    snapshot.recipient = { ...snapshot.recipient, ...change };
    expect(() => paymentInstruction(row)).toThrow('STATE_CONFLICT');
  });
  it('does not fabricate a MoMo link', () => {
    const row = fixture();
    row.destination_snapshot = {
      ...(row.destination_snapshot as object),
      destination_type: 'MOMO_SANDBOX',
    };
    expect(() => paymentInstruction(row)).toThrow('STATE_CONFLICT');
  });
  it('reads private data only after current permission, then rechecks scope and deadline', async () => {
    const auth = { authorizePaymentInstruction: vi.fn().mockResolvedValue(undefined) };
    const rows = {
      scope: vi.fn().mockResolvedValue({ fund_id: id }),
      read: vi.fn().mockResolvedValue(fixture()),
    };
    const service = new PaymentInstructionService(auth, rows);
    const input = { contribution_id: id, actor_user_id: id };
    expect((await service.get(input, id, Date.now() + 1000)).instruction.amount).toBe('300000');
    expect(auth.authorizePaymentInstruction.mock.invocationCallOrder[0]).toBeLessThan(
      rows.read.mock.invocationCallOrder[0]!,
    );
    auth.authorizePaymentInstruction.mockRejectedValueOnce(new Error('revoked'));
    await expect(service.get(input, id, Date.now() + 1000)).rejects.toThrow('revoked');
    expect(rows.read).toHaveBeenCalledTimes(1);
    rows.scope.mockResolvedValueOnce(undefined);
    await expect(service.get(input, id, Date.now() + 1000)).rejects.toThrow('RESOURCE_NOT_FOUND');
    rows.read.mockResolvedValueOnce({ ...fixture(), member_user_id: 'other' });
    await expect(service.get(input, id, Date.now() + 1000)).rejects.toThrow('RESOURCE_NOT_FOUND');
    await expect(service.get(input, id, Date.now() - 1)).rejects.toThrow('SERVICE_UNAVAILABLE');
  });
});
