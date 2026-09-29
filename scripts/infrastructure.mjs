import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Agent } from 'node:http';
import pg from 'pg';
import amqp from 'amqplib';
import { Client as Minio } from 'minio';
import { root, services, databaseUrl, validateInfra } from './config.mjs';

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Lệnh ${command} thất bại (${code ?? signal}).`)));
  });
}

export function compose(env, args, { project = 'wolfari', envFile = resolve(root, '.env') } = {}) {
  validateInfra(env);
  return run('docker', ['compose', '--project-name', project, '--env-file', envFile, '-f', resolve(root, 'infrastructure/docker-compose.yml'), ...args], {
    env: { ...process.env, ...env }, timeout: 300000,
  });
}

export async function infrastructureCheck(env) {
  validateInfra(env);
  for (const service of services) {
    const client = new pg.Client({ connectionString: databaseUrl(env, service), connectionTimeoutMillis: 3000, query_timeout: 3000 });
    client.on('error', () => {});
    try {
      await client.connect();
      const { rows: [row] } = await client.query('SELECT current_database() AS db, current_user AS role');
      if (row.db !== `${service}_db` || row.role !== `${service}_app`) throw new Error('WRONG_DATABASE_OR_ROLE');
    } finally { await client.end().catch(() => {}); }
  }
  console.log('PASS PostgreSQL: 5 credential/database');
  const broker = await amqp.connect({ hostname: '127.0.0.1', port: +env.RABBITMQ_PORT, username: env.RABBITMQ_DEFAULT_USER, password: env.RABBITMQ_DEFAULT_PASS, heartbeat: 5 }, { timeout: 5000 });
  broker.on('error', () => {});
  try {
    const channel = await broker.createChannel();
    const queue = await channel.assertQueue('', { exclusive: true, autoDelete: true });
    await channel.deleteQueue(queue.queue);
    await channel.close();
  } finally { await broker.close(); }
  console.log('PASS RabbitMQ: đăng nhập AMQP');
  const storage = new Minio({ endPoint: '127.0.0.1', port: +env.MINIO_API_PORT, useSSL: false, accessKey: env.MINIO_ROOT_USER, secretKey: env.MINIO_ROOT_PASSWORD, transportAgent: new Agent({ timeout: 5000 }) });
  storage.setRequestOptions({ timeout: 5000 });
  const bucket = `wolfari-smoke-${randomUUID()}`;
  const key = 'probe.txt';
  let created = false;
  try {
    await storage.makeBucket(bucket); created = true;
    try {
      const policy = await storage.getBucketPolicy(bucket);
      if (policy) throw new Error('SMOKE_BUCKET_NOT_PRIVATE');
    } catch (error) {
      if (error?.code !== 'NoSuchBucketPolicy') throw error;
    }
    await storage.putObject(bucket, key, Buffer.from('wolfari-smoke'));
    const stream = await storage.getObject(bucket, key);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    if (Buffer.concat(chunks).toString() !== 'wolfari-smoke') throw new Error('STORAGE_CONTENT_MISMATCH');
    const anonymous = await fetch(`http://127.0.0.1:${env.MINIO_API_PORT}/${bucket}/${key}`, { signal: AbortSignal.timeout(5000) });
    await anonymous.body?.cancel();
    if (anonymous.status !== 403) throw new Error('STORAGE_ANONYMOUS_ACCESS');
  } finally {
    if (created) { await storage.removeObject(bucket, key); await storage.removeBucket(bucket); }
  }
  console.log('PASS MinIO: private, ghi/đọc/xóa; đã dọn bucket thử');
  if (env.MAILPIT_UI_PORT) {
    const inbox = await fetch(`http://127.0.0.1:${env.MAILPIT_UI_PORT}/api/v1/info`, { signal: AbortSignal.timeout(5000) });
    await inbox.body?.cancel();
    if (!inbox.ok) throw new Error('MAILPIT_NOT_READY');
    console.log('PASS Mailpit: giao diện và API local');
  }
}
