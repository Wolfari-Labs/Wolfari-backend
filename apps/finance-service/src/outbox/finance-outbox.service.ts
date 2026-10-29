import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FinanceOutboxRepository } from './finance-outbox.repository';
import { FinanceOutboxPublisher } from './finance-outbox.publisher';
import { storedFinanceEvent, type FinanceEvent } from './finance-outbox.event';

@Injectable()
export class FinanceOutboxService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(FinanceOutboxService.name);
  private readonly enabled: boolean;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    @Inject(FinanceOutboxRepository)
    private readonly repository: Pick<
      FinanceOutboxRepository,
      'claimNext' | 'complete' | 'fail' | 'diagnostics'
    >,
    @Inject(FinanceOutboxPublisher)
    private readonly publisher: Pick<FinanceOutboxPublisher, 'publish' | 'close' | 'connected'>,
    config: ConfigService,
  ) {
    this.enabled = config.get('FINANCE_OUTBOX_ENABLED') === 'true';
  }

  onApplicationBootstrap(): void {
    if (!this.enabled || this.stopped || this.timer) return;
    const tick = () => {
      void this.runOnce().catch(() => this.logger.warn('FINANCE_OUTBOX_UNAVAILABLE'));
    };
    this.timer = setInterval(tick, 1000);
    this.timer.unref();
    tick();
  }

  runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    const running = this.run().finally(() => {
      if (this.running === running) this.running = undefined;
    });
    this.running = running;
    return running;
  }

  private async run(): Promise<void> {
    for (let count = 0; count < 10 && !this.stopped; count++) {
      const claim = await this.repository.claimNext();
      if (!claim || this.stopped) return;
      let event: FinanceEvent;
      try {
        event = storedFinanceEvent(claim);
      } catch {
        await this.repository.fail(claim, 'INVALID_EVENT', true);
        continue;
      }
      try {
        await this.publisher.publish(event);
      } catch {
        await this.repository.fail(claim, 'PUBLISH_FAILED');
        continue;
      }
      // Broker confirmation and SQL acknowledgement cannot commit atomically.
      // A failed finalization leaves the lease recoverable with the original event ID.
      const completed = await this.repository.complete(claim);
      if (!completed) this.logger.warn('FINANCE_OUTBOX_STALE_COMPLETION');
    }
  }

  async diagnostics() {
    return {
      enabled: this.enabled,
      broker: this.publisher.connected ? 'up' : 'down',
      outbox: await this.repository.diagnostics(),
    };
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    // Transport close aborts its bounded active operation; database work has provider timeouts.
    try {
      await this.publisher.close();
    } finally {
      await this.running?.catch(() => {});
    }
  }
}
