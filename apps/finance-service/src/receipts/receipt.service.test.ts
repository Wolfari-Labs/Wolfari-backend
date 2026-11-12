import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { ReceiptService } from './receipt.service';
import type { ReceiptRepository } from './receipt.repository';
import type { ReceiptStorage } from './receipt-storage';
import type { FundQueryService } from '../application/fund-query.service';

const id = '10000000-0000-4000-8000-000000000001';
async function setup() {
  const content = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  const input = { fund_id: id, actor_user_id: id, mime_type: 'image/png', content };
  const auth = {
    authorizeReceiptUpload: vi.fn().mockResolvedValue(undefined),
    authorizeFundRead: vi.fn(),
  };
  const files = {
    pendingAttachment: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue(undefined),
    ready: vi.fn().mockResolvedValue(undefined),
    readable: vi.fn(),
    expenseFund: vi.fn().mockResolvedValue(id),
    readableExpense: vi.fn(),
    claimExpired: vi.fn(),
  };
  const storage = {
    verify: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
    read: vi.fn(),
    remove: vi.fn(),
    withSignal: vi.fn((_signal: AbortSignal, work: () => Promise<unknown>) => work()),
  };
  const service = new ReceiptService(
    auth as unknown as FundQueryService,
    files as unknown as ReceiptRepository,
    storage as unknown as ReceiptStorage,
  );
  return {
    input,
    auth,
    files,
    storage,
    service,
    upload: () => service.upload(input, id, Date.now() + 10000),
  };
}
describe('Receipt failure lifecycle', () => {
  it('resolves the current expense attachment without returning an object key', async () => {
    const s = await setup();
    // Distinct identifiers so swapped or skipped expense/Fund/actor arguments cannot pass.
    const expenseId = '20000000-0000-4000-8000-000000000001',
      fundId = '20000000-0000-4000-8000-000000000002',
      actorId = '20000000-0000-4000-8000-000000000003',
      correlation = '20000000-0000-4000-8000-000000000004';
    s.files.expenseFund.mockResolvedValue(fundId);
    const file = { object_key: 'private/key', mime_type: 'image/png', size_bytes: 3 };
    s.files.readableExpense.mockResolvedValue(file);
    s.storage.read.mockResolvedValue(Buffer.from('png'));
    const result = await s.service.downloadExpense(
      { expense_id: expenseId, actor_user_id: actorId },
      correlation,
      Date.now() + 10000,
    );
    expect(s.files.expenseFund).toHaveBeenCalledWith(expenseId);
    expect(s.auth.authorizeFundRead).toHaveBeenCalledTimes(2);
    expect(s.auth.authorizeFundRead).toHaveBeenCalledWith(
      fundId,
      actorId,
      correlation,
      expect.any(Number),
    );
    expect(s.files.readableExpense).toHaveBeenCalledWith(fundId, expenseId);
    expect(result).toEqual({
      expense_id: expenseId,
      fund_id: fundId,
      mime_type: 'image/png',
      size_bytes: 3,
      content: Buffer.from('png'),
    });
    expect(result).not.toHaveProperty('object_key');
  });
  it('keeps storage outages retryable instead of masking them as a missing receipt', async () => {
    const s = await setup();
    s.files.readableExpense.mockResolvedValue({ object_key: 'private/key' });
    s.storage.read.mockRejectedValueOnce({ code: 'NoSuchBucket' });
    await expect(
      s.service.downloadExpense({ expense_id: id, actor_user_id: id }, id, Date.now() + 10000),
    ).rejects.not.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    s.storage.read.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(
      s.service.downloadExpense({ expense_id: id, actor_user_id: id }, id, Date.now() + 10000),
    ).rejects.toThrow('ECONNRESET');
  });
  it('does not fetch expense storage for an unauthorized or missing attachment', async () => {
    const s = await setup();
    s.auth.authorizeFundRead.mockRejectedValueOnce(new Error('denied'));
    await expect(
      s.service.downloadExpense({ expense_id: id, actor_user_id: id }, id, Date.now() + 10000),
    ).rejects.toThrow('denied');
    expect(s.files.readableExpense).not.toHaveBeenCalled();
    s.files.readableExpense.mockRejectedValueOnce(new Error('missing'));
    await expect(
      s.service.downloadExpense({ expense_id: id, actor_user_id: id }, id, Date.now() + 10000),
    ).rejects.toThrow('missing');
    expect(s.storage.read).not.toHaveBeenCalled();
  });
  it('hides missing storage objects and a replaced attachment during download', async () => {
    const s = await setup();
    s.files.readableExpense.mockResolvedValue({ object_key: 'old' });
    s.storage.read.mockRejectedValueOnce({ code: 'NoSuchKey' });
    await expect(
      s.service.downloadExpense({ expense_id: id, actor_user_id: id }, id, Date.now() + 10000),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    s.storage.read.mockResolvedValue(Buffer.from('png'));
    s.files.readableExpense
      .mockResolvedValueOnce({ object_key: 'old' })
      .mockResolvedValueOnce({ object_key: 'new' });
    await expect(
      s.service.downloadExpense({ expense_id: id, actor_user_id: id }, id, Date.now() + 10000),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
  it('rechecks membership after storage IO and does not deliver a revoked read', async () => {
    const s = await setup();
    s.files.readableExpense.mockResolvedValue({ object_key: 'current' });
    s.storage.read.mockResolvedValue(Buffer.from('png'));
    s.auth.authorizeFundRead
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('membership revoked'));
    await expect(
      s.service.downloadExpense({ expense_id: id, actor_user_id: id }, id, Date.now() + 10000),
    ).rejects.toThrow('membership revoked');
    expect(s.auth.authorizeFundRead).toHaveBeenCalledTimes(2);
  });
  it('bounds report evidence verification and treats cancelled preparation as unavailable', async () => {
    const s = await setup();
    const key = `funds/${id}/receipts/${id}-${'a'.repeat(64)}.png`;
    const releases: (() => void)[] = [];
    s.storage.verify.mockImplementation(
      () => new Promise<void>((resolve) => releases.push(resolve)),
    );
    const first = s.service.prepareAttachment(id, key, id, new AbortController().signal, id);
    const second = s.service.prepareAttachment(id, key, id, new AbortController().signal);
    await expect(
      s.service.prepareAttachment(id, key, id, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.forEach((release) => release());
    await Promise.all([first, second]);
    expect(s.files.pendingAttachment).toHaveBeenCalledWith(id, key, id, id);
    await expect(
      s.service.prepareAttachment(id, key, id, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(s.storage.verify).toHaveBeenCalledTimes(2);
  });
  it('does not put an object if metadata creation fails', async () => {
    const s = await setup();
    s.files.create.mockRejectedValue(new Error('Database unavailable'));
    await expect(s.upload()).rejects.toThrow();
    expect(s.storage.put).not.toHaveBeenCalled();
  });
  it('retains staging on storage/finalization failures for crash cleanup', async () => {
    const s = await setup();
    s.storage.put.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(s.upload()).rejects.toThrow();
    expect(s.files.ready).not.toHaveBeenCalled();
    s.files.ready.mockRejectedValueOnce(new Error('Lost database connection'));
    await expect(s.upload()).rejects.toThrow();
    expect(s.storage.remove).not.toHaveBeenCalled();
  });
  it('does not finalize a cancelled upload after its PUT finishes', async () => {
    const s = await setup(),
      abort = new AbortController();
    s.storage.put.mockImplementation(async () => abort.abort());
    await expect(
      s.service.upload(s.input, id, Date.now() + 10000, abort.signal),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(s.files.ready).not.toHaveBeenCalled();
  });
  it('bounds concurrency and frees capacity after failures', async () => {
    const s = await setup();
    let release!: () => void;
    s.auth.authorizeReceiptUpload.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = s.upload();
    const releaseFirst = release;
    const second = s.upload();
    const releaseSecond = release;
    await expect(s.upload()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    releaseFirst();
    releaseSecond();
    await Promise.all([first, second]);
    s.auth.authorizeReceiptUpload.mockResolvedValue(undefined);
    await expect(s.upload()).resolves.toMatchObject({ mime_type: 'image/png' });
  });
  it('uses only claimed deletion keys; a storage failure remains retryable', async () => {
    const s = await setup();
    s.files.claimExpired.mockResolvedValueOnce('claimed').mockResolvedValue(undefined);
    s.storage.remove.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(s.service.cleanup()).rejects.toThrow();
    expect(s.storage.remove).toHaveBeenCalledWith('claimed');
    await expect(s.service.cleanup()).resolves.toBeUndefined();
  });
});
