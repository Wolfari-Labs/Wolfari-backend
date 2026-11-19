import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseProvider } from '@wolfari/database';
import { Client } from 'minio';
import sharp from 'sharp';
import { Agent } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fail, uuid } from '../trip-common';
import { ACCESS_SQL, type AccessRow } from './plan.projection';
import { isPlanEditor } from './plan.service';

export const DRESS_IMAGE_LIMIT = 2 * 1024 * 1024;
const BUCKET = 'wolfari-trip-dress-images';
const MIME = 'image/jpeg';

@Injectable()
export class DressCodeImageService implements OnApplicationShutdown {
  private client?: Client;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private readonly agent = new Agent({ keepAlive: false, timeout: 5000, maxSockets: 2 });
  constructor(private readonly config: ConfigService, private readonly db: DatabaseProvider) {}
  private get storage() {
    if (!this.client) {
      const [host, port] = (this.config.get<string>('MINIO_ENDPOINT') ?? '').split(':');
      if (!host || !/^\d+$/.test(port ?? '')) return fail('SERVICE_UNAVAILABLE', 503);
      this.client = new Client({ endPoint: host, port: Number(port), useSSL: false,
        accessKey: this.config.getOrThrow<string>('MINIO_ACCESS_KEY'), secretKey: this.config.getOrThrow<string>('MINIO_SECRET_KEY'), transportAgent: this.agent });
    }
    return this.client;
  }
  key(tripId: string, actorId: string, imageId: string) {
    return `trips/${uuid(tripId)}/dress-images/${uuid(actorId)}/${uuid(imageId)}.jpg`;
  }
  async authorize(tripId: string, actorId: string, write: boolean, allowArchived = false) {
    const row = (await this.db.query<AccessRow>(ACCESS_SQL, [uuid(tripId), uuid(actorId)])).rows[0];
    if (!row) return fail('RESOURCE_NOT_FOUND', 404);
    if (write && !isPlanEditor(row.role, row.plan_edit_policy, row.selected_editor)) return fail('PERMISSION_DENIED', 403);
    if (write && !allowArchived && row.archived_at !== null) return fail('STATE_CONFLICT', 409);
  }
  async upload(tripId: string, actorId: string, content: Uint8Array, mime: string) {
    await this.authorize(tripId, actorId, true);
    if (!(content instanceof Uint8Array)) return fail('VALIDATION_FAILED', 400);
    const bytes = Buffer.from(content);
    if (!bytes.length || bytes.length > DRESS_IMAGE_LIMIT || !['image/jpeg', 'image/png'].includes(mime)) return fail('VALIDATION_FAILED', 400);
    const jpeg = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if ((mime === 'image/jpeg' && !jpeg) || (mime === 'image/png' && !png)) return fail('VALIDATION_FAILED', 400);
    let cleaned: Buffer;
    try {
      const image = sharp(bytes, { limitInputPixels: 20_000_000, failOn: 'error' });
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height || metadata.width * metadata.height > 20_000_000 || (metadata.pages ?? 1) !== 1) throw Error('Invalid image');
      cleaned = await image.rotate().resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toBuffer();
      if (!cleaned.length || cleaned.length > DRESS_IMAGE_LIMIT) throw Error('Image limit');
    } catch { return fail('VALIDATION_FAILED', 400); }
    const imageId = randomUUID(), key = this.key(tripId, actorId, imageId);
    try {
      if (!await this.storage.bucketExists(BUCKET)) {
        try { await this.storage.makeBucket(BUCKET); }
        catch (error) { if (!await this.storage.bucketExists(BUCKET)) throw error; }
      }
      await this.storage.putObject(BUCKET, key, cleaned, cleaned.length, { 'Content-Type': MIME });
    } catch { return fail('SERVICE_UNAVAILABLE', 503); }
    if (!this.cleanupTimer) { this.cleanupTimer = setInterval(() => { void this.cleanup().catch(() => {}); }, 3600_000); this.cleanupTimer.unref(); }
    return { image_id: imageId, mime_type: MIME, size_bytes: cleaned.length };
  }
  async validate(tripId: string, actorId: string, imageId: string) {
    await this.authorize(tripId, actorId, true);
    const key = this.key(tripId, actorId, imageId);
    try {
      const stat = await this.storage.statObject(BUCKET, key);
      if (stat.size < 1 || stat.size > DRESS_IMAGE_LIMIT || stat.metaData['content-type'] !== MIME) return fail('VALIDATION_FAILED', 400);
      if (!stat.lastModified || Date.now() - stat.lastModified.getTime() >= 24 * 3600_000) return fail('VALIDATION_FAILED', 400);
    } catch (error) {
      if (['NotFound', 'NoSuchKey', 'NoSuchObject'].includes(String((error as { code?: string }).code))) return fail('RESOURCE_NOT_FOUND', 404);
      throw error;
    }
    return key;
  }
  async download(tripId: string, actorId: string, dressCodeId: string) {
    await this.authorize(tripId, actorId, false);
    const row = (await this.db.query<{ reference_image_key: string | null }>('SELECT reference_image_key FROM dress_codes WHERE id=$1 AND trip_id=$2', [uuid(dressCodeId), uuid(tripId)])).rows[0];
    if (!row?.reference_image_key) return fail('RESOURCE_NOT_FOUND', 404);
    if (!row.reference_image_key.startsWith(`trips/${tripId}/dress-images/`)) return fail('SERVICE_UNAVAILABLE', 503);
    const stream = await this.storage.getObject(BUCKET, row.reference_image_key);
    const chunks: Buffer[] = []; let size = 0;
    try {
      for await (const value of stream) {
        const part = Buffer.from(value); size += part.length;
        if (size > DRESS_IMAGE_LIMIT) { stream.destroy(); return fail('SERVICE_UNAVAILABLE', 503); }
        chunks.push(part);
      }
    } finally { stream.destroy(); }
    if (!size) return fail('RESOURCE_NOT_FOUND', 404);
    return { content: Buffer.concat(chunks), mime_type: MIME, size_bytes: size };
  }
  async cleanup() {
    for await (const object of this.storage.listObjectsV2(BUCKET, 'trips/', true)) {
      if (!object.name || !object.lastModified || Date.now() - object.lastModified.getTime() < 48 * 3600_000) continue;
      const used = await this.db.query('SELECT id FROM dress_codes WHERE reference_image_key=$1 LIMIT 1', [object.name]);
      if (!used.rows.length) await this.storage.removeObject(BUCKET, object.name);
    }
  }
  onApplicationShutdown() { if (this.cleanupTimer) clearInterval(this.cleanupTimer); this.agent.destroy(); }
}
