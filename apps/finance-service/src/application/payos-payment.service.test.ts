import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { encodePayosReturnToken, PAYOS_RETURN_PATH } from '@wolfari/common';
import { PaymentService } from './payment.service';
import { PayosPaymentProcessor } from './payos-payment-processor';
import { PaymentInstructionService } from './payment-instruction.service';
import { PayosError, type PayosProvider } from '../providers/payos.provider';
import type { PaymentRepository } from '../repositories/payment.repository';
import type { PayosPaymentRepository } from '../repositories/payos-payment.repository';
import type { FundQueryService } from './fund-query.service';
import type { FundCommandService } from './fund-command.service';
import type { PaymentProcessor } from './payment-processor';
import type { MomoSandboxProvider } from '../providers/momo-sandbox.provider';

const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const page = `http://192.168.1.5:3100${PAYOS_RETURN_PATH}${encodePayosReturnToken('exp://192.168.1.5:8081/--/fund')}`;
const account = { bankCode: 'MB', bankBin: '970422', accountNumber: '0123456789' };

function setup(ready = true) {
  const payos = {
    ready: () => ready,
    production: () => false,
    defaultReturnUrl: () => undefined,
    account: () => account,
    merchantId: () => 'client-id-0001',
    verifyWebhook: vi.fn(),
  };
  const rows = {
    contributionScope: vi.fn().mockResolvedValue({
      fund_id: id(2),
      trip_id: id(3),
      member_user_id: id(1),
      holder_user_id: id(4),
    }),
  };
  const queries = { authorizePaymentInstruction: vi.fn().mockResolvedValue(undefined) };
  const commands = { run: vi.fn().mockResolvedValue({ payment_attempt: { id: id(9) } }) };
  const payosRows = { receiveWebhook: vi.fn().mockResolvedValue({}) };
  const payosProcessor = { kick: vi.fn() };
  const momo = { ready: () => false };
  const service = new PaymentService(
    rows as unknown as PaymentRepository,
    queries as unknown as FundQueryService,
    commands as unknown as FundCommandService,
    momo as unknown as MomoSandboxProvider,
    { kick: vi.fn() } as unknown as PaymentProcessor,
    payos as unknown as PayosProvider,
    payosRows as unknown as PayosPaymentRepository,
    payosProcessor as unknown as PayosPaymentProcessor,
  );
  return { service, payos, rows, queries, commands, payosRows, payosProcessor };
}
const request = (extra: Record<string, unknown> = {}) => ({
  operation_id: id(7),
  actor_user_id: id(1),
  contribution_id: id(5),
  provider: 'PAYOS',
  expected_version: 1,
  expected_finance_version: 3,
  return_url: page,
  ...extra,
});

