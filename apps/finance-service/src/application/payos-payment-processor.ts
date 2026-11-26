import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { PayosError, PayosProvider } from '../providers/payos.provider';
import { PayosPaymentRepository } from '../repositories/payos-payment.repository';

/**
 * Background steps of a payOS attempt: create the payment link, settle verified webhooks and ask
 * payOS about attempts whose outcome is unknown. Every provider call runs outside a transaction.
 */
@Injectable()
export class PayosPaymentProcessor implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('PayosPaymentProcessor');
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private readonly active = new Set<string>();
  constructor(
    private readonly rows: PayosPaymentRepository,
    private readonly provider: PayosProvider,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => this.kick(), 1000);
    this.timer.unref();
    this.kick();
  }
  kick() {
    this.running ??= this.runOnce()
      .catch(() => this.logger.warn('PAYOS_PROCESSOR_UNAVAILABLE'))
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
    await this.rows.markStale();
    for (const id of await this.rows.dispatchCandidates())
      await this.exclusive(`create:${id}`, async () => {
        const command = await this.rows.claimDispatch(id);
        if (!command) return;
        try {
          const link = await this.provider.create(command);
          await this.rows.completeDispatch(
            id,
            link,
            this.provider.paysIntoAccount(link, command.destinationName),
          );
        } catch (error) {
          const known = error instanceof PayosError ? error : undefined;
          this.logger.warn(`PAYOS_CREATE_FAILED code=${(known?.code ?? 'UNKNOWN').slice(0, 40)}`);
          await this.rows.failDispatch(id, known);
        }
      });
    for (const id of await this.rows.webhookCandidates())
      await this.exclusive(`webhook:${id}`, () => this.rows.processWebhook(id));
    for (const id of await this.rows.reconciliationCandidates())
      await this.exclusive(`query:${id}`, async () => {
        const command = await this.rows.reconciliationCommand(id);
        if (!command) return;
        try {
          await this.rows.completeQuery(id, await this.provider.get(command.orderCode, command.amount));
        } catch (error) {
          await this.rows.failQuery(id, error instanceof PayosError ? error : undefined);
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
