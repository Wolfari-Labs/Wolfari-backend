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
    { contributions: [] },
    { finance_version: 3 },
    { contributions: [], finance_version: 3 },
  ])(
    'rejects partial stored contribution snapshots before protobuf can erase presence',
    async (patch) => {
      const s = setup();
      s.repo.find.mockResolvedValue({
        ...s.row,
        command_scope: 'CREATE_CONTRIBUTION_REQUEST',
        response: { version: 1, tripId: id, contributionRequest: { id, fund_id: id, ...patch } },
      });
      await expect(
        s.service.run(
          {
            scope: 'CREATE_CONTRIBUTION_REQUEST',
            operationId: id,
            actor: id,
            tripId: id,
            fundId: id,
            body: {
              title: 'Meals',
              note: null,
              dueAt: null,
              expectedFinanceVersion: 2,
              contributions: [{ memberUserId: id, destinationId: id, amount: 1n }],
            },
          },
          id,
          Date.now() + 2000,
        ),
      ).rejects.toThrow('Incomplete contribution creation snapshot');
      expect(s.repo.execute).not.toHaveBeenCalled();
      expect(s.queries.getFund).toHaveBeenCalledTimes(1);
    },
  );
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

describe('Manual command replay coordination', () => {
  const input = {
    scope: 'CONFIRM_RECEIVED' as const,
    actor: id,
    operationId: id,
    tripId: id,
    fundId: id,
    requestId: id,
    contributionId: id,
    body: {
      command: {
        action: 'CONFIRM_RECEIVED' as const,
        expectedVersion: 2,
        expectedFinanceVersion: 3,
      },
    },
  };
  const row = {
    operation_id: id,
    actor_user_id: id,
    command_scope: 'CONFIRM_RECEIVED',
    request_hash: 'a'.repeat(64),
    status: 'COMMITTED',
    response: {
      version: 1,
      tripId: id,
      contribution: {
        id,
        fund_id: id,
        request_id: id,
        member_user_id: id,
        finance_version: 4,
        status: 'CONFIRMED',
      },
    },
    completed_at: new Date(),
  };
  it('returns saved snapshot without storage calls or a second mutation', async () => {
    const s = setup(),
      prepare = vi.fn();
    s.repo.find.mockResolvedValue(row as never);
    s.queries.getFund.mockResolvedValue({ fund: { holder_user_id: id } });
    expect(await s.service.run(input, id, Date.now() + 2000, prepare)).toEqual({
      contribution: row.response.contribution,
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(s.repo.execute).not.toHaveBeenCalled();
  });
  it('denies terminal replay when Holder has changed', async () => {
    const s = setup();
    s.repo.find.mockResolvedValue(row as never);
    s.queries.getFund.mockResolvedValue({ fund: { holder_user_id: 'changed' } });
    await expect(s.service.run(input, id, Date.now() + 2000)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });
  it('does not acquire a Trip guard after failed storage preparation', async () => {
    const s = setup();
    await expect(
      s.service.run(input, id, Date.now() + 2000, async () => {
        throw new Error('storage unavailable');
      }),
    ).rejects.toThrow('storage unavailable');
    expect(s.trip.call).not.toHaveBeenCalled();
    expect(s.repo.execute).not.toHaveBeenCalled();
  });
});
