import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { FundQueryService } from './fund-query.service';
import { FinanceReadError, readUuid } from '../finance.errors';
import { MomoSandboxProvider } from '../providers/momo-sandbox.provider';
import { MomoCheckoutProvider } from '../providers/momo-checkout.provider';

type Input = {
  actor_user_id?: string;
  trip_id?: string;
  request_id?: string;
  amount?: string;
  note?: string;
  provider?: string;
  redirect_url?: string;
};
type StatusInput = { actor_user_id?: string; trip_id?: string; order_id?: string };
type Status = {
  order_id: string;
  status: 'PAID' | 'PENDING' | 'FAILED';
  amount: string;
  provider_transaction_id: string;
  environment: string;
};
type Wallet = 'MOMO_CHECKOUT';
type Order = { wallet: Wallet; actor: string; trip: string; amount: string; request: string; expires: number };
type Checkout = {
  request_id: string;
  order_id: string;
  amount: string;
  payment_url: string;
  environment: string;
};
type Entry = { fingerprint: string; expires: number; task?: Promise<Checkout>; result?: Checkout };

/** Error name/code only (e.g. MOMO_HTTP_400, fetch failed: ENOTFOUND): never request data or keys. */
const walletFailure = (cause: unknown) => {
  const error = cause as { message?: unknown; cause?: { code?: unknown } };
  const message = typeof error?.message === 'string' ? error.message.slice(0, 80) : 'UNKNOWN';
  const code = typeof error?.cause?.code === 'string' ? ` code=${error.cause.code.slice(0, 40)}` : '';
  return `reason=${JSON.stringify(message)}${code}`;
};
/** Gateway bounce page that hands the wallet's browser result back to the app. */
const RETURN_PATH = /^\/api\/v1\/qr-payments\/payment-return\/[A-Za-z0-9_-]{8,700}$/;
const ORDER_ID = /^\d{6}_w[a-f0-9]{24}$/;
/** Order IDs start with the order date in Vietnam time (yymmdd), readable in the MoMo test portal. */
const vietnamDate = (now: number) => new Date(now + 7 * 3_600_000).toISOString().slice(2, 10).replaceAll('-', '');
const asciiNote = (value: string) =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, (c) => (c === 'đ' ? 'd' : 'D')).replace(/[^\x20-\x7e]/g, '');

/**
 * Isolated MoMo test checkout. No fund, contribution, expense, ledger or receipt is
 * written here: the app records its own expense after a wallet order reports PAID.
 */
