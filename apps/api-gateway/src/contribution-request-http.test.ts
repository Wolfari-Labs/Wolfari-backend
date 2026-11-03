import { describe, it, expect } from 'vitest';
import { loadSync, type ServiceDefinition, type MethodDefinition } from '@grpc/proto-loader';
import { GRPC_LOADER_OPTIONS, PROTO_PATHS } from '@wolfari/contracts/grpc';
import {
  projectContributionRequest,
  projectContribution,
  projectContributionPage,
} from './contribution-request-http';
const id = '10000000-0000-4000-8000-000000000001';
const contribution = {
  id,
  request_id: id,
  fund_id: id,
  member_user_id: id,
  amount: '9007199254740993',
  status: 'PENDING',
  self_contribution: false,
  version: 1,
  finance_version: 3,
};
const request = {
  id,
  fund_id: id,
  title: 'Meals',
  status: 'OPEN',
  version: 1,
  created_by_user_id: id,
  created_at: { seconds: '1792000000', nanos: 0 },
};
describe('Contribution public projections', () => {
  it('accepts legacy receipts over actual protobuf without inventing historical fields', () => {
    const service = loadSync(PROTO_PATHS.finance, GRPC_LOADER_OPTIONS)[
      'wolfari.finance.v1.FinanceService'
    ] as ServiceDefinition;
    const method = service.CreateContributionRequest as MethodDefinition<
      unknown,
      { contribution_request: unknown }
    >;
    const decoded = method.responseDeserialize(
      method.responseSerialize({ contribution_request: request }),
    );
    const legacy = projectContributionRequest(decoded.contribution_request);
    expect(legacy).not.toHaveProperty('contributions');
    expect(legacy).not.toHaveProperty('finance_version');
    expect(() => projectContributionRequest(decoded.contribution_request, false)).toThrow();
  });
  it('whitelists nested allocations and preserves exact money/null and current versions', () => {
    const row = projectContributionRequest({
      ...request,
      finance_version: 3,
      contributions: [
        { ...contribution, destination_snapshot: { secret: 'hidden' } },
      ],
    });
    expect(row.contributions?.[0]).toMatchObject({
      amount: '9007199254740993',
      confirmed_at: null,
      waived_reason: null,
      rejected_reason: null,
      confirmed_by_user_id: null,
    });
    expect(JSON.stringify(row)).not.toContain('hidden');
    expect(
      projectContributionRequest(
        {
          ...request,
          version: 7,
          status: 'CLOSED',
          finance_version: 20,
          contributions: [{ ...contribution, status: 'REVERSED', finance_version: 20, version: 4 }],
        },
        false,
      ).version,
    ).toBe(7);
  });
  it.each([
    { finance_version: 3 },
    { contributions: [contribution] },
    { finance_version: 3, contributions: [] },
    { finance_version: 3, contributions: [{ ...contribution, status: 'CONFIRMED' }] },
    { finance_version: 4, contributions: [contribution] },
    { finance_version: 3, contributions: [contribution, contribution] },
    { finance_version: 3, contributions: [{ ...contribution, request_id: id.replace(/1$/, '2') }] },
  ])('rejects malformed partial or noninitial POST snapshots', (patch) => {
    expect(() => projectContributionRequest({ ...request, ...patch })).toThrow();
  });
  it.each(['PENDING', 'TRANSFER_REPORTED', 'CONFIRMED', 'WAIVED', 'CANCELLED', 'REVERSED'])(
    'supports %s on GET only',
    (status) => {
      expect(projectContribution({ ...contribution, status }).status).toBe(status);
    },
  );
  it.each([
    { amount: 9007199254740993 },
    { amount: '9223372036854775808' },
    { amount: '0' },
    { status: 'PRIVATE' },
    { version: 2147483648 },
    { self_contribution: 1 },
  ])('rejects malformed downstream data', (patch) => {
    expect(() => projectContribution({ ...contribution, ...patch })).toThrow();
  });
  it('checks list scope/filter and version consistency', () => {
    expect(projectContributionPage({}, id, false, {})).toEqual({ items: [], next_cursor: null });
    expect(() =>
      projectContributionPage({ items: [contribution] }, id, false, { status: 'CONFIRMED' }),
    ).toThrow();
    expect(() =>
      projectContributionPage({ items: [contribution] }, id.replace(/1$/, '2'), false, {}),
    ).toThrow();
    expect(() => projectContributionPage({ next_cursor: 'abc' }, id, false, {})).toThrow();
  });
  it('preserves rejection feedback through real protobuf and both read projections', () => {
    const service = loadSync(PROTO_PATHS.finance, GRPC_LOADER_OPTIONS)[
      'wolfari.finance.v1.FinanceService'
    ] as ServiceDefinition;
    const method = service.ListContributions as MethodDefinition<unknown, { items: unknown[] }>;
    const decoded = method.responseDeserialize(method.responseSerialize({ items: [{
      ...contribution, version: 3, rejected_reason: 'Chưa nhận được khoản chuyển',
      destination_snapshot: { secret: 'private' }, transfer_evidence_object_key: 'private',
    }] }));
    const page = projectContributionPage(decoded, id, false, {});
    expect(page.items[0]).toMatchObject({ rejected_reason: 'Chưa nhận được khoản chuyển' });
    expect(JSON.stringify(page)).not.toContain('private');
    const nested = projectContributionRequest({ ...request, version: 2, finance_version: 3,
      contributions: decoded.items }, false);
    expect(nested.contributions?.[0]?.rejected_reason).toBe('Chưa nhận được khoản chuyển');
    expect(() => projectContribution({ ...contribution, rejected_reason: 42 })).toThrow();
    expect(projectContribution(contribution).rejected_reason).toBeNull();
  });
});
