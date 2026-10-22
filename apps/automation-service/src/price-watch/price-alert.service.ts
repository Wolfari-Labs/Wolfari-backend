import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PriceWatchError } from './price-watch.errors';
import { PriceWatchAccessService } from './price-watch-access.service';
import { PriceAlertRepository, type ClaimedPriceAlert } from './price-alert.repository';

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
export class PriceAlertService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PriceAlertService.name);
  private readonly owner = `price-alert:${randomUUID()}`;
  private readonly workerEnabled: boolean;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly batchSize: number;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    config: ConfigService,
    private readonly repository: PriceAlertRepository,
    private readonly access: PriceWatchAccessService,
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
    this.batchSize = integer(
      'PRICE_WATCH_WORKER_BATCH_SIZE',
      config.get<string>('PRICE_WATCH_WORKER_BATCH_SIZE'),
      20,
      1,
      100,
    );
  }

  onApplicationBootstrap(): void {
    if (!this.workerEnabled) return;
    const kick = () => {
      if (this.stopped || this.running) return;
      this.running = this.runCycle()
        .catch(() => this.logger.warn('PRICE_ALERT_WORKER_UNAVAILABLE'))
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

  async runCycle(): Promise<void> {
    await this.repository.failExhaustedLeases(this.batchSize);
    for (let count = 0; count < this.batchSize; count++) {
      const candidate = await this.repository.claimNext(this.owner, this.leaseMs);
      if (!candidate) return;
      await this.execute(candidate);
    }
  }

  private async execute(candidate: ClaimedPriceAlert): Promise<void> {
    let context;
    try {
      context = await this.access.get(candidate.trip_id, candidate.user_id, randomUUID());
    } catch (error) {
      if (error instanceof PriceWatchError && error.code !== 'SERVICE_UNAVAILABLE') {
        await this.repository.applyAccessLoss(this.owner, candidate, 'ACCESS_REVOKED');
        return;
      }
      await this.repository.retry(this.owner, candidate, 'TRIP_ACCESS_UNAVAILABLE');
      return;
    }
    if (context.state !== 'ACTIVE') {
      await this.repository.applyAccessLoss(this.owner, candidate, 'TRIP_ARCHIVED');
      return;
    }
    if (context.membershipId !== candidate.owner_membership_id) {
      await this.repository.applyAccessLoss(this.owner, candidate, 'ACCESS_REVOKED');
      return;
    }
    const completed = await this.repository.completeNotification(
      this.owner,
      candidate,
      context.membershipId,
    );
    if (completed === 'STALE') this.logger.warn('PRICE_ALERT_STALE_COMPLETION');
  }
}
