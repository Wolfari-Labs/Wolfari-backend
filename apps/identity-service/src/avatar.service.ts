import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseProvider } from '@wolfari/database';
import { randomUUID } from 'node:crypto';
import { Client as Minio } from 'minio';
import sharp from 'sharp';
import { IdentityError } from './identity.service';

const BUCKET = 'wolfari-identity-avatars';
const LIMIT = 10 * 1024 * 1024;

@Injectable()
export class AvatarService implements OnApplicationShutdown {
  private readonly minio: Minio;
  constructor(config: ConfigService, private readonly db: DatabaseProvider) {
    const endpoint = config.getOrThrow<string>('MINIO_ENDPOINT').split(':');
    this.minio = new Minio({ endPoint: endpoint[0]!, port: Number(endpoint[1]), useSSL: false, accessKey: config.getOrThrow<string>('MINIO_ACCESS_KEY'), secretKey: config.getOrThrow<string>('MINIO_SECRET_KEY') });
  }

  private async ensureBucket() {
    if (!(await this.minio.bucketExists(BUCKET))) await this.minio.makeBucket(BUCKET);
  }

  async upload(userId: string, file?: { buffer: Buffer; size: number; mimetype: string }) {
    if (!file || file.size < 1 || file.size > LIMIT || !['image/jpeg', 'image/png'].includes(file.mimetype)) throw new IdentityError('VALIDATION_FAILED', 400);
    const bytes = file.buffer;
    const jpeg = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if ((file.mimetype === 'image/jpeg' && !jpeg) || (file.mimetype === 'image/png' && !png)) throw new IdentityError('VALIDATION_FAILED', 400);
    let cleaned: Buffer;
    try {
      const metadata = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error' }).metadata();
      if (!metadata.width || !metadata.height || metadata.width * metadata.height > 40_000_000) throw new Error('PIXEL_LIMIT');
      cleaned = await sharp(bytes).rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    } catch { throw new IdentityError('VALIDATION_FAILED', 400); }
    const key = `users/${userId}/avatars/${randomUUID()}.png`;
    await this.ensureBucket();
    await this.minio.putObject(BUCKET, key, cleaned, cleaned.length, { 'Content-Type': 'image/png' });
    return { object_key: key, mime_type: 'image/png', size_bytes: cleaned.length };
  }

  async validateKey(userId: string, value: unknown) {
    if (value === null) return;
    if (typeof value !== 'string' || !new RegExp(`^users/${userId}/avatars/[0-9a-f-]{36}\\.png$`).test(value)) throw new IdentityError('VALIDATION_FAILED', 400);
    try { await this.minio.statObject(BUCKET, value); }
    catch { throw new IdentityError('RESOURCE_NOT_FOUND', 404); }
  }

  async read(key: string) { return this.minio.getObject(BUCKET, key); }

  async cleanupOrphans() {
    try {
      for await (const object of this.minio.listObjectsV2(BUCKET, 'users/', true)) {
        if (!object.name || !object.lastModified || Date.now() - object.lastModified.getTime() < 24 * 3600_000) continue;
        const used = await this.db.query<{ count: string }>('SELECT count(*)::text AS count FROM users WHERE avatar_object_key=$1', [object.name]);
        if (used.rows[0]?.count === '0') await this.minio.removeObject(BUCKET, object.name);
      }
    } catch (error) { if ((error as { code?: string }).code !== 'NoSuchBucket') throw error; }
  }

  async onApplicationShutdown() { /* MinIO client owns no persistent socket pool. */ }
}
