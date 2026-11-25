import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { status } from '@grpc/grpc-js';
import { CorrelationMiddleware } from '@wolfari/common';
import { PoiImageHttp, publicPlaceImage } from './poi-image-http';
import { publicPlace } from './places-proxy';

const sha = 'a'.repeat(64);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function setup(call = vi.fn().mockResolvedValue({ content: webp, mime_type: 'image/webp', size_bytes: webp.length })) {
  const proxy = new PoiImageHttp(call);
  const server = createServer((req, res) => {
    new CorrelationMiddleware().use(req, res, () => {
      if (proxy.matches(req)) void proxy.handle(req, res);
      else res.end('other');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { call, base: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/travel/poi-images` };
}

describe('POI image HTTP (public, content-addressed)', () => {
  it('serves WebP without a session and lets clients cache it for a year', async () => {
    const f = await setup();
    const response = await fetch(`${f.base}/${sha}/640.webp`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(webp);
    expect(f.call).toHaveBeenCalledWith({ sha256: sha, width: 640 });
  });
  it('rejects other widths, hashes, methods and query strings before any RPC', async () => {
    const f = await setup();
    for (const path of [`/${sha}/800.webp`, `/${'g'.repeat(64)}/640.webp`, `/${sha.toUpperCase()}/640.webp`, `/${sha}/640.jpg`, `/${sha}/640.webp?x=1`]) {
      const response = await fetch(f.base + path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect((await fetch(`${f.base}/${sha}/640.webp`, { method: 'POST' })).status).toBe(404);
    expect(f.call).not.toHaveBeenCalled();
  });
  it('maps a taken-down photo to 404 and refuses anything that is not WebP', async () => {
    const missing = Object.assign(new Error('gone'), { code: status.NOT_FOUND });
    const f = await setup(vi.fn().mockRejectedValueOnce(missing).mockResolvedValueOnce({ content: Buffer.from('<html>'), mime_type: 'image/webp' }));
    expect((await fetch(`${f.base}/${sha}/320.webp`)).status).toBe(404);
    expect((await fetch(`${f.base}/${sha}/320.webp`)).status).toBe(503);
  });
});

describe('Place hero_image projection', () => {
  const hero = {
    sha256: sha, width: 1280, height: 853, author: 'An', license: 'CC-BY-SA-4.0',
    license_url: 'https://creativecommons.org/licenses/by-sa/4.0', source_url: 'https://commons.wikimedia.org/wiki/File:X.jpg',
    attribution: 'Ảnh: An · CC BY-SA 4.0 · Wikimedia Commons', source: 'wikidata', internal_key: 'poi/secret',
  };
  it('exposes gateway-relative URLs and credits only', () => {
    expect(publicPlaceImage(hero)).toEqual({
      url: `/api/v1/travel/poi-images/${sha}/1280.webp`,
      thumbnail_url: `/api/v1/travel/poi-images/${sha}/640.webp`,
      small_url: `/api/v1/travel/poi-images/${sha}/320.webp`,
      width: 1280, height: 853, author: 'An', license: 'CC-BY-SA-4.0',
      license_url: 'https://creativecommons.org/licenses/by-sa/4.0', source_url: 'https://commons.wikimedia.org/wiki/File:X.jpg',
      attribution: 'Ảnh: An · CC BY-SA 4.0 · Wikimedia Commons', source: 'wikidata', is_placeholder: false,
    });
  });
  it('drops a photo without licence, credits or a valid hash, and keeps hero_image null when absent', () => {
    expect(publicPlaceImage({ ...hero, license: '' })).toBeNull();
    expect(publicPlaceImage({ ...hero, attribution: '' })).toBeNull();
    expect(publicPlaceImage({ ...hero, sha256: 'x' })).toBeNull();
    expect(publicPlaceImage({ ...hero, source_url: 'javascript:alert(1)' })).toBeNull();
    expect(publicPlace({ id: 'dn-x', name: 'X', provider: 'WOLFARI' }).hero_image).toBeNull();
    expect(publicPlace({ id: 'dn-x', name: 'X', provider: 'WOLFARI', hero_image: hero }).hero_image).toMatchObject({ license: 'CC-BY-SA-4.0' });
    expect(JSON.stringify(publicPlace({ id: 'dn-x', name: 'X', provider: 'WOLFARI', hero_image: hero }))).not.toContain('poi/secret');
  });
});
