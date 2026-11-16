import { describe, expect, it } from 'vitest';
import {
  buildVietQrPayload,
  crc16CcittFalse,
  parseVietQrPayload,
  VietQrPayloadError,
} from './vietqr-payload';

// Real NAPAS payload used by the Android acceptance cases (Sacombank 970403, 180000 VND).
const sample =
  '00020101021238570010A00000072701270006970403011300110123456780208QRIBFTTA530370454061800005802VN62340107NPS68690819thanh toan don hang63042E2E';

describe('VietQR payload', () => {
  it('computes CRC-16/CCITT-FALSE exactly like bank apps and the mobile reader', () => {
    expect(crc16CcittFalse(sample.slice(0, -4))).toBe('2E2E');
    expect(crc16CcittFalse('123456789')).toBe('29B1');
    expect(() => crc16CcittFalse('tiền')).toThrow(RangeError);
  });
  it('builds a dynamic QRIBFTTA payload that the strict reader round-trips', () => {
    const transfer = {
      bankBin: '970436',
      accountNumber: '0011012345678',
      amount: '300000',
      addInfo: '0ABCDEFGHIJKLMNOPQRSTUVWX',
    };
    const payload = buildVietQrPayload(transfer);
    expect(payload).toMatch(/^000201010212/);
    expect(payload).toContain('0010A000000727');
    expect(payload).toContain('0006970436');
    expect(payload).toContain('01130011012345678');
    expect(payload).toContain('0208QRIBFTTA');
    expect(payload).toContain('5303704');
    expect(payload).toContain('5406300000');
    expect(payload).toContain('5802VN');
    expect(payload).toContain('62290825' + transfer.addInfo);
    expect(payload.slice(-8, -4)).toBe('6304');
    expect(parseVietQrPayload(payload)).toEqual(transfer);
  });
  it('rejects inputs a bank app could not transfer with', () => {
    const base = { bankBin: '970436', accountNumber: '001101', amount: '1', addInfo: 'A' };
    const cases: [Partial<typeof base>, VietQrPayloadError['field']][] = [
      [{ bankBin: '97043' }, 'bank_bin'],
      [{ accountNumber: '0011 0123' }, 'account_number'],
      [{ accountNumber: 'A'.repeat(20) }, 'account_number'],
      [{ amount: '0' }, 'amount'],
      [{ amount: '10000000000000' }, 'amount'],
      [{ amount: '1.5' }, 'amount'],
      [{ addInfo: 'tiền quỹ' }, 'add_info'],
      [{ addInfo: ' A' }, 'add_info'],
      [{ addInfo: 'A'.repeat(26) }, 'add_info'],
    ];
    for (const [patch, field] of cases)
      expect(() => buildVietQrPayload({ ...base, ...patch }), JSON.stringify(patch)).toThrow(
        expect.objectContaining({ field }),
      );
  });
  it('fails closed on damaged, foreign or extended payloads', () => {
    const payload = buildVietQrPayload({
      bankBin: '970436',
      accountNumber: '001101',
      amount: '1',
      addInfo: 'A',
    });
    expect(parseVietQrPayload(payload.slice(0, -1) + 'F')).toBeUndefined();
    expect(parseVietQrPayload(payload.replace('5802VN', '5802VX'))).toBeUndefined();
    // The acceptance sample carries a bill number (62-01) this platform never emits.
    expect(parseVietQrPayload(sample)).toBeUndefined();
    expect(parseVietQrPayload('')).toBeUndefined();
    expect(parseVietQrPayload(`${'0'.repeat(600)}`)).toBeUndefined();
  });
});
