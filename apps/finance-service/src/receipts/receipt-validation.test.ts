import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { validateReceipt, RECEIPT_LIMIT } from './receipt-validation';
const check = (bytes: Buffer, mime: string) => validateReceipt(bytes, mime, Date.now() + 15000);
describe('Receipt file validation', () => {
  it('decodes PNG/JPEG and parses PDF in a bounded worker', async () => {
    const source = sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } });
    await check(await source.clone().png().toBuffer(), 'image/png');
    await check(await source.clone().jpeg().toBuffer(), 'image/jpeg');
    const pdf = await PDFDocument.create();
    pdf.addPage();
    await check(Buffer.from(await pdf.save()), 'application/pdf');
  });
  it('rejects empty, oversized, spoofed and corrupt payloads', async () => {
    for (const [bytes, mime] of [
      [Buffer.alloc(0), 'image/png'],
      [Buffer.alloc(RECEIPT_LIMIT + 1), 'application/pdf'],
      [Buffer.from('not a PNG'), 'image/png'],
      [Buffer.from([255, 216, 255, 0]), 'image/jpeg'],
      [Buffer.from('%PDF-1.7\ninvalid\n%%EOF'), 'application/pdf'],
      [Buffer.from('hello'), 'text/plain'],
    ] as const)
      await expect(check(bytes, mime)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('rejects stale work before starting a decoder', async () => {
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    await expect(validateReceipt(png, 'image/png', Date.now() - 1)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });
});
