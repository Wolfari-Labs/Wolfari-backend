import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseProvider } from '@wolfari/database';
import { Client } from 'minio';
import sharp from 'sharp';
import { Agent } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fail, uuid } from './trip-common';
import { ACCESS_SQL, type AccessRow } from './planning/plan.projection';
import { isPlanEditor } from './planning/plan.service';

export const TRIP_COVER_INPUT_LIMIT = 5 * 1024 * 1024;
const STORED_LIMIT = 2 * 1024 * 1024;
const BUCKET = 'wolfari-trip-covers';
const MIME = 'image/jpeg';

/** One private cover per trip; replacing or removing it deletes the previous object best-effort. */
@Injectable()
export class TripCoverService implements OnApplicationShutdown {
  private client?: Client;
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
  private async authorize(tripId: string, actorId: string, write: boolean) {
    const row = (await this.db.query<AccessRow>(ACCESS_SQL, [uuid(tripId), uuid(actorId)])).rows[0];
    if (!row) return fail('RESOURCE_NOT_FOUND', 404);
    if (write && !isPlanEditor(row.role, row.plan_edit_policy, row.selected_editor)) return fail('PERMISSION_DENIED', 403);
    if (write && row.archived_at !== null) return fail('STATE_CONFLICT', 409);
  }
  private async clean(bytes: Buffer, mime: string) {
    if (!bytes.length || bytes.length > TRIP_COVER_INPUT_LIMIT || !['image/jpeg', 'image/png'].includes(mime)) return fail('VALIDATION_FAILED', 400);
    const jpeg = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if ((mime === 'image/jpeg' && !jpeg) || (mime === 'image/png' && !png)) return fail('VALIDATION_FAILED', 400);
    try {
      const image = sharp(bytes, { limitInputPixels: 30_000_000, failOn: 'error' });
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height || metadata.width * metadata.height > 30_000_000 || (metadata.pages ?? 1) !== 1) throw Error('Invalid image');
      // Re-encoding strips EXIF (location) and caps the stored size.
      const cleaned = await image.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 80 }).toBuffer();
      if (!cleaned.length || cleaned.length > STORED_LIMIT) throw Error('Image limit');
      return cleaned;
    } catch { return fail('VALIDATION_FAILED', 400); }
  }
  async upload(tripId: string, actorId: string, content: Uint8Array, mime: string) {
    await this.authorize(tripId, actorId, true);
    if (!(content instanceof Uint8Array)) return fail('VALIDATION_FAILED', 400);
    const cleaned = await this.clean(Buffer.from(content), mime);
    const key = `trips/${uuid(tripId)}/cover/${randomUUID()}.jpg`;
    try {
      if (!await this.storage.bucketExists(BUCKET)) {
        try { await this.storage.makeBucket(BUCKET); }
        catch (error) { if (!await this.storage.bucketExists(BUCKET)) throw error; }
      }
      await this.storage.putObject(BUCKET, key, cleaned, cleaned.length, { 'Content-Type': MIME });
    } catch { return fail('SERVICE_UNAVAILABLE', 503); }
    const previous = await this.swap(tripId, key);
    if (previous) await this.storage.removeObject(BUCKET, previous).catch(() => {});
  }
  async remove(tripId: string, actorId: string) {
    await this.authorize(tripId, actorId, true);
    const previous = await this.swap(tripId, null);
    if (previous) await this.storage.removeObject(BUCKET, previous).catch(() => {});
  }
  /** Sets the key and returns the old one; bumps export_revision so exports and clients refresh. */
  private async swap(tripId: string, key: string | null) {
    return this.db.withTransaction(async (client) => {
      const old = (await client.query<{ cover_image_key: string | null }>('SELECT cover_image_key FROM trips WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [uuid(tripId)])).rows[0];
      if (!old) return fail('RESOURCE_NOT_FOUND', 404);
      if (old.cover_image_key === key) return null;
      await client.query('UPDATE trips SET cover_image_key=$2,export_revision=export_revision+1,updated_at=now() WHERE id=$1', [uuid(tripId), key]);
      return old.cover_image_key;
    });
  }
  async download(tripId: string, actorId: string) {
    await this.authorize(tripId, actorId, false);
    const row = (await this.db.query<{ cover_image_key: string | null }>('SELECT cover_image_key FROM trips WHERE id=$1 AND deleted_at IS NULL', [uuid(tripId)])).rows[0];
    if (!row?.cover_image_key) return fail('RESOURCE_NOT_FOUND', 404);
    if (!row.cover_image_key.startsWith(`trips/${uuid(tripId)}/cover/`)) return fail('SERVICE_UNAVAILABLE', 503);
    const stream = await this.storage.getObject(BUCKET, row.cover_image_key);
    const chunks: Buffer[] = []; let size = 0;
    try {
      for await (const value of stream) {
        const part = Buffer.from(value); size += part.length;
        if (size > STORED_LIMIT) { stream.destroy(); return fail('SERVICE_UNAVAILABLE', 503); }
        chunks.push(part);
      }
    } finally { stream.destroy(); }
    if (!size) return fail('RESOURCE_NOT_FOUND', 404);
    return { content: Buffer.concat(chunks), mime_type: MIME, size_bytes: size };
  }
  onApplicationShutdown() { this.agent.destroy(); }
}
