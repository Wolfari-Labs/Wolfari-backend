import { Controller, DynamicModule, Get, Header, Inject, Injectable, Logger, Module, OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { currentCorrelationId } from '@wolfari/common';
import { Pool, PoolClient, PoolConfig, QueryResultRow } from 'pg';

export type DatabaseServiceName = 'identity' | 'trip' | 'travel' | 'finance' | 'automation';
const DATABASE_OPTIONS = Symbol('DATABASE_OPTIONS');
const DATABASE_NAME = Symbol('DATABASE_NAME');
export const DATABASE_POOL = Symbol('DATABASE_POOL');

export function databaseConfig(values: Record<string, unknown>, service: DatabaseServiceName): PoolConfig {
  let url: URL;
  try { url = new URL(String(values.DATABASE_URL ?? '')); } catch { throw new Error('DATABASE_URL không hợp lệ.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname !== `/${service}_db` || decodeURIComponent(url.username) !== `${service}_app` || !url.password || !url.hostname || url.search || url.hash) {
    throw new Error(`DATABASE_URL phải trỏ tới ${service}_db bằng ${service}_app, không có query/fragment.`);
  }
  const integer = (key: string, fallback: number, max: number) => {
    const raw = String(values[key] ?? fallback);
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw new Error(`${key} không hợp lệ.`);
    return Number(raw);
  };
  return {
    connectionString: url.href,
    application_name: `wolfari-${service}`,
    max: integer('DATABASE_POOL_MAX', 5, 50),
    connectionTimeoutMillis: integer('DATABASE_CONNECT_TIMEOUT_MS', 2000, 30000),
    idleTimeoutMillis: integer('DATABASE_IDLE_TIMEOUT_MS', 30000, 300000),
    statement_timeout: integer('DATABASE_STATEMENT_TIMEOUT_MS', 5000, 300000),
    idle_in_transaction_session_timeout: 10000,
  };
}

type Check = 'up' | 'down' | 'missing' | 'unchecked';
export interface Readiness {
  status: 'ok' | 'error';
  service: string;
  checks: { database: Check; migrations: Check };
  correlation_id: string | undefined;
}

@Injectable()
export class DatabaseProvider implements OnApplicationShutdown {
  private readonly logger = new Logger('DatabaseProvider');
  private readonly probe: Pool;
  private pendingProbe?: Promise<Omit<Readiness, 'correlation_id'>>;

  constructor(
    @Inject(DATABASE_POOL) readonly pool: Pool,
    @Inject(DATABASE_OPTIONS) options: PoolConfig,
    @Inject(DATABASE_NAME) private readonly name: DatabaseServiceName,
  ) {
    // A single separate probe connection avoids readiness queuing behind business transactions.
    this.probe = new Pool({ ...options, max: 1, connectionTimeoutMillis: 800, statement_timeout: 700, query_timeout: 800, idleTimeoutMillis: 1000 });
    for (const pool of [this.pool, this.probe]) pool.on('error', () => this.logger.warn('DATABASE_CONNECTION_ERROR'));
  }

  query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
    return this.pool.query<T>(text, values);
  }

  async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  }

  async readiness(): Promise<Readiness> {
    // Concurrent probes share one bounded attempt. Never leave timed-out queries in a queue.
    if (!this.pendingProbe) this.pendingProbe = this.check().finally(() => { this.pendingProbe = undefined; });
    return { ...await this.pendingProbe, correlation_id: currentCorrelationId() };
  }

  private async check(): Promise<Omit<Readiness, 'correlation_id'>> {
    const checks: Readiness['checks'] = { database: 'down', migrations: 'unchecked' };
    let client: PoolClient | undefined;
    try {
      client = await this.probe.connect();
      const identity = await client.query('SELECT current_database() AS db, current_user AS role');
      if (identity.rows[0]?.db === `${this.name}_db` && identity.rows[0]?.role === `${this.name}_app`) {
        checks.database = 'up';
        const migrations = await client.query("SELECT version FROM public.schema_migrations WHERE version='V001'");
        checks.migrations = migrations.rowCount === 1 ? 'up' : 'missing';
      }
    } catch (error) {
      if ((error as { code?: string }).code === '42P01') { checks.database = 'up'; checks.migrations = 'missing'; }
    } finally {
      // Destroy the probe socket, including on timeout, cancelling any pending server work.
      client?.release(true);
    }
    const service = this.name === 'trip' ? 'trip-workspace-service' : this.name === 'travel' ? 'travel-intelligence-service' : `${this.name}-service`;
    return { status: checks.database === 'up' && checks.migrations === 'up' ? 'ok' : 'error', service, checks };
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.pool.end(), this.probe.end()]);
  }
}

@Controller('health')
class ReadinessController {
  constructor(@Inject(DatabaseProvider) private readonly database: DatabaseProvider) {}

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready(): Promise<Readiness> {
    const result = await this.database.readiness();
    if (result.status !== 'ok') throw new ServiceUnavailableException(result);
    return result;
  }
}

@Module({})
export class DatabaseModule {
  static forService(service: DatabaseServiceName): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        { provide: DATABASE_NAME, useValue: service },
        { provide: DATABASE_OPTIONS, inject: [ConfigService], useFactory: (config: ConfigService) => databaseConfig(Object.fromEntries(['DATABASE_URL', 'DATABASE_POOL_MAX', 'DATABASE_CONNECT_TIMEOUT_MS', 'DATABASE_IDLE_TIMEOUT_MS', 'DATABASE_STATEMENT_TIMEOUT_MS'].map(key => [key, config.get(key)])), service) },
        { provide: DATABASE_POOL, inject: [DATABASE_OPTIONS], useFactory: (options: PoolConfig) => new Pool(options) },
        DatabaseProvider,
      ],
      controllers: [ReadinessController],
      exports: [DatabaseProvider, DATABASE_POOL],
    };
  }
}
