import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'minio';
import { Agent, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { FinanceReadError } from '../finance.errors';
import { RECEIPT_LIMIT } from './receipt-validation';
import type { FinanceFile } from './receipt.repository';

export const RECEIPT_BUCKET = 'wolfari-finance-receipts';
@Injectable()
export class ReceiptStorage {
  private client?: Client;
  private readonly cancellations = new AsyncLocalStorage<AbortSignal>();
  withSignal<T>(signal: AbortSignal, work: () => Promise<T>) {
    return this.cancellations.run(signal, work);
  }
  private readonly agent = new Agent({ keepAlive: false, timeout: 5000, maxSockets: 4 });
  constructor(private readonly config: ConfigService) {}
  private get minio() {
    if (!this.client) {
      const endpoint = this.config.get<string>('MINIO_ENDPOINT') ?? '';
      const [host, port] = endpoint.split(':');
      if (!host || !/^\d+$/.test(port ?? '')) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      this.client = new Client({
        endPoint: host,
        port: Number(port),
        useSSL: false,
        accessKey: this.config.getOrThrow<string>('MINIO_ACCESS_KEY'),
        secretKey: this.config.getOrThrow<string>('MINIO_SECRET_KEY'),
        transportAgent: this.agent,
        transport: {
          request: ((...args: Parameters<typeof httpRequest>) => {
            const request = httpRequest(...args);
            const signal = this.cancellations.getStore();
            const abort = () => request.destroy(new Error('Storage cancelled'));
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            const timer = setTimeout(() => request.destroy(new Error('Storage deadline')), 10000);
            request.once('close', () => {
              clearTimeout(timer);
              signal?.removeEventListener('abort', abort);
            });
            return request;
          }) as typeof httpRequest,
        },
      });
    }
    return this.client;
  }
  async put(
    file: FinanceFile | Omit<FinanceFile, 'state' | 'contribution_id' | 'expense_id'>,
    bytes: Buffer,
  ) {
    if (!(await this.minio.bucketExists(RECEIPT_BUCKET))) {
      try {
        await this.minio.makeBucket(RECEIPT_BUCKET);
      } catch (error) {
        if ((error as { code?: string }).code !== 'BucketAlreadyOwnedByYou') throw error;
      }
    }
    await this.minio.putObject(RECEIPT_BUCKET, file.object_key, bytes, bytes.length, {
      'Content-Type': file.mime_type,
    });
  }
  async read(file: FinanceFile) {
    const stream = await this.minio.getObject(RECEIPT_BUCKET, file.object_key);
    const timer = setTimeout(() => stream.destroy(new Error('Storage deadline')), 10000);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > RECEIPT_LIMIT || size > file.size_bytes)
          throw new Error('Storage size mismatch');
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks);
      if (
        bytes.length !== file.size_bytes ||
        createHash('sha256').update(bytes).digest('hex') !== file.sha256
      )
        throw new Error('Storage integrity failure');
      return bytes;
    } finally {
      clearTimeout(timer);
      stream.destroy();
    }
  }
  /** Attachment preflight calls this before opening its business transaction. */
  async verify(file: FinanceFile) {
    await this.read(file);
  }
  async remove(key: string) {
    await this.minio.removeObject(RECEIPT_BUCKET, key);
  }
  onApplicationShutdown() {
    this.agent.destroy();
  }
}
