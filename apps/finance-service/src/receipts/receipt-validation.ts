import { Worker } from 'node:worker_threads';
import { FinanceReadError } from '../finance.errors';

export const RECEIPT_LIMIT = 10 * 1024 * 1024;
export const RECEIPT_MIMES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export const RECEIPT_KEY =
  /^funds\/[0-9a-f-]{36}\/receipts\/[0-9a-f-]{36}-[0-9a-f]{64}\.(jpg|png|pdf)$/;

/** Parser runs off the request thread with a hard wall-clock and JS heap budget.
 * This validates structure, not malware. Original bytes/hash are retained.
 */
export async function validateReceipt(
  bytes: Uint8Array,
  mime: string,
  deadline: number,
  signal?: AbortSignal,
) {
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.length ||
    bytes.length > RECEIPT_LIMIT ||
    !RECEIPT_MIMES.includes(mime as (typeof RECEIPT_MIMES)[number])
  )
    throw new FinanceReadError('VALIDATION_FAILED');
  const buffer = Buffer.from(bytes);
  const magic =
    mime === 'image/jpeg'
      ? buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      : mime === 'image/png'
        ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : /^%PDF-1\.[0-7]|^%PDF-2\.0/.test(buffer.subarray(0, 8).toString('ascii')) &&
          /%%EOF\s*$/.test(buffer.subarray(-1024).toString('ascii'));
  if (!magic) throw new FinanceReadError('VALIDATION_FAILED');
  const timeout = Math.min(5000, deadline - Date.now());
  if (signal?.aborted || timeout <= 0) throw new FinanceReadError('SERVICE_UNAVAILABLE');
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(
      `
      const {workerData:d,parentPort:p}=require('node:worker_threads');
      (async()=>{
        if(d.mime==='application/pdf') {
          const {PDFDocument}=require(d.pdf);
          const doc=await PDFDocument.load(d.bytes,{throwOnInvalidObject:true,updateMetadata:false});
          const pages=doc.getPages();
          if(!pages.length || pages.length>1000) throw Error();
          for(const page of pages) { const s=page.getSize(); if(!(s.width>0&&s.height>0)) throw Error(); }
        } else {
          const sharp=require(d.sharp);
          const input=sharp(Buffer.from(d.bytes),{limitInputPixels:10000000,failOn:'warning'});
          const meta=await input.metadata();
          if((meta.pages??1)!==1) throw Error();
          await input.raw().toBuffer();
        }
        p.postMessage(true);
      })().catch(()=>p.postMessage(false));`,
      {
        eval: true,
        workerData: {
          bytes: buffer,
          mime,
          pdf: require.resolve('pdf-lib'),
          sharp: require.resolve('sharp'),
        },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
        stdout: true,
        stderr: true,
      },
    );
    worker.stdout?.resume();
    worker.stderr?.resume();
    let done = false;
    const finish = (valid: boolean, unavailable = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker
        .terminate()
        .then(() =>
          valid
            ? resolve()
            : reject(
                new FinanceReadError(unavailable ? 'SERVICE_UNAVAILABLE' : 'VALIDATION_FAILED'),
              ),
        );
    };
    const abort = () => finish(false, true);
    const timer = setTimeout(abort, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    worker.once('message', (valid) => finish(valid === true));
    worker.once('error', () => finish(false));
    worker.once('exit', () => finish(false));
  });
}
