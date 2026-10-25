import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { MomoSandboxProvider } from '../providers/momo-sandbox.provider';
import { PaymentRepository } from '../repositories/payment.repository';

@Injectable()
export class PaymentProcessor implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('PaymentProcessor');
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private readonly active = new Set<string>();
  constructor(
    private readonly rows: PaymentRepository,
    private readonly provider: MomoSandboxProvider,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => this.kick(), 1000);
    this.timer.unref();
    this.kick();
  }
  kick() {
    this.running ??= this.runOnce()
      .catch(() => this.logger.warn('PAYMENT_PROCESSOR_UNAVAILABLE'))
      .finally(() => {
        this.running = undefined;
      });
  }
  async onApplicationShutdown() {
    clearInterval(this.timer);
    await this.running;
  }
  async runOnce() {
    if (!this.provider.ready()) return;
    await this.rows.markStaleDispatches();
    for (const id of await this.rows.dispatchCandidates())
      await this.exclusive(`create:${id}`, async () => {
        const command = await this.rows.claimDispatch(id);
        if (!command) return;
        try {
          const result = await this.provider.create(command);
          await this.rows.completeDispatch(id, result);
        } catch (error) {
          this.logger.warn(
            `PAYMENT_CREATE_FAILED code=${String((error as { code?: unknown })?.code ?? 'UNKNOWN').slice(0, 32)}`,
          );
          await this.rows.failDispatch(id);
        }
      });
    for (const id of await this.rows.webhookCandidates())
      await this.exclusive(`webhook:${id}`, () => this.rows.processWebhook(id));
    for (const id of await this.rows.reconciliationCandidates())
      await this.exclusive(`query:${id}`, async () => {
        const command = await this.rows.reconciliationCommand(id);
        if (!command) return;
        try {
          await this.rows.completeQuery(id, await this.provider.query(command));
        } catch {
          await this.rows.failQuery(id);
        }
      });
  }
  private async exclusive(key: string, work: () => Promise<unknown>) {
    if (this.active.has(key)) return;
    this.active.add(key);
    try {
      await work();
    } finally {
      this.active.delete(key);
    }
  }
}