describe('PaymentService with payOS', () => {
  it('creates an attempt for the member with the configured payOS account', async () => {
    const { service, commands, queries, payosProcessor } = setup();
    await expect(service.create(request(), id(8), Date.now() + 1000)).resolves.toEqual({
      payment_attempt: { id: id(9) },
    });
    expect(queries.authorizePaymentInstruction).toHaveBeenCalledWith(id(2), id(1), id(8), expect.any(Number));
    expect(commands.run.mock.calls[0]![0]).toMatchObject({
      scope: 'CREATE_PAYMENT_ATTEMPT',
      contributionId: id(5),
      body: {
        provider: 'PAYOS',
        returnUrl: page,
        merchantId: 'client-id-0001',
        payosAccount: { bankBin: '970422', accountNumber: '0123456789' },
      },
    });
    expect(payosProcessor.kick).toHaveBeenCalled();
  });
  it('refuses when payOS is not configured, without a return page, or for someone else', async () => {
    await expect(setup(false).service.create(request(), id(8), Date.now() + 1000)).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
    });
    const { service, commands } = setup();
    await expect(service.create(request({ return_url: '' }), id(8), Date.now() + 1000)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      service.create(request({ return_url: 'https://evil.example/x' }), id(8), Date.now() + 1000),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      service.create(request({ actor_user_id: id(6) }), id(8), Date.now() + 1000),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(commands.run).not.toHaveBeenCalled();
  });
  it('stores only webhooks whose signature verifies', async () => {
    const { service, payos, payosRows, payosProcessor } = setup();
    payos.verifyWebhook.mockReturnValueOnce({ valid: false });
    await expect(service.payosWebhook({ body: '{"data":{}}' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(payosRows.receiveWebhook).not.toHaveBeenCalled();
    const data = { orderCode: 1, amount: 2000n };
    payos.verifyWebhook.mockReturnValueOnce({ valid: true, data });
    await expect(service.payosWebhook({ body: '{"data":{}}' })).resolves.toEqual({});
    expect(payosRows.receiveWebhook).toHaveBeenCalledWith(data);
    expect(payosProcessor.kick).toHaveBeenCalled();
    await expect(service.payosWebhook({ body: '' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(setup(false).service.payosWebhook({ body: '{}' })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });
});

describe('PayosPaymentProcessor', () => {
  const link = {
    orderCode: 1,
    amount: 2000n,
    status: 'PENDING' as const,
    paymentLinkId: 'l1',
    checkoutUrl: 'https://pay.payos.vn/web/l1',
    bin: '970422',
    accountNumber: '0123456789',
  };
  function processor(create: () => Promise<unknown>, get: () => Promise<unknown>) {
    const rows = {
      markStale: vi.fn(),
      dispatchCandidates: vi.fn().mockResolvedValue(['a1']),
      claimDispatch: vi
        .fn()
        .mockResolvedValue({ id: 'a1', orderCode: 1, amount: 2000n, destinationName: 'NGUYEN A' }),
      completeDispatch: vi.fn(),
      failDispatch: vi.fn(),
      webhookCandidates: vi.fn().mockResolvedValue(['w1']),
      processWebhook: vi.fn(),
      reconciliationCandidates: vi.fn().mockResolvedValue(['a2']),
      reconciliationCommand: vi.fn().mockResolvedValue({ id: 'a2', orderCode: 2, amount: 3000n }),
      completeQuery: vi.fn(),
      failQuery: vi.fn(),
    };
    const provider = {
      ready: () => true,
      create: vi.fn(create),
      get: vi.fn(get),
      paysIntoAccount: vi.fn().mockReturnValue(true),
    };
    return {
      rows,
      provider,
      worker: new PayosPaymentProcessor(
        rows as unknown as PayosPaymentRepository,
        provider as unknown as PayosProvider,
      ),
    };
  }
  it('creates links, settles webhooks and reconciles unknown outcomes', async () => {
    const { rows, provider, worker } = processor(
      () => Promise.resolve(link),
      () => Promise.resolve({ ...link, status: 'PAID' }),
    );
    await worker.runOnce();
    expect(rows.completeDispatch).toHaveBeenCalledWith('a1', link, true);
    expect(provider.paysIntoAccount).toHaveBeenCalledWith(link, 'NGUYEN A');
    expect(rows.processWebhook).toHaveBeenCalledWith('w1');
    expect(provider.get).toHaveBeenCalledWith(2, 3000n);
    expect(rows.completeQuery).toHaveBeenCalledWith('a2', { ...link, status: 'PAID' });
  });
  it('reports provider failures with their kind so only refusals close an attempt', async () => {
    const refused = new PayosError('PAYOS_231', 'definitive');
    const { rows, worker } = processor(
      () => Promise.reject(refused),
      () => Promise.reject(new Error('boom')),
    );
    await worker.runOnce();
    expect(rows.failDispatch).toHaveBeenCalledWith('a1', refused);
    expect(rows.failQuery).toHaveBeenCalledWith('a2', undefined);
  });
  it('does nothing until payOS is configured', async () => {
    const { rows, provider, worker } = processor(
      () => Promise.resolve(link),
      () => Promise.resolve(link),
    );
    provider.ready = () => false;
    await worker.runOnce();
    expect(rows.markStale).not.toHaveBeenCalled();
  });
});

describe('Payment instruction online providers', () => {
  it('offers payOS only when it pays into this destination', async () => {
    const row = {
      id: id(5),
      fund_id: id(2),
      trip_id: id(3),
      member_user_id: id(1),
      holder_user_id: id(4),
      amount: '2000',
      currency: 'VND',
      status: 'PENDING',
      fund_status: 'OPEN',
      request_status: 'OPEN',
      destination_version: 1,
      blocked_payment: false,
      destination_snapshot: {
        schema_version: 1,
        fund_id: id(2),
        destination_id: id(6),
        destination_version: 1,
        holder_user_id: id(4),
        confirmed_by_holder_at: '2026-11-26T00:00:00Z',
        destination_type: 'VIETQR',
        recipient: { bank_code: 'MB', account_number: '0123456789', account_name: 'NGUYEN VAN A' },
      },
    };
    const auth = { authorizePaymentInstruction: vi.fn() };
    const rows = { scope: vi.fn().mockResolvedValue({ fund_id: id(2) }), read: vi.fn().mockResolvedValue(row) };
    const accepts = vi.fn().mockReturnValue(true);
    const service = new PaymentInstructionService(auth, rows, { ready: () => true, acceptsDestination: accepts });
    const input = { contribution_id: id(5), actor_user_id: id(1) };
    expect((await service.get(input, id(8), Date.now() + 1000)).instruction.online_payment_providers).toEqual([
      'PAYOS',
    ]);
    expect(accepts).toHaveBeenCalledWith(row.destination_snapshot);
    accepts.mockReturnValue(false);
    expect((await service.get(input, id(8), Date.now() + 1000)).instruction.online_payment_providers).toEqual([]);
    const plain = new PaymentInstructionService(auth, rows);
    expect((await plain.get(input, id(8), Date.now() + 1000)).instruction.online_payment_providers).toEqual([]);
  });
});
