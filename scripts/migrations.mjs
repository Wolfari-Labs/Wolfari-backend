import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { root, appNames } from './config.mjs';

export async function migrationFiles(service, base = root) {
  const directory = `apps/${appNames[service]}/migrations`;
  const manifest = new Map((await readFile(resolve(base, 'docs/database/SHA256SUMS.txt'), 'utf8')).trim().split(/\r?\n/).map(line => {
    const match = /^([a-f0-9]{64})\s+(.+)$/.exec(line);
    if (!match) throw new Error('Manifest checksum không hợp lệ.');
    return [match[2], match[1]];
  }));
  const names = (await readdir(resolve(base, directory))).filter(name => /^V\d{3}\.sql$/.test(name)).sort();
  if (!names.length) throw new Error('MISSING_MIGRATION_FILES');
  return Promise.all(names.map(async (name, i) => {
    if (name !== `V${String(i + 1).padStart(3, '0')}.sql`) throw new Error('Migration phải liên tục từ V001.');
    const bytes = await readFile(resolve(base, directory, name));
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.get(`${directory}/${name}`)) throw new Error(`CHECKSUM_MISMATCH: ${service}/${name}`);
    return { version: name.slice(0, -4), sql: bytes.toString('utf8') };
  }));
}

export async function connectDatabase(service, connectionString) {
  let url;
  try { url = new URL(connectionString); } catch { throw new Error('INVALID_DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname !== `/${service}_db` || decodeURIComponent(url.username) !== `${service}_app` || !url.password || url.search || url.hash) throw new Error('WRONG_DATABASE_OR_ROLE');
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2000, statement_timeout: 30000, application_name: 'wolfari-migration' });
  client.on('error', () => {});
  try {
    await client.connect();
    const { rows: [row] } = await client.query('SELECT current_database() AS db, current_user AS role');
    if (row.db !== `${service}_db` || row.role !== `${service}_app`) throw new Error('WRONG_DATABASE_OR_ROLE');
    return client;
  } catch (error) { await client.end().catch(() => {}); throw error; }
}

export async function history(client, files) {
  const { rows } = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  const hasHistory = rows.some(r => r.tablename === 'schema_migrations');
  if (!hasHistory) {
    const { rows: objects } = await client.query("SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace UNION ALL SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace LIMIT 1");
    if (objects.length) throw new Error('UNVERSIONED_SCHEMA');
    return [];
  }
  const versions = (await client.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r => r.version);
  if (!versions.length || versions.some((version, i) => version !== files[i]?.version)) throw new Error('UNKNOWN_OR_INVALID_MIGRATION_HISTORY');
  return versions;
}

export async function migrate(service, connectionString, files, lockMs = 30000) {
  const client = await connectDatabase(service, connectionString);
  try {
    // Session lock survives BEGIN/COMMIT inside each SQL file.
    const started = Date.now();
    while (!(await client.query('SELECT pg_try_advisory_lock(1464814674, 1) AS locked')).rows[0].locked) {
      if (Date.now() - started >= lockMs) throw new Error('MIGRATION_LOCK_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const applied = await history(client, files);
    for (const file of files.filter(file => !applied.includes(file.version))) {
      await client.query(file.sql);
      const updated = await history(client, files);
      if (!updated.includes(file.version)) throw new Error('MIGRATION_NOT_RECORDED');
    }
    return await history(client, files);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await client.end(); }
}

export function safeError(error) {
  // Never print driver messages, SQL, URLs or CLI stderr containing credentials.
  const message = String(error.message ?? '');
  if (/^[A-Z_]+$/.test(message)) return message;
  if (message.startsWith('CHECKSUM_MISMATCH:')) return message;
  if (/^(Thiếu cấu hình|Cần cấu hình|Cổng không hợp lệ|Role |Cấu hình |Dùng --service|Lệnh |Manifest |Migration phải|Khởi động bằng)/.test(message) && !error.code) return message;
  return `Thao tác thất bại (${error.code ?? 'ERROR'}). Kiểm tra kết nối, credential và cấu hình; không tự xóa volume.`;
}
