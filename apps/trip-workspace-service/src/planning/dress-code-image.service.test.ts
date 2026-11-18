import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { ConfigService } from '@nestjs/config';
import type { DatabaseProvider } from '@wolfari/database';
import sharp from 'sharp';
import { DressCodeImageService, DRESS_IMAGE_LIMIT } from './dress-code-image.service';

const trip = '20000000-0000-4000-8000-000000000001';
const actor = '10000000-0000-4000-8000-000000000001';
const dress = '50000000-0000-4000-8000-000000000001';
const image = '60000000-0000-4000-8000-000000000001';
const services: DressCodeImageService[] = [];
function setup(role = 'OWNER', archived_at: string | null = null, member = true) {
  const row = { role, plan_edit_policy: 'OWNER_ONLY', selected_editor: false, archived_at };
  let key: string | null = null;
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM trips t JOIN trip_members') ? member ? [row] : [] : sql.includes('FROM dress_codes') ? [{ reference_image_key: key }] : [] }));
  const storage = { bucketExists: vi.fn().mockResolvedValue(true), putObject: vi.fn().mockResolvedValue({}), statObject: vi.fn().mockResolvedValue({ size: 100, metaData: { 'content-type': 'image/jpeg' }, lastModified: new Date() }), getObject: vi.fn().mockImplementation(async () => Readable.from([Buffer.from([255, 216, 255, 217])])), removeObject: vi.fn(), listObjectsV2: vi.fn() };
  const service = new DressCodeImageService({} as ConfigService, { query } as unknown as DatabaseProvider);
  Object.assign(service, { client: storage }); services.push(service);
  return { service, query, storage, bind: (value: string | null) => { key = value; } };
}
afterEach(() => { for (const service of services.splice(0)) service.onApplicationShutdown(); });
const png = () => sharp({ create: { width: 2000, height: 1000, channels: 4, background: '#50a09080' } }).png().toBuffer();
describe('Private dresscode images', () => {
  it('normalizes PNG to a bounded JPEG without metadata or public object identifiers', async () => {
    const f = setup();
    const result = await f.service.upload(trip, actor, await png(), 'image/png');
    expect(result).toEqual({ image_id: expect.any(String), mime_type: 'image/jpeg', size_bytes: expect.any(Number) });
    const [bucket, key, bytes] = f.storage.putObject.mock.calls[0]!;
    expect(bucket).toBe('wolfari-trip-dress-images');
    expect(key).toBe(f.service.key(trip, actor, result.image_id));
    const meta = await sharp(bytes).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 1536, height: 768 });
    expect(meta.exif).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('trips/');
  });
  it('checks editor access, membership and archive before storing anything', async () => {
    for (const [f, code] of [[setup('MEMBER'), 'PERMISSION_DENIED'], [setup('OWNER', null, false), 'RESOURCE_NOT_FOUND'], [setup('OWNER', '2026-11-18'), 'STATE_CONFLICT']] as const) {
      await expect(f.service.upload(trip, actor, await png(), 'image/png')).rejects.toMatchObject({ code });
      expect(f.storage.putObject).not.toHaveBeenCalled();
    }
  });
  it('rejects bad magic, MIME, size, corruption and excessive pixel dimensions', async () => {
    const f = setup();
    const huge = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: '#fff' } }).png().toBuffer();
    for (const [bytes, mime] of [[Buffer.from('not a photo'), 'image/png'], [await png(), 'image/jpeg'], [await png(), 'image/gif'], [Buffer.alloc(DRESS_IMAGE_LIMIT + 1), 'image/png'], [Buffer.from([255, 216, 255]), 'image/jpeg'], [huge, 'image/png']] as const)
      await expect(f.service.upload(trip, actor, bytes, mime)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(f.storage.putObject).not.toHaveBeenCalled();
  });
  it('binds staged IDs to the same Trip/uploader and rejects expired objects', async () => {
    const f = setup();
    const key = await f.service.validate(trip, actor, image);
    expect(f.storage.statObject).toHaveBeenCalledWith('wolfari-trip-dress-images', key);
    expect(f.service.key(trip, dress, image)).not.toBe(key);
    expect(f.service.key(dress, actor, image)).not.toBe(key);
    f.storage.statObject.mockRejectedValueOnce({ code: 'NoSuchKey' });
    await expect(f.service.validate(trip, dress, image)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    f.storage.statObject.mockResolvedValueOnce({ size: 100, metaData: { 'content-type': 'image/jpeg' }, lastModified: new Date(Date.now() - 25 * 3600_000) });
    await expect(f.service.validate(trip, actor, image)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('allows current members to read archived images, but denies outsiders and missing bindings', async () => {
    const f = setup('MEMBER', '2026-11-18');
    f.bind(f.service.key(trip, actor, image));
    expect(await f.service.download(trip, actor, dress)).toMatchObject({ mime_type: 'image/jpeg', size_bytes: 4 });
    const outsider = setup('MEMBER', null, false);
    await expect(outsider.service.download(trip, actor, dress)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(outsider.storage.getObject).not.toHaveBeenCalled();
    f.bind(null);
    await expect(f.service.download(trip, actor, dress)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});
