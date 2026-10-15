import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { FundQueryService } from '../application/fund-query.service';
import { FinanceReadError, readUuid } from '../finance.errors';
import { ReceiptRepository } from './receipt.repository';
import { ReceiptStorage } from './receipt-storage';
import { RECEIPT_KEY, validateReceipt } from './receipt-validation';

@Injectable()
export class ReceiptService {
  private active = 0;
  private cleaning = false;
  private timer?: NodeJS.Timeout;
  private readonly logger = new Logger('ReceiptService');
  constructor(
    private readonly auth: FundQueryService,
    private readonly files: ReceiptRepository,
    private readonly storage: ReceiptStorage,
  ) {}
  private async bounded<T>(work: () => Promise<T>) {
    if (this.active >= 2) throw new FinanceReadError('SERVICE_UNAVAILABLE');
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
    }
  }
  upload(
    input: { fund_id?: string; actor_user_id?: string; mime_type?: string; content?: Uint8Array },
    correlation: string,
    deadline: number,
    signal: AbortSignal = new AbortController().signal,
  ) {
    return this.bounded(async () => {
      if (signal.aborted) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      const fund = readUuid(input.fund_id),
        actor = readUuid(input.actor_user_id);
      await this.auth.authorizeReceiptUpload(
        fund,
        actor,
        correlation,
        Math.min(deadline, Date.now() + 1800),
      );
      if (!input.content || !input.mime_type) throw new FinanceReadError('VALIDATION_FAILED');
      await validateReceipt(input.content, input.mime_type, deadline, signal);
      const bytes = Buffer.from(input.content),
        sha256 = createHash('sha256').update(bytes).digest('hex');
      const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' }[
        input.mime_type
      ];
      const file = {
        fund_id: fund,
        uploader_user_id: actor,
        sha256,
        mime_type: input.mime_type,
        size_bytes: bytes.length,
        object_key: `funds/${fund}/receipts/${randomUUID()}-${sha256}.${extension}`,
      };
      if (signal.aborted || Date.now() >= deadline)
        throw new FinanceReadError('SERVICE_UNAVAILABLE');
      await this.files.create(file);
      // Persist the staging row BEFORE the object; crashes remain discoverable by cleanup.
      await this.storage.withSignal(signal, () => this.storage.put(file, bytes));
      if (signal.aborted || Date.now() >= deadline)
        throw new FinanceReadError('SERVICE_UNAVAILABLE');
      await this.files.ready(file.object_key);
      return {
        object_key: file.object_key,
        mime_type: file.mime_type,
        size_bytes: file.size_bytes,
      };
    });
  }
  download(
    input: { fund_id?: string; actor_user_id?: string; object_key?: string },
    correlation: string,
    deadline: number,
    signal: AbortSignal = new AbortController().signal,
  ) {
    return this.bounded(async () => {
      if (signal.aborted) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      const fund = readUuid(input.fund_id),
        actor = readUuid(input.actor_user_id);
      if (typeof input.object_key !== 'string' || !RECEIPT_KEY.test(input.object_key))
        throw new FinanceReadError('VALIDATION_FAILED');
      await this.auth.authorizeFundRead(
        fund,
        actor,
        correlation,
        Math.min(deadline, Date.now() + 1800),
      );
      const file = await this.files.readable(fund, input.object_key, actor);
      const content = await this.storage.withSignal(signal, () => this.storage.read(file));
      if (signal.aborted || Date.now() >= deadline)
        throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return {
        object_key: file.object_key,
        mime_type: file.mime_type,
        size_bytes: file.size_bytes,
        content,
      };
    });
  }
  async cleanup() {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      for (let count = 0; count < 20; count++) {
        const key = await this.files.claimExpired();
        if (!key) break;
        await this.storage.remove(key);
      }
    } finally {
      this.cleaning = false;
    }
  }
  /** Internal preflight for future business writers, before their SQL transaction.
   * Does not replace the business Trip guard or bind's locked state/ownership check.
   */
  async prepareAttachment(fund: string, key: string, uploader: string, signal: AbortSignal) {
    if (!RECEIPT_KEY.test(key) || signal.aborted) throw new FinanceReadError('VALIDATION_FAILED');
    const file = await this.files.pendingAttachment(readUuid(fund), key, readUuid(uploader));
    await this.storage.withSignal(signal, () => this.storage.verify(file));
    if (signal.aborted) throw new FinanceReadError('SERVICE_UNAVAILABLE');
    return file;
  }
  onModuleInit() {
    this.timer = setInterval(
      () => void this.cleanup().catch(() => this.logger.warn('RECEIPT_CLEANUP_FAILED')),
      60000,
    );
    this.timer.unref();
  }
  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
}
