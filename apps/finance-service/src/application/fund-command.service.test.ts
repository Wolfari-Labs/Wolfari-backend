import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { loadSync, type ServiceDefinition, type MethodDefinition } from '@grpc/proto-loader';
import { GRPC_LOADER_OPTIONS, PROTO_PATHS } from '@wolfari/contracts/grpc';
import { FundCommandService, type FundTripClient } from './fund-command.service';
import {
  fundCommandHash,
  type FundCommandRepository,
} from '../repositories/fund-command.repository';
import type { FundRepository } from '../repositories/fund.repository';
import type { FundQueryService } from './fund-query.service';
const id = '10000000-0000-4000-8000-000000000001';
const request = {
  operation_id: id,
  actor_user_id: id,
  trip_id: id,
  holder_user_id: id,
  currency: 'VND',
  destination: {
    destination_type: 'VIETQR',
    active: true,
    is_default: true,
    bank_code: 'TEST',
    account_number: '001',
    account_name: 'Holder',
  },
};
function setup() {
  const row = {
    operation_id: id,
    actor_user_id: id,
    command_scope: 'ENABLE_FUND',
    request_hash: 'a'.repeat(64),
    status: 'COMMITTED',
    response: { version: 1, tripId: id, fund: { id } },
    completed_at: new Date(),
  };
  const repo = {
    find: vi.fn().mockResolvedValue(undefined),
    verify: vi.fn(),
    execute: vi.fn().mockResolvedValue(row),
  };
  const trip = {
    call: vi.fn().mockResolvedValue({ operation: { operation_id: id, trip_id: id, state: 3 } }),
  };
  const queries = { getFund: vi.fn().mockResolvedValue({}), listPaymentDestinations: vi.fn() };
  const service = new FundCommandService(
    repo as unknown as FundCommandRepository,
    { findScopeById: vi.fn().mockResolvedValue({ tripId: id }) } as unknown as FundRepository,
    queries as unknown as FundQueryService,
    trip as unknown as FundTripClient,
  );
  return { service, repo, trip, queries, row };
}
describe('Fund write coordination', () => {
  it.each([
    [
      'UpdateFundBudget',
      'UPDATE_FUND_BUDGET',
      { budget: { clear: true }, expected_finance_version: 1 },
    ],
    [
      'CreatePaymentDestination',
      'CREATE_PAYMENT_DESTINATION',
      { destination: request.destination, expected_finance_version: 1 },
    ],
    [
      'UpdatePaymentDestination',
      'UPDATE_PAYMENT_DESTINATION',
      {
        destination_id: id,
        patch: { active: false },
        expected_version: 1,
        expected_finance_version: 1,
      },
    ],
  ] as const)(
    'preserves presence through %s protobuf and reauthorizes replay',
    async (methodName, scope, body) => {
      const s = setup();
      const service = loadSync(PROTO_PATHS.finance, GRPC_LOADER_OPTIONS)[
        'wolfari.finance.v1.FinanceService'
      ] as ServiceDefinition;
      const method = service[methodName] as MethodDefinition<object, unknown>;
      const input = method.requestDeserialize(
        method.requestSerialize({ ...body, operation_id: id, actor_user_id: id, fund_id: id }),
      );
      const row = {
        ...s.row,
        command_scope: scope,
        response: { ...s.row.response, destination: { id, account_number: '001' } },
      };
      s.repo.execute.mockResolvedValue(row);
      s.queries.listPaymentDestinations.mockResolvedValue({
        destinations: [row.response.destination],
      });
      await s.service.configure(scope, input, id, Date.now() + 2000);
      expect(s.repo.execute.mock.calls[0]![0]).toMatchObject({
        scope,
        body:
          scope === 'UPDATE_FUND_BUDGET'
            ? { budgetAmount: null }
            : scope === 'UPDATE_PAYMENT_DESTINATION'
              ? { patch: { active: false } }
              : { destination: { destinationType: 'VIETQR' } },
      });
      s.repo.find.mockResolvedValue(row);
      s.queries.getFund.mockRejectedValue(new Error('revoked'));
      s.queries.listPaymentDestinations.mockResolvedValue({ destinations: [{ id }] });
      await expect(s.service.configure(scope, input, id, Date.now() + 2000)).rejects.toThrow();
      expect(s.repo.execute).toHaveBeenCalledTimes(1);
    },
  );
  it.each([undefined, {}, { clear: false }, { value: '1', clear: true }])(
    'rejects ambiguous budget change %j',
    async (budget) => {
      const s = setup();
      await expect(
        s.service.configure(
          'UPDATE_FUND_BUDGET',
          {
            operation_id: id,
            actor_user_id: id,
            fund_id: id,
            budget,
            expected_finance_version: 1,
          },
          id,
          Date.now() + 2000,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(s.trip.call).not.toHaveBeenCalled();
    },
  );
  it('accepts real protobuf optional-field presence markers without weakening JSON validation', async () => {
    const s = setup();
    const service = loadSync(PROTO_PATHS.finance, GRPC_LOADER_OPTIONS)[
      'wolfari.finance.v1.FinanceService'
    ] as ServiceDefinition;
    const method = service.EnableFund as MethodDefinition<typeof request, unknown>;
    const decoded = method.requestDeserialize(method.requestSerialize(request));
    expect(decoded.destination).toHaveProperty('_active');
    expect(await s.service.enable(decoded, id, Date.now() + 2000)).toEqual({ fund: { id } });
    expect(s.repo.execute).toHaveBeenCalledTimes(1);
  });
  it('canonical hash ignores property order but preserves recipient text and versions', () => {
    expect(fundCommandHash({ b: 2n, a: 1 })).toBe(fundCommandHash({ a: 1, b: '2' }));
    expect(fundCommandHash({ account: '001' })).not.toBe(fundCommandHash({ account: '1' }));
    expect(fundCommandHash({ version: 1 })).not.toBe(fundCommandHash({ version: 2 }));
  });
  it('does not invent a pending operation when Begin was not acknowledged', async () => {
    const s = setup();
    s.trip.call.mockRejectedValue(new Error('network'));
    await expect(s.service.enable(request, id, Date.now() + 2000)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(s.repo.execute).not.toHaveBeenCalled();
  });
  it('preserves trusted Begin denial without recording a Finance mutation', async () => {
    const s = setup();
    s.trip.call.mockRejectedValue({ details: JSON.stringify({ code: 'PERMISSION_DENIED' }) });
    await expect(s.service.enable(request, id, Date.now() + 2000)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(s.repo.execute).not.toHaveBeenCalled();
  });
  it('returns pending after acknowledged guard and unknown local transaction outcome', async () => {
    const s = setup();
    s.repo.execute.mockRejectedValue(new Error('connection lost'));
    expect(await s.service.enable(request, id, Date.now() + 2000)).toMatchObject({
      operation: { operation_id: id, state: 2 },
    });
    expect(s.queries.getFund).not.toHaveBeenCalled();
  });
  it('returns pending if Finance committed but Complete response was lost', async () => {
    const s = setup();
    s.trip.call.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('lost'));
    expect(await s.service.enable(request, id, Date.now() + 2000)).toMatchObject({
      operation: { state: 2 },
    });
    expect(s.repo.execute).toHaveBeenCalledTimes(1);
  });
  it('replays a terminal receipt without Begin/execute, reauthorizing current read access', async () => {
    const s = setup();
    s.repo.find.mockResolvedValue(s.row);
    expect(await s.service.enable(request, id, Date.now() + 2000)).toEqual({ fund: { id } });
    expect(s.repo.execute).not.toHaveBeenCalled();
    expect(s.trip.call.mock.calls.map((args) => args[0])).toEqual(['CompleteOperation']);
    expect(s.queries.getFund).toHaveBeenCalledTimes(1);
    s.queries.getFund.mockRejectedValue(new Error('access revoked'));
    await expect(s.service.enable(request, id, Date.now() + 2000)).rejects.toThrow(
      'access revoked',
    );
  });
  it('rejects invalid input before taking a Trip guard', async () => {
    const s = setup();
    await expect(
      s.service.enable({ ...request, currency: 'USD' }, id, Date.now() + 2000),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(s.trip.call).not.toHaveBeenCalled();
  });
});
