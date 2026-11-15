// NAPAS VietQR (EMVCo merchant-presented QR) payload for account transfers, service QRIBFTTA.
// Shared by Finance (builder) and the Gateway (fail-closed reader). Printable ASCII only, so one
// character is one byte; TLV = 2-digit id, 2-digit length, value. The CRC (ID 63) is
// CRC-16/CCITT-FALSE over everything up to and including the literal "6304". The CRC detects a
// damaged code; it does not authenticate a recipient or prove any payment.

export const NAPAS_AID = 'A000000727';
export const VIETQR_ACCOUNT_SERVICE = 'QRIBFTTA';
/** NAPAS account identifier: up to 19 letters/digits. */
export const VIETQR_ACCOUNT = /^[A-Za-z0-9]{1,19}$/;
/** Whole VND, no separators, at most 13 digits (EMVCo transaction amount). */
export const VIETQR_AMOUNT = /^[1-9][0-9]{0,12}$/;
/** Transfer content that every Vietnamese bank app forwards unchanged: ASCII letters, digits, spaces, ≤25. */
export const VIETQR_ADD_INFO = /^[A-Za-z0-9](?:[A-Za-z0-9 ]{0,23}[A-Za-z0-9])?$/;

export type VietQrTransfer = Readonly<{
  bankBin: string;
  accountNumber: string;
  amount: string;
  addInfo: string;
}>;

export class VietQrPayloadError extends Error {
  constructor(public readonly field: 'bank_bin' | 'account_number' | 'amount' | 'add_info') {
    super(`Invalid VietQR ${field}`);
    this.name = 'VietQrPayloadError';
  }
}

function tlv(id: string, value: string): string {
  // Lengths above 99 cannot occur with the validated inputs; guard anyway so a bug fails closed.
  if (!value.length || value.length > 99) throw new RangeError('VietQR TLV length');
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

export function crc16CcittFalse(text: string): string {
  let crc = 0xffff;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) throw new RangeError('VietQR payload must be printable ASCII');
    crc ^= code << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Dynamic (single-use) QRIBFTTA payload with a fixed amount and transfer content. */
export function buildVietQrPayload(transfer: VietQrTransfer): string {
  if (!/^[0-9]{6}$/.test(transfer.bankBin)) throw new VietQrPayloadError('bank_bin');
  if (!VIETQR_ACCOUNT.test(transfer.accountNumber)) throw new VietQrPayloadError('account_number');
  if (!VIETQR_AMOUNT.test(transfer.amount)) throw new VietQrPayloadError('amount');
  if (!VIETQR_ADD_INFO.test(transfer.addInfo)) throw new VietQrPayloadError('add_info');
  const beneficiary = tlv('00', transfer.bankBin) + tlv('01', transfer.accountNumber);
  const merchant =
    tlv('00', NAPAS_AID) + tlv('01', beneficiary) + tlv('02', VIETQR_ACCOUNT_SERVICE);
  const body =
    tlv('00', '01') +
    tlv('01', '12') +
    tlv('38', merchant) +
    tlv('53', '704') +
    tlv('54', transfer.amount) +
    tlv('58', 'VN') +
    tlv('62', tlv('08', transfer.addInfo)) +
    '6304';
  return body + crc16CcittFalse(body);
}

function readTlv(value: string): Map<string, string> | undefined {
  const fields = new Map<string, string>();
  let offset = 0;
  while (offset < value.length) {
    const header = value.slice(offset, offset + 4);
    if (!/^[0-9]{4}$/.test(header)) return undefined;
    const id = header.slice(0, 2);
    const length = Number(header.slice(2));
    offset += 4;
    if (!length || offset + length > value.length || fields.has(id)) return undefined;
    fields.set(id, value.slice(offset, offset + length));
    offset += length;
  }
  return fields;
}

/**
 * Strict reader for payloads this platform itself produces: exactly the fields of
 * buildVietQrPayload, matching CRC, dynamic or static initiation. Anything else is rejected.
 */
export function parseVietQrPayload(payload: string): VietQrTransfer | undefined {
  if (payload.length > 512 || !/^[\x20-\x7e]+$/.test(payload)) return undefined;
  if (!/6304[0-9A-F]{4}$/.test(payload)) return undefined;
  if (payload.slice(-4) !== crc16CcittFalse(payload.slice(0, -4))) return undefined;
  const fields = readTlv(payload);
  if (!fields) return undefined;
  const expectedIds = ['00', '01', '38', '53', '54', '58', '62', '63'];
  if ([...fields.keys()].some((id) => !expectedIds.includes(id))) return undefined;
  if (fields.get('00') !== '01' || !['11', '12'].includes(fields.get('01') ?? '')) return undefined;
  if (fields.get('53') !== '704' || fields.get('58') !== 'VN') return undefined;
  const merchant = readTlv(fields.get('38') ?? '');
  if (
    !merchant ||
    merchant.size !== 3 ||
    merchant.get('00') !== NAPAS_AID ||
    merchant.get('02') !== VIETQR_ACCOUNT_SERVICE
  )
    return undefined;
  const beneficiary = readTlv(merchant.get('01') ?? '');
  if (!beneficiary || beneficiary.size !== 2) return undefined;
  const extra = readTlv(fields.get('62') ?? '');
  if (!extra || extra.size !== 1 || !extra.has('08')) return undefined;
  const transfer = {
    bankBin: beneficiary.get('00') ?? '',
    accountNumber: beneficiary.get('01') ?? '',
    amount: fields.get('54') ?? '',
    addInfo: extra.get('08') ?? '',
  };
  try {
    return buildVietQrPayload(transfer) === payload ? transfer : undefined;
  } catch {
    return undefined;
  }
}
