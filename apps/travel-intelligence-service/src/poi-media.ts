import { createHash, createHmac } from 'node:crypto';
import type { DatabaseProvider } from '@wolfari/database';
import type { TravelV1 } from '@wolfari/contracts/grpc';

/** POI-IMAGES (travel_db V006): licensed photos kept outside POI snapshots. */
export const POI_IMAGE_BUCKET = 'wolfari-poi-images';
export const POI_IMAGE_WIDTHS = [320, 640, 1280] as const;
export const SHA256 = /^[0-9a-f]{64}$/;
type Queryable = Pick<DatabaseProvider, 'query'>;
type HeroRow = {
  poi_id: string;
  sha256: string;
  width: number | null;
  height: number | null;
  author: string | null;
  license_code: string;
  license_url: string | null;
  source_url: string;
  attribution: string;
  source: string;
};

/**
 * Best accepted hero of the active batch for each POI id. A curated (golden) photo wins over one
 * keyed by an Overture GERS id; a merged Overture POI may carry several GERS ids. Before V006 or
 * with no active batch, nothing is attached.
 */
const HEROES_SQL = `SELECT DISTINCT ON (p.id) p.id AS poi_id, m.sha256, m.width, m.height, m.author,
    m.license_code, m.license_url, m.source_url, m.attribution, m.source
  FROM pois p
  JOIN poi_media m ON m.batch_id = $2 AND m.role = 'hero' AND m.status = 'accepted'
   AND (m.golden_key = p.wolfari_key
        OR m.gers_id IN (SELECT s.source_id FROM poi_sources s WHERE s.poi_id = p.id AND s.source = 'overture'))
  WHERE p.id = ANY($1::uuid[])
  ORDER BY p.id, (m.golden_key IS NOT NULL) DESC, m.final_score DESC NULLS LAST, m.sha256`;

export async function activeMediaBatch(db: Queryable): Promise<string | null> {
  try {
    const { rows } = await db.query<{ id: string }>('SELECT id FROM poi_media_batches WHERE is_active LIMIT 1');
    return rows[0]?.id ?? null;
  } catch (error) {
    // 42P01: V006 not applied yet — search keeps working without photos.
    if ((error as { code?: string }).code === '42P01') return null;
    throw error;
  }
}

export async function heroImages(db: Queryable, poiIds: string[]): Promise<Map<string, TravelV1.PlaceImage>> {
  const heroes = new Map<string, TravelV1.PlaceImage>();
  if (!poiIds.length) return heroes;
  const batch = await activeMediaBatch(db);
  if (!batch) return heroes;
  const { rows } = await db.query<HeroRow>(HEROES_SQL, [poiIds, batch]);
  for (const row of rows) {
    if (!SHA256.test(row.sha256)) continue;
    heroes.set(row.poi_id, {
      sha256: row.sha256,
      width: row.width ?? 0,
      height: row.height ?? 0,
      author: row.author ?? '',
      license: row.license_code,
      license_url: row.license_url ?? '',
      source_url: row.source_url,
      attribution: row.attribution,
      source: row.source,
    });
  }
  return heroes;
}

/** True when this photo is accepted in the active batch (taken-down or unknown photos are not served). */
export async function servablePhoto(db: Queryable, sha256: string): Promise<boolean> {
  const batch = await activeMediaBatch(db);
  if (!batch) return false;
  const { rows } = await db.query(
    "SELECT 1 FROM poi_media WHERE sha256 = $1 AND batch_id = $2 AND status = 'accepted' LIMIT 1",
    [sha256, batch],
  );
  return rows.length > 0;
}

/**
 * Minimal S3 GetObject with AWS Signature V4 (path-style, region us-east-1) for the local MinIO,
 * so the travel service needs no storage SDK. Returns null for a missing object.
 */
export async function getObject(
  config: { endpoint: string; accessKey: string; secretKey: string },
  bucket: string,
  key: string,
  { signal, now = new Date() }: { signal?: AbortSignal; now?: Date } = {},
): Promise<Buffer | null> {
  const [host, port] = config.endpoint.split(':');
  if (!host || !/^\d+$/.test(port ?? '')) throw new Error('MINIO_ENDPOINT');
  const path = `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = createHash('sha256').update('').digest('hex');
  const headers = { host: `${host}:${port}`, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const signed = Object.keys(headers).sort();
  const canonical = ['GET', path, '', ...signed.map((h) => `${h}:${headers[h as keyof typeof headers]}`), '', signed.join(';'), payloadHash].join('\n');
  const scope = `${day}/us-east-1/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
  const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretKey}`, day), 'us-east-1'), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
  const response = await fetch(`http://${host}:${port}${path}`, {
    headers: {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`,
    },
    signal,
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`MINIO_${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
