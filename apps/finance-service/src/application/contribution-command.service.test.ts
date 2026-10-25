import type { DatabaseProvider } from '@wolfari/database';
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { loadSync, type ServiceDefinition, type MethodDefinition } from '@grpc/proto-loader';
import { GRPC_LOADER_OPTIONS, PROTO_PATHS } from '@wolfari/contracts/grpc';
import { ContributionCommandService } from './contribution-command.service';
import type { FundCommandService } from './fund-command.service';
import type { FundRepository } from '../repositories/fund.repository';
import { fundCommandHash } from '../repositories/fund-command.repository';
const id = '10000000-0000-4000-8000-000000000001';
const input = {
  operation_id: id,
  actor_user_id: id,
  fund_id: id,
  title: 'Shared meals',
  contributions: [{ member_user_id: id, amount: '0009007199254740993', destination_id: id }],
  expected_finance_version: 2,
  due_at: '2026-10-20T07:00:00+07:00',
  note: '',
};
function setup() {
  const funds = { findScopeById: vi.fn().mockResolvedValue({ tripId: id }) };
  const db = { query: vi.fn().mockResolvedValue({ rows: [{ fund_id: id, request_id: id }] }) };
  const commands = { run: vi.fn().mockResolvedValue({ contribution_request: { id } }) };
  return {
    funds,
    commands,
    db,
    service: new ContributionCommandService(
      funds as unknown as FundRepository,
      commands as unknown as FundCommandService,
      db as unknown as DatabaseProvider,
    ),
  };
}
describe('Create contribution request boundary', () => {
  it('parses actual protobuf presence, exact money and dates before the durable coordinator', async () => {
    const s = setup();
    const service = loadSync(PROTO_PATHS.finance, GRPC_LOADER_OPTIONS)[
      'wolfari.finance.v1.FinanceService'
    ] as ServiceDefinition;
    const method = service.CreateContributionRequest as MethodDefinition<typeof input, unknown>;
    const decoded = method.requestDeserialize(method.requestSerialize(input));
    expect(decoded).toHaveProperty('_due_at');
    await s.service.create(decoded, id, Date.now() + 2000);
    expect(s.commands.run).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'CREATE_CONTRIBUTION_REQUEST',
        actor: id,
        tripId: id,
        body: expect.objectContaining({
          dueAt: new Date('2026-10-20T00:00:00Z'),
          note: '',
          contributions: [{ memberUserId: id, destinationId: id, amount: 9007199254740993n }],
        }),
      }),
      id,
      expect.any(Number),
    );
  });
  it.each([
    { contributions: [] },
    { due_at: '2026-02-30T00:00:00Z' },
    { contributions: [input.contributions[0], input.contributions[0]] },
    { expected_finance_version: 0 },
  ])('rejects invalid input before guard', async (patch) => {
    const s = setup();
    await expect(
      s.service.create({ ...input, ...patch }, id, Date.now() + 2000),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(s.commands.run).not.toHaveBeenCalled();
  });
  it('does not create an operation for an absent Fund', async () => {
    const s = setup();
    s.funds.findScopeById.mockResolvedValue(undefined);
    await expect(s.service.create(input, id, Date.now() + 2000)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    expect(s.commands.run).not.toHaveBeenCalled();
  });
  it('hashes due dates by instant, distinguishes changed or absent deadline', () => {
    const hash = (value: unknown) => fundCommandHash({ dueAt: value });
    expect(hash(new Date(input.due_at))).toBe(hash(new Date('2026-10-20T00:00:00Z')));
    expect(hash(new Date(input.due_at))).not.toBe(hash(new Date('2026-10-21T00:00:00Z')));
    expect(hash(new Date(input.due_at))).not.toBe(hash(null));
  });
});

describe('Contribution management command boundary', () => {
  it.each([
    [
      'UpdateContributionRequest',
      'UPDATE_CONTRIBUTION_REQUEST',
      { fund_id: id, request_id: id, note: '' },
    ],
    [
      'UpdateContributionAmount',
      'UPDATE_CONTRIBUTION_AMOUNT',
      { contribution_id: id, amount: '0009007199254740993' },
    ],
    ['WaiveContribution', 'WAIVE_CONTRIBUTION', { contribution_id: id, reason: 'Group waiver' }],
    ['CancelContribution', 'CANCEL_CONTRIBUTION', { contribution_id: id, reason: 'Mistake' }],
  ] as const)(
    'preserves %s protobuf presence and resolves stored scope',
    async (methodName, scope, fields) => {
      const s = setup(),
        definition = loadSync(PROTO_PATHS.finance, GRPC_LOADER_OPTIONS)[
          'wolfari.finance.v1.FinanceService'
        ] as ServiceDefinition;
      const method = definition[methodName] as MethodDefinition<object, object>;
      const decoded = method.requestDeserialize(
        method.requestSerialize({
          ...fields,
          operation_id: id,
          actor_user_id: id,
          expected_version: 2,
          expected_finance_version: 5,
        }),
      );
      await s.service.manage(scope, decoded, id, Date.now() + 2000);
      expect(s.commands.run).toHaveBeenCalledWith(
        expect.objectContaining({
          scope,
          fundId: id,
          requestId: id,
          tripId: id,
          actor: id,
          body: expect.objectContaining({ expectedVersion: 2, expectedFinanceVersion: 5 }),
        }),
        id,
        expect.any(Number),
      );
      if (scope === 'UPDATE_CONTRIBUTION_REQUEST') {
        expect(s.db.query).not.toHaveBeenCalled();
        expect(s.commands.run.mock.calls[0]![0].body).toEqual({
          expectedVersion: 2,
          expectedFinanceVersion: 5,
          note: '',
        });
      } else
        expect(s.db.query).toHaveBeenCalledWith(
          'SELECT fund_id,request_id FROM contributions WHERE id=$1',
          [id],
        );
    },
  );
  it('does not enter the guard when contribution is absent or inputs invalid', async () => {
    const s = setup();
    s.db.query.mockResolvedValue({ rows: [] });
    await expect(
      s.service.manage(
        'UPDATE_CONTRIBUTION_AMOUNT',
        {
          operation_id: id,
          actor_user_id: id,
          contribution_id: id,
          amount: '4',
          expected_version: 1,
          expected_finance_version: 1,
        },
        id,
        Date.now() + 2000,
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(
      s.service.manage(
        'WAIVE_CONTRIBUTION',
        {
          operation_id: id,
          actor_user_id: id,
          contribution_id: id,
          reason: '',
          expected_version: 1,
          expected_finance_version: 1,
        },
        id,
        Date.now() + 2000,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(s.commands.run).not.toHaveBeenCalled();
  });
});
