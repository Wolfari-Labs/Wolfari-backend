import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { MockFlightPriceProvider } from './price-watch-provider';
import {
  PriceProviderFailure,
  safeProviderFailure,
  validateProviderResult,
  type ClaimedPriceAttempt,
  type PriceProviderResult,
} from './price-watch-worker.domain';
import { PriceWatchWorkerRepository } from './price-watch-worker.repository';

function enabled(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('PRICE_WATCH_WORKER_ENABLED must be true or false');
}

function integer(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = value ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const result = Number(raw);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum)
    throw new Error(`${name} is out of range`);
  return result;
}

@Injectable()
export class PriceWatchWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PriceWatchWorkerService.name);
  private readonly owner = `price-watch:${randomUUID()}`;
  private readonly workerEnabled: boolean;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly providerTimeoutMs: number;
  private readonly batchSize: number;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    config: ConfigService,
    private readonly repository: PriceWatchWorkerRepository,
    private readonly provider: MockFlightPriceProvider,
  ) {
    this.workerEnabled = enabled(config.get<string>('PRICE_WATCH_WORKER_ENABLED'));
    this.pollMs = integer(
      'PRICE_WATCH_WORKER_POLL_MS',
      config.get<string>('PRICE_WATCH_WORKER_POLL_MS'),
      1000,
      100,
      60_000,
    );
    this.leaseMs = integer(
      'PRICE_WATCH_ATTEMPT_LEASE_MS',
      config.get<string>('PRICE_WATCH_ATTEMPT_LEASE_MS'),
      30_000,
      1000,
      300_000,
    );
    this.providerTimeoutMs = integer(
      'PRICE_WATCH_PROVIDER_TIMEOUT_MS',
      config.get<string>('PRICE_WATCH_PROVIDER_TIMEOUT_MS'),
      5000,
      50,
      60_000,
    );
    this.batchSize = integer(
      'PRICE_WATCH_WORKER_BATCH_SIZE',
      config.get<string>('PRICE_WATCH_WORKER_BATCH_SIZE'),
      20,
      1,
      100,
    );
    if (this.providerTimeoutMs >= this.leaseMs)
      throw new Error('PRICE_WATCH_PROVIDER_TIMEOUT_MS must be shorter than the lease');
    if (this.workerEnabled && config.get<string>('NODE_ENV') === 'production')
      throw new Error('MOCK_FLIGHT worker cannot run in production');
  }

  onApplicationBootstrap(): void {
    if (!this.workerEnabled) return;
    const kick = () => {
      if (this.stopped || this.running) return;
      this.running = this.runCycle()
        .catch(() => this.logger.warn('PRICE_WATCH_WORKER_UNAVAILABLE'))
        .finally(() => {
          this.running = undefined;
        });
    };
    this.timer = setInterval(kick, this.pollMs);
    this.timer.unref();
    kick();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }

  async runCycle(now = new Date()): Promise<void> {
    await this.repository.scheduleDue(now, this.batchSize);
    await this.repository.failExhaustedLeases(this.batchSize);
    for (let count = 0; count < this.batchSize; count++) {
      const attempt = await this.repository.claimNext(this.owner, this.leaseMs);
      if (!attempt) return;
      await this.execute(attempt);
    }
  }

  private async execute(attempt: ClaimedPriceAttempt): Promise<void> {
    let result: ReturnType<typeof validateProviderResult>;
    try {
      result = validateProviderResult(await this.providerCall(attempt));
    } catch (error) {
      const failure = safeProviderFailure(error);
      const completed = await this.repository.completeFailure(
        this.owner,
        attempt,
        failure.errorCode,
        failure.transient,
      );
      if (completed === 'STALE') this.logger.warn('PRICE_WATCH_STALE_COMPLETION');
      return;
    }
    const completed = result
      ? await this.repository.completeSuccess(this.owner, attempt, result)
      : await this.repository.completeNoResult(this.owner, attempt);
    if (!completed) this.logger.warn('PRICE_WATCH_STALE_COMPLETION');
  }

  private async providerCall(attempt: ClaimedPriceAttempt): Promise<PriceProviderResult> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PriceProviderFailure('PROVIDER_TIMEOUT', true));
      }, this.providerTimeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([
        this.provider.fetch({
          canonicalKey: attempt.canonical_key,
          scheduledSlot: attempt.scheduled_slot,
          query: attempt.query,
          signal: controller.signal,
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
