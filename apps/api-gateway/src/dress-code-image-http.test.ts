import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { CorrelationMiddleware } from '@wolfari/common';
import { DressCodeImageHttp, dressImageRoute } from './dress-code-image-http';

const trip = '20000000-0000-4000-8000-000000000001';
const dress = '50000000-0000-4000-8000-000000000001';
const image = '60000000-0000-4000-8000-000000000001';
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); });
async function setup() {
  const client = { call: vi.fn().mockResolvedValue({ image_id: image, mime_type: 'image/jpeg', size_bytes: 4, private_key: 'never-expose' }) };
  const proxy = new DressCodeImageHttp(vi.fn().mockResolvedValue({ user_id: trip }), client);
  const server = createServer((req, res) => { new CorrelationMiddleware().use(req, res, () => {
    const url = new URL(req.url!, 'http://localhost');
    void proxy.handle(req, res, url, dressImageRoute(url.pathname)!);
  }); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { client, url: `http://127.0.0.1:${port}/api/v1/trips/${trip}`, headers: { Authorization: 'Bearer fixture' } };
}
describe('Dress image HTTP contract', () => {
  it('parses multipart upload and projects only an opaque ID', async () => {
    const f = await setup(), body = new FormData();
    body.append('file', new Blob(['jpeg'], { type: 'image/jpeg' }), 'dress.jpg');
    const response = await fetch(f.url + '/dress-code-images', { method: 'POST', headers: f.headers, body });
    expect(response.status).toBe(201);
    const result = await response.json() as { data: unknown };
    expect(result.data).toEqual({ image_id: image, mime_type: 'image/jpeg', size_bytes: 4 });
    expect(f.client.call).toHaveBeenCalledWith('UploadDressCodeImage', expect.objectContaining({ trip_id: trip, actor_user_id: trip, mime_type: 'image/jpeg', content: Buffer.from('jpeg') }), expect.any(String));
    expect(JSON.stringify(result)).not.toContain('never-expose');
  });
  it('serves a private bounded JPEG with no-store and rejects bad upstream bytes', async () => {
    const f = await setup();
    f.client.call.mockResolvedValueOnce({ content: Buffer.from('jpeg'), mime_type: 'image/jpeg', size_bytes: 4 });
    const response = await fetch(f.url + `/dress-codes/${dress}/reference-image`, { headers: f.headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(await response.text()).toBe('jpeg');
    f.client.call.mockResolvedValueOnce({ content: Buffer.from('jpeg'), mime_type: 'text/html', size_bytes: 4 });
    expect((await fetch(f.url + `/dress-codes/${dress}/reference-image`, { headers: f.headers })).status).toBe(503);
  });
  it('rejects missing auth, unsupported formats and multiple file parts before RPC', async () => {
    const f = await setup();
    expect((await fetch(f.url + '/dress-code-images', { method: 'POST' })).status).toBe(401);
    for (const mime of ['image/gif', 'application/pdf', 'image/png']) {
      const body = new FormData(); body.append('file', new Blob(['file'], { type: mime }), 'file');
      if (mime === 'image/png') body.append('file', new Blob(['second'], { type: mime }), 'second');
      expect((await fetch(f.url + '/dress-code-images', { method: 'POST', headers: f.headers, body })).status).toBe(400);
    }
    expect(f.client.call).not.toHaveBeenCalled();
  });
});