@Injectable()
export class QrSandboxService implements OnModuleInit {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly queries: FundQueryService,
    private readonly provider: MomoSandboxProvider,
    private readonly config: ConfigService,
    private readonly momoCheckout?: MomoCheckoutProvider,
  ) {}
  private readonly orders = new Map<string, Order>();
  private readonly logger = new Logger('QrSandbox');

  /** One startup line saying which sandbox wallets this process can use (no keys). */
  onModuleInit() {
    if (this.config.get('NODE_ENV') === 'production') return;
    const state = (name: string, ready: () => boolean) => {
      try { return ready() ? `${name}=ready` : `${name}=off`; } catch { return `${name}=invalid-config`; }
    };
    this.logger.log(`QR_SANDBOX_WALLETS ${state('momo_checkout', () => !!this.momoCheckout?.ready())}`);
  }

  async create(input: Input, correlation: string, deadline: number): Promise<Checkout> {
    const actor = readUuid(input.actor_user_id),
      trip = readUuid(input.trip_id),
      request = readUuid(input.request_id);
    const amount = input.amount,
      note = input.note;
    if (
      typeof amount !== 'string' ||
      !/^[1-9]\d{0,7}$/.test(amount) ||
      BigInt(amount) < 1000n ||
      BigInt(amount) > 50000000n ||
      typeof note !== 'string' ||
      note !== note.trim() ||
      !note ||
      [...note].length > 150 ||
      /[\u0000-\u001f\u007f]/.test(note)
    )
      throw new FinanceReadError('VALIDATION_FAILED');
    const provider = input.provider || 'MOMO';
    if (provider !== 'MOMO' && provider !== 'MOMO_CHECKOUT') throw new FinanceReadError('VALIDATION_FAILED');
    const redirect = provider === 'MOMO' ? undefined : this.redirect(input.redirect_url);
    await this.queries.authorizeQrSandbox(trip, actor, correlation, deadline);
    if (this.config.get('NODE_ENV') === 'production')
      throw new FinanceReadError('SERVICE_UNAVAILABLE');
    if (provider !== 'MOMO') return this.createWallet(provider, actor, trip, request, amount, note, redirect!);
    let configured = false;
    try { configured = this.provider.ready(); } catch { /* Invalid configuration is never exposed. */ }
    if (!configured) throw new FinanceReadError('PAYMENT_PROVIDER_NOT_CONFIGURED');
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key);
    const key = `${actor}:${trip}:${request}`,
      fingerprint = JSON.stringify([amount, note]);
    let entry = this.entries.get(key);
    if (entry && entry.fingerprint !== fingerprint)
      throw new FinanceReadError('IDEMPOTENCY_CONFLICT');
    if (entry?.result) return entry.result;
    if (entry?.task) return entry.task;
    if (!entry) {
      // Bounded memory and per-user demo rate. Remote provider credentials stay server-side.
      if (
        this.entries.size >= 1000 ||
        [...this.entries.keys()].filter((value) => value.startsWith(`${actor}:`)).length >= 5
      )
        throw new FinanceReadError('SERVICE_UNAVAILABLE');
      entry = { fingerprint, expires: now + 5 * 60_000 };
      this.entries.set(key, entry);
    }
    const orderId = `wqr-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
    const current = entry;
    current.task = (async () => {
      try {
        const result = await this.provider.create({
          amount: BigInt(amount),
          orderId,
          requestId: request,
          orderInfo: `Wolfari QR Sandbox: ${note}`,
        });
        if (result.resultCode !== 0 || !result.paymentUrl)
          throw new FinanceReadError('SERVICE_UNAVAILABLE');
        const url = new URL(result.paymentUrl);
        if (
          url.protocol !== 'https:' ||
          url.hostname !== 'test-payment.momo.vn' ||
          url.username ||
          url.password ||
          url.port
        )
          throw new FinanceReadError('SERVICE_UNAVAILABLE');
        current.result = {
          request_id: request,
          order_id: orderId,
          amount,
          payment_url: url.href,
          environment: 'SANDBOX',
        };
        return current.result;
      } catch (cause) {
        if (cause instanceof FinanceReadError) throw cause;
        throw new FinanceReadError('SERVICE_UNAVAILABLE');
      } finally {
        current.task = undefined;
      }
    })();
    return current.task;
  }

  private redirect(value: unknown) {
    if (typeof value !== 'string' || value.length > 1000) throw new FinanceReadError('VALIDATION_FAILED');
    let url: URL;
    try { url = new URL(value); } catch { throw new FinanceReadError('VALIDATION_FAILED'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !RETURN_PATH.test(url.pathname))
      throw new FinanceReadError('VALIDATION_FAILED');
    return url.href;
  }

  private sweep(now: number) {
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key);
    for (const [key, order] of this.orders) if (order.expires <= now) this.orders.delete(key);
  }

  private walletReady(wallet: Wallet) {
    try { return wallet === 'MOMO_CHECKOUT' && !!this.momoCheckout?.ready(); }
    catch { return false; /* Invalid configuration is never exposed. */ }
  }

  /** MoMo test order; the browser comes back through the Gateway return page. */
  private async createWallet(wallet: Wallet, actor: string, trip: string, request: string, amount: string, note: string, redirect: string) {
    if (!this.walletReady(wallet)) throw new FinanceReadError('PAYMENT_PROVIDER_NOT_CONFIGURED');
    const now = Date.now();
    this.sweep(now);
    const prefix = `${wallet}:${actor}:`,
      key = `${prefix}${trip}:${request}`,
      fingerprint = JSON.stringify([amount, note, redirect]);
    let entry = this.entries.get(key);
    if (entry && entry.fingerprint !== fingerprint) throw new FinanceReadError('IDEMPOTENCY_CONFLICT');
    if (entry?.result) return entry.result;
    if (entry?.task) return entry.task;
    if (!entry) {
      if (this.entries.size >= 1000 || [...this.entries.keys()].filter((value) => value.startsWith(prefix)).length >= 5)
        throw new FinanceReadError('SERVICE_UNAVAILABLE');
      entry = { fingerprint, expires: now + 5 * 60_000 };
      this.entries.set(key, entry);
    }
    const orderId = `${vietnamDate(now)}_w${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
    const description = `Wolfari - ${asciiNote(note).slice(0, 200) || 'Thanh toan QR'}`;
    const current = entry;
    current.task = (async () => {
      try {
        const result = await this.momoCheckout!.create({ orderId, requestId: request, amount: BigInt(amount), orderInfo: description, redirectUrl: redirect });
        if (result.resultCode !== 0 || !result.payUrl) {
          // MoMo's own reason (no keys or personal data) so a rejected sandbox order can be diagnosed.
          this.logger.warn(`MOMO_CHECKOUT_REJECTED result_code=${result.resultCode} message=${JSON.stringify(result.message.slice(0, 160))}`);
          throw new FinanceReadError('SERVICE_UNAVAILABLE');
        }
        const url = result.payUrl;
        this.orders.set(orderId, { wallet, actor, trip, amount, request, expires: now + 60 * 60_000 });
        current.result = { request_id: request, order_id: orderId, amount, payment_url: url, environment: 'SANDBOX' };
        return current.result;
      } catch (cause) {
        // A failed order is forgotten so the Holder can retry right away.
        this.entries.delete(key);
        if (cause instanceof FinanceReadError) throw cause;
        this.logger.warn(`${wallet}_CREATE_FAILED ${walletFailure(cause)}`);
        throw new FinanceReadError('SERVICE_UNAVAILABLE');
      } finally {
        current.task = undefined;
      }
    })();
    return current.task;
  }

  /** Asks MoMo whether a checkout this Holder started here was paid. */
  async status(input: StatusInput, correlation: string, deadline: number): Promise<Status> {
    const actor = readUuid(input.actor_user_id),
      trip = readUuid(input.trip_id);
    const orderId = input.order_id;
    if (typeof orderId !== 'string' || !ORDER_ID.test(orderId)) throw new FinanceReadError('VALIDATION_FAILED');
    await this.queries.authorizeQrSandbox(trip, actor, correlation, deadline);
    if (this.config.get('NODE_ENV') === 'production') throw new FinanceReadError('SERVICE_UNAVAILABLE');
    this.sweep(Date.now());
    const order = this.orders.get(orderId);
    if (!order || order.actor !== actor || order.trip !== trip) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    if (!this.walletReady(order.wallet)) throw new FinanceReadError('PAYMENT_PROVIDER_NOT_CONFIGURED');
    let state: 'PAID' | 'PENDING' | 'FAILED', transaction: string | undefined;
    try {
      const result = await this.momoCheckout!.query(orderId, order.request);
      const paid = result.resultCode === 0 && (result.amount === undefined || result.amount.toString() === order.amount);
      state = paid ? 'PAID' : [0, 1000, 7000, 7002, 9000].includes(result.resultCode) ? 'PENDING' : 'FAILED';
      transaction = result.transactionId;
    } catch (cause) {
      this.logger.warn(`${order.wallet}_QUERY_FAILED ${walletFailure(cause)}`);
      throw new FinanceReadError('SERVICE_UNAVAILABLE');
    }
    return {
      order_id: orderId,
      status: state,
      amount: order.amount,
      provider_transaction_id: state === 'PAID' ? (transaction ?? '') : '',
      environment: 'SANDBOX',
    };
  }
}
