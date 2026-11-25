import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { activeMediaBatch, getObject, heroImages, servablePhoto } from './poi-media';

/** Fake db.query whose calls keep (sql, params) for assertions. */
type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

const sha = 'b'.repeat(64);
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('POI photos in place search', () => {
  it('attaches the active batch hero per POI and nothing before V006', async () => {
    const db = {
      query: vi.fn<Query>(async (sql) => {
        if (sql.includes('poi_media_batches')) return { rows: [{ id: 'img-1' }] };
        return {
          rows: [
            { poi_id: 'p1', sha256: sha, width: 1280, height: 853, author: null, license_code: 'CC0-1.0', license_url: null, source_url: 'https://commons.wikimedia.org/wiki/File:A.jpg', attribution: 'Ảnh · CC0 · Wikimedia Commons', source: 'wikidata' },
            { poi_id: 'p2', sha256: 'not-a-hash', width: 1, height: 1, author: null, license_code: 'PD', license_url: null, source_url: 'x', attribution: 'x', source: 'x' },
          ],
        };
      }),
    };
    const heroes = await heroImages(db as never, ['p1', 'p2']);
    expect([...heroes.keys()]).toEqual(['p1']);
    expect(heroes.get('p1')).toMatchObject({ sha256: sha, license: 'CC0-1.0', author: '', width: 1280 });
    expect(db.query.mock.calls[1]![1]).toEqual([['p1', 'p2'], 'img-1']);
    // Golden photos win over Overture ones; only accepted heroes of the batch.
    expect(db.query.mock.calls[1]![0]).toMatch(/role = 'hero' AND m.status = 'accepted'/);
    expect(db.query.mock.calls[1]![0]).toMatch(/\(m.golden_key IS NOT NULL\) DESC/);

    const before = { query: vi.fn(async () => Promise.reject(Object.assign(new Error('missing'), { code: '42P01' }))) };
    expect(await activeMediaBatch(before as never)).toBeNull();
    expect((await heroImages(before as never, ['p1'])).size).toBe(0);
    const none = { query: vi.fn(async () => ({ rows: [] })) };
    expect((await heroImages(none as never, ['p1'])).size).toBe(0);
    expect(none.query).toHaveBeenCalledTimes(1);
  });
  it('serves only photos accepted in the active batch', async () => {
    const db = { query: vi.fn<Query>(async (sql) => (sql.includes('poi_media_batches') ? { rows: [{ id: 'img-1' }] } : { rows: [] })) };
    expect(await servablePhoto(db as never, sha)).toBe(false);
    expect(db.query.mock.calls[1]![0]).toMatch(/status = 'accepted'/);
  });
});

describe('MinIO GetObject (SigV4)', () => {
  it('signs a path-style GET and maps 404 to null', async () => {
    const seen: { url?: string; headers?: IncomingHttpHeaders }[] = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url, headers: req.headers });
      if (req.url!.includes('missing')) return void res.writeHead(404).end();
      res.end('bytes');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `127.0.0.1:${(server.address() as { port: number }).port}`;
    const config = { endpoint, accessKey: 'access', secretKey: 'secret' };
    const now = new Date('2026-11-22T10:00:00Z');
    expect((await getObject(config, 'wolfari-poi-images', `poi/${sha}/640.webp`, { now }))!.toString()).toBe('bytes');
    expect(seen[0]!.url).toBe(`/wolfari-poi-images/poi/${sha}/640.webp`);
    expect(seen[0]!.headers!['x-amz-date']).toBe('20261122T100000Z');
    expect(seen[0]!.headers!.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=access\/20261122\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(await getObject(config, 'wolfari-poi-images', 'poi/missing/640.webp', { now })).toBeNull();
    await expect(getObject({ ...config, endpoint: 'nohost' }, 'b', 'k')).rejects.toThrow('MINIO_ENDPOINT');
  });
});
