import type { ManualContributionService } from './application/manual-contribution.service';
import type { ReceiptService } from './receipts/receipt.service';
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Metadata, status } from '@grpc/grpc-js';
import { ConfigService } from '@nestjs/config';
import { FinanceGrpcController } from './finance.grpc';
import type { ContributionCommandService } from './application/contribution-command.service';
import type { ContributionQueryService } from './application/contribution-query.service';
import type { FundQueryService } from './application/fund-query.service';
import { FinanceReadError } from './finance.errors';
import type { FundCommandService } from './application/fund-command.service';
import type { FundCommandRepository } from './repositories/fund-command.repository';
import type { ContributionReversalService } from './application/contribution-reversal.service';

const id = '10000000-0000-4000-8000-000000000001';
const secret = 'a'.repeat(64);
function setup() {
  const queries = {
    getFund: vi.fn().mockResolvedValue({ fund: {} }),
    listPaymentDestinations: vi.fn().mockResolvedValue({ destinations: [] }),
    listFundTransactions: vi.fn().mockResolvedValue({ items: [] }),
  };
  const files = {
    upload: vi.fn().mockResolvedValue({ object_key: 'test' }),
    download: vi.fn().mockResolvedValue({ content: Buffer.from('test') }),
  };
  const metadata = new Metadata();
  const commands = {
    configure: vi.fn().mockResolvedValue({ fund: {} }),
    enable: vi.fn().mockResolvedValue({ fund: {} }),
    confirm: vi.fn().mockResolvedValue({ destination: {} }),
  };
  const receipts = { find: vi.fn().mockResolvedValue(undefined), cancel: vi.fn() };
  const reversals = { run: vi.fn().mockResolvedValue({ contribution: {} }) };
  metadata.set('x-caller-service', 'ApiGateway');
  metadata.set('x-service-secret', secret);
  metadata.set('x-correlation-id', id);
  return {
    queries,
    files,
    commands,
    receipts,
    metadata,
    controller: new FinanceGrpcController(
      queries as unknown as FundQueryService,
      new ConfigService({ GATEWAY_FINANCE_SECRET: secret, TRIP_FINANCE_SECRET: 'b'.repeat(64) }),
      commands as unknown as FundCommandService,
      receipts as unknown as FundCommandRepository,
      {
        create: vi.fn().mockResolvedValue({ contribution_request: {} }),
        manage: vi.fn().mockResolvedValue({ contribution: {} }),
      } as unknown as ContributionCommandService,
      {
        listRequests: vi.fn().mockResolvedValue({ items: [] }),
        listContributions: vi.fn().mockResolvedValue({ items: [] }),
      } as unknown as ContributionQueryService,
      files as unknown as ReceiptService,
      {
        run: vi.fn().mockResolvedValue({ contribution: {} }),
      } as unknown as ManualContributionService,
      undefined,
      reversals as unknown as ContributionReversalService,
    ),
    reversals,
  };
}
describe('Finance gRPC boundary', () => {
  it('restricts contribution reversal to Gateway', async () => {
    const s = setup();
    expect(await s.controller.reverseContribution({}, s.metadata)).toEqual({ contribution: {} });
    s.metadata.set('x-caller-service', 'Trip');
    s.metadata.set('x-service-secret', 'b'.repeat(64));
    await expect(s.controller.reverseContribution({}, s.metadata)).rejects.toMatchObject({
      error: { code: status.PERMISSION_DENIED },
    });
    expect(s.reversals.run).toHaveBeenCalledTimes(1);
  });
  it.each([
    'reportContributionTransfer',
    'confirmContributionReceived',
    'rejectContributionTransfer',
  ] as const)('%s restricts manual commands to Gateway', async (method) => {
    const s = setup();
    expect(await s.controller[method]({}, s.metadata)).toEqual({ contribution: {} });
    s.metadata.set('x-caller-service', 'Trip');
    s.metadata.set('x-service-secret', 'b'.repeat(64));
    await expect(s.controller[method]({}, s.metadata)).rejects.toMatchObject({
      error: { code: status.PERMISSION_DENIED },
    });
  });
  it.each(['uploadFinanceReceipt', 'downloadFinanceReceipt'] as const)(
    '%s authenticates file RPC and uses a bounded file deadline',
    async (method) => {
      const s = setup();
      await s.controller[method]({}, s.metadata, { getDeadline: () => Date.now() + 30000 });
      const mock = method === 'uploadFinanceReceipt' ? s.files.upload : s.files.download;
      expect(mock.mock.calls[0]![2]).toBeGreaterThan(Date.now() + 20000);
      expect(mock.mock.calls[0]![2]).toBeLessThanOrEqual(Date.now() + 29000);
      s.metadata.set('x-caller-service', 'Trip');
      s.metadata.set('x-service-secret', 'b'.repeat(64));
      await expect(s.controller[method]({}, s.metadata)).rejects.toMatchObject({
        error: { code: status.PERMISSION_DENIED },
      });
      expect(mock).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    'updateContributionRequest',
    'updateContributionAmount',
    'waiveContribution',
    'cancelContribution',
  ] as const)('%s restricts management to Gateway', async (method) => {
    const s = setup();
    await expect(s.controller[method]({}, s.metadata)).resolves.toEqual({ contribution: {} });
    s.metadata.set('x-caller-service', 'Trip');
    s.metadata.set('x-service-secret', 'b'.repeat(64));
    await expect(s.controller[method]({}, s.metadata)).rejects.toMatchObject({
      error: { code: status.PERMISSION_DENIED },
    });
  });
  it.each(['listContributionRequests', 'listContributions'] as const)(
    '%s only accepts Gateway reads',
    async (method) => {
      const s = setup();
      await expect(s.controller[method]({}, s.metadata)).resolves.toEqual({ items: [] });
      s.metadata.set('x-caller-service', 'Trip');
      s.metadata.set('x-service-secret', 'b'.repeat(64));
      await expect(s.controller[method]({}, s.metadata)).rejects.toMatchObject({
        error: { code: status.PERMISSION_DENIED },
      });
    },
  );
  it('allows only Gateway to create contribution requests', async () => {
    const s = setup();
    await expect(s.controller.createContributionRequest({}, s.metadata)).resolves.toEqual({
      contribution_request: {},
    });
    s.metadata.set('x-caller-service', 'Trip');
    s.metadata.set('x-service-secret', 'b'.repeat(64));
    await expect(s.controller.createContributionRequest({}, s.metadata)).rejects.toMatchObject({
      error: { code: status.PERMISSION_DENIED },
    });
  });
  it('restricts ledger RPC to Gateway and maps storage failures to unavailable', async () => {
    const s = setup();
    expect(await s.controller.listFundTransactions({}, s.metadata)).toEqual({ items: [] });
    s.queries.listFundTransactions.mockRejectedValue(new TypeError('PRIVATE DATABASE ERROR'));
    await expect(s.controller.listFundTransactions({}, s.metadata)).rejects.toMatchObject({
      error: {
        code: status.UNAVAILABLE,
        message: JSON.stringify({ code: 'SERVICE_UNAVAILABLE', details: null }),
      },
    });
    s.metadata.set('x-caller-service', 'Trip');
    s.metadata.set('x-service-secret', 'b'.repeat(64));
    await expect(s.controller.listFundTransactions({}, s.metadata)).rejects.toMatchObject({
      error: { code: status.PERMISSION_DENIED },
    });
    expect(s.queries.listFundTransactions).toHaveBeenCalledTimes(2);
  });
  it.each(['updateFundBudget', 'createPaymentDestination', 'updatePaymentDestination'] as const)(
    '%s accepts only the Gateway caller',
    async (method) => {
      const s = setup();
      await s.controller[method]({}, s.metadata);
      expect(s.commands.configure).toHaveBeenCalledTimes(1);
      s.metadata.set('x-caller-service', 'Trip');
      s.metadata.set('x-service-secret', 'b'.repeat(64));
      await expect(s.controller[method]({}, s.metadata)).rejects.toMatchObject({
        error: { code: status.PERMISSION_DENIED },
      });
      expect(s.commands.configure).toHaveBeenCalledTimes(1);
    },
  );
  it('separates Gateway commands from Trip recovery using distinct secrets and catalog callers', async () => {
    const s = setup();
    await s.controller.enableFund({}, s.metadata);
    expect(s.commands.enable).toHaveBeenCalledTimes(1);
    await expect(
      s.controller.getOperationResult({ operation_id: id }, s.metadata),
    ).rejects.toMatchObject({ error: { code: status.PERMISSION_DENIED } });
    expect(s.receipts.find).not.toHaveBeenCalled();
    s.metadata.set('x-caller-service', 'Trip');
    s.metadata.set('x-service-secret', 'b'.repeat(64));
    expect(await s.controller.getOperationResult({ operation_id: id }, s.metadata)).toEqual({
      not_found: {},
    });
    await expect(s.controller.enableFund({}, s.metadata)).rejects.toMatchObject({
      error: { code: status.PERMISSION_DENIED },
    });
    expect(s.commands.enable).toHaveBeenCalledTimes(1);
  });
  it('projects only terminal receipt metadata to Trip, never the stored resource snapshot', async () => {
    const s = setup();
    s.metadata.set('x-caller-service', 'Trip');
    s.metadata.set('x-service-secret', 'b'.repeat(64));
    s.receipts.find.mockResolvedValue({
      operation_id: id,
      request_hash: 'a'.repeat(64),
      command_scope: 'ENABLE_FUND',
      status: 'COMMITTED',
      completed_at: new Date(),
      response: { version: 1, tripId: id, destination: { account_number: 'PRIVATE ACCOUNT' } },
    });
    const result = await s.controller.getOperationResult({ operation_id: id }, s.metadata);
    expect(result.receipt?.outcome?.status).toBe(1);
    expect(JSON.stringify(result)).not.toContain('PRIVATE ACCOUNT');
    expect(JSON.stringify(result)).not.toContain('destination');
  });
  it.each(['missing', 'wrong_secret', 'wrong_caller', 'wrong_correlation', 'duplicate'])(
    'rejects %s metadata before invoking query service',
    async (caseName) => {
      const s = setup();
      if (caseName === 'wrong_secret') s.metadata.set('x-service-secret', 'b'.repeat(64));
      if (caseName === 'wrong_caller') s.metadata.set('x-caller-service', 'Trip');
      if (caseName === 'wrong_correlation') s.metadata.set('x-correlation-id', 'bad');
      if (caseName === 'duplicate') s.metadata.add('x-caller-service', 'ApiGateway');
      await expect(
        s.controller.getFund(
          { trip_id: id, actor_user_id: id },
          caseName === 'missing' ? undefined : s.metadata,
        ),
      ).rejects.toMatchObject({ error: { code: status.PERMISSION_DENIED } });
      expect(s.queries.getFund).not.toHaveBeenCalled();
    },
  );
  it('passes correlation and the incoming deadline budget to the service', async () => {
    const s = setup(),
      end = Date.now() + 1000;
    await s.controller.listPaymentDestinations({ fund_id: id, actor_user_id: id }, s.metadata, {
      getDeadline: () => end,
    });
    expect(s.queries.listPaymentDestinations).toHaveBeenCalledWith(
      { fund_id: id, actor_user_id: id },
      id,
      end - 100,
    );
  });
  it('returns domain envelopes but never leaks unexpected DB errors', async () => {
    const s = setup();
    s.queries.getFund.mockRejectedValue(new FinanceReadError('RESOURCE_NOT_FOUND'));
    await expect(
      s.controller.getFund({ trip_id: id, actor_user_id: id }, s.metadata),
    ).rejects.toMatchObject({
      error: { code: status.NOT_FOUND, message: '{"code":"RESOURCE_NOT_FOUND","details":null}' },
    });
    s.queries.getFund.mockRejectedValue(new Error('PRIVATE SQL ACCOUNT'));
    await expect(
      s.controller.getFund({ trip_id: id, actor_user_id: id }, s.metadata),
    ).rejects.toMatchObject({
      error: { code: status.UNAVAILABLE, message: '{"code":"SERVICE_UNAVAILABLE","details":null}' },
    });
  });
});
