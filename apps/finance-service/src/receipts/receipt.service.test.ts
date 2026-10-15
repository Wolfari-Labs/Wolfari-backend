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
    create: vi.fn().mockResolvedValue(undefined),
    ready: vi.fn().mockResolvedValue(undefined),
    readable: vi.fn(),
    claimExpired: vi.fn(),
  };
  const storage = {
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
