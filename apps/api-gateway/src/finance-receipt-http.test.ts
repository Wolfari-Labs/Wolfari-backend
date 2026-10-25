import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { receiptMultipart } from './finance-receipt-http';

function parse(
  parts: { name: string; bytes: Buffer; mime?: string }[],
  signal = new AbortController().signal,
) {
  const boundary = 'test-finance-boundary';
  const chunks = parts.flatMap((p) => [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"; filename="file.png"\r\nContent-Type: ${p.mime ?? 'image/png'}\r\n\r\n`,
    ),
    p.bytes,
    Buffer.from('\r\n'),
  ]);
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const stream = Readable.from(chunks) as IncomingMessage;
  stream.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  return receiptMultipart(stream, signal);
}
describe('Finance multipart boundary', () => {
  it('accepts exactly 10MiB without truncating bytes', async () => {
    const bytes = Buffer.alloc(10 * 1024 * 1024, 37);
    expect((await parse([{ name: 'file', bytes }])).content.equals(bytes)).toBe(true);
  });
  it('rejects extra files, wrong field/type, empty, oversized and cancelled requests', async () => {
    for (const parts of [
      [],
      [{ name: 'wrong', bytes: Buffer.from('x') }],
      [{ name: 'file', bytes: Buffer.alloc(0) }],
      [{ name: 'file', bytes: Buffer.alloc(10 * 1024 * 1024 + 1) }],
      [{ name: 'file', bytes: Buffer.from('x'), mime: 'text/html' }],
      [
        { name: 'file', bytes: Buffer.from('x') },
        { name: 'file', bytes: Buffer.from('y') },
      ],
    ])
      await expect(parse(parts)).rejects.toThrow();
    const abort = new AbortController();
    abort.abort();
    await expect(
      parse([{ name: 'file', bytes: Buffer.from('x') }], abort.signal),
    ).rejects.toThrow();
  });
});
