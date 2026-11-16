import { describe, expect, it } from 'vitest';
import { create } from 'qrcode';
import { buildVietQrPayload, QR_SVG_MAX_BYTES, QR_SVG_SHAPE } from '@wolfari/common';
import { renderQrSvg } from './qr-svg';

const payload = buildVietQrPayload({
  bankBin: '970436',
  accountNumber: '0011012345678',
  amount: '300000',
  addInfo: '0ABCDEFGHIJKLMNOPQRSTUVWX',
});

describe('QR SVG renderer', () => {
  it('emits exactly the plain shape the Gateway accepts, with a 4-module quiet zone', () => {
    const svg = renderQrSvg(payload, 'VietQR');
    expect(svg).toMatch(QR_SVG_SHAPE);
    expect(Buffer.byteLength(svg)).toBeLessThan(QR_SVG_MAX_BYTES);
    const size = create(payload, { errorCorrectionLevel: 'M' }).modules.size;
    expect(svg).toContain(`viewBox="0 0 ${size + 8} ${size + 8}"`);
    // Finder pattern: the first dark run of the top row is the 7-module corner square.
    expect(svg).toContain('M4 4h7v1h-7z');
    expect(svg).not.toMatch(/<script|<a |href=|on[a-z]+=/i);
    expect(renderQrSvg(payload, 'VietQR')).toBe(svg);
  });
  it('reproduces every dark module of the encoder, nothing more', () => {
    const symbol = create(payload, { errorCorrectionLevel: 'M' });
    const size = symbol.modules.size;
    const dark = new Set<string>();
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        if (symbol.modules.data[y * size + x]) dark.add(`${x + 4},${y + 4}`);
    const drawn = new Set<string>();
    for (const [, x, y, run] of renderQrSvg(payload).matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g))
      for (let i = 0; i < Number(run); i++) drawn.add(`${Number(x) + i},${y}`);
    expect(drawn).toEqual(dark);
  });
  it('keeps the accessible label free of markup', () => {
    expect(renderQrSvg(payload, 'VietQR"><script>')).toContain('aria-label="VietQRscript"');
  });
});
