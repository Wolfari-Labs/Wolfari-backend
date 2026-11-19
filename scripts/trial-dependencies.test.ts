import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
describe('MinIO query decoder security adapter on Node24', () => {
  const minio = require.resolve('minio');
  const query = require(require.resolve('query-string', { paths: [dirname(minio)] }));
  it('retains query-string7 parse/stringify semantics', () => {
    expect(query.parse('name=Nguy%E1%BB%85n+An&repeat=a&repeat=b')).toMatchObject({
      name: 'Nguyễn An',
      repeat: ['a', 'b'],
    });
    expect(query.stringify({ key: 'a b', path: 'a/b' })).toBe('key=a%20b&path=a%2Fb');
    expect(query.parse('x=%zz')).toMatchObject({ x: '%zz' });
  });
  it('constructs the real MinIO client and signs a private object URL without network', async () => {
    const { Client } = require('minio');
    const client = new Client({
      endPoint: '127.0.0.1',
      port: 9000,
      useSSL: false,
      region: 'us-east-1',
      accessKey: 'test-only',
      secretKey: 'test-only-long-secret',
    });
    const url = new URL(
      await client.presignedGetObject('wolfari-identity-avatars', 'users/test/avatar.png', 60),
    );
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.searchParams.has('X-Amz-Signature')).toBe(true);
  });
});
