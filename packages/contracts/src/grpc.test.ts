import { loadSync, type MethodDefinition, type ServiceDefinition } from '@grpc/proto-loader';
import { describe, expect, it } from 'vitest';
import { GRPC_LOADER_OPTIONS, GRPC_PACKAGES, PROTO_PATHS, RPC_CATALOG } from './grpc';

function methods(path: string, packageName: string, serviceName: string): ServiceDefinition {
  const definition = loadSync(path, GRPC_LOADER_OPTIONS);
  return definition[`${packageName}.${serviceName}`] as ServiceDefinition;
}

describe('gRPC contracts', () => {
  it('loads exactly the 23 RPCs declared by the catalog', () => {
    const loaded = [
      [
        GRPC_PACKAGES.identity,
        'IdentityService',
        methods(PROTO_PATHS.identity, GRPC_PACKAGES.identity, 'IdentityService'),
      ],
      [
        GRPC_PACKAGES.trip,
        'TripService',
        methods(PROTO_PATHS.trip, GRPC_PACKAGES.trip, 'TripService'),
      ],
      [
        GRPC_PACKAGES.finance,
        'FinanceService',
        methods(PROTO_PATHS.finance, GRPC_PACKAGES.finance, 'FinanceService'),
      ],
      [
        GRPC_PACKAGES.travel,
        'TravelService',
        methods(PROTO_PATHS.travel, GRPC_PACKAGES.travel, 'TravelService'),
      ],
    ];
    const loadedMethods = loaded
      .flatMap(([packageName, serviceName, service]) =>
        Object.keys(service as ServiceDefinition).map(
          (method) => `${packageName}.${serviceName}/${method}`,
        ),
      )
      .sort();
    const catalogMethods = RPC_CATALOG.map(
      (entry) => `${entry.package}.${entry.service}/${entry.method}`,
    ).sort();
    expect(loadedMethods).toEqual(catalogMethods);
    expect(RPC_CATALOG).toHaveLength(23);
    expect(
      RPC_CATALOG.filter((entry) => entry.deadline_ms === 10_000)
        .map((entry) => entry.method)
        .sort(),
    ).toEqual(['GetRoute', 'GetWeather']);
  });

  it('round-trips Trip PATCH absent, empty-string and clear states', () => {
    const service = methods(PROTO_PATHS.trip, GRPC_PACKAGES.trip, 'TripService');
    const method = service.UpdateTrip as MethodDefinition<
      Record<string, unknown>,
      Record<string, unknown>
    >;
    const base = {
      operation_id: '00000000-0000-4000-8000-000000000011',
      actor_user_id: '00000000-0000-4000-8000-000000000002',
      trip_id: '00000000-0000-4000-8000-000000000003',
      expected_export_revision: 4,
      expected_plan_version: 7,
    };
    const absent = method.requestDeserialize(method.requestSerialize(base));
    expect('name' in absent).toBe(false);
    expect('description' in absent).toBe(false);
    expect('public_description' in absent).toBe(false);

    const changes = method.requestDeserialize(
      method.requestSerialize({
        ...base,
        name: '',
        description: { value: '' },
        public_description: { clear: true },
      }),
    ) as Record<string, unknown>;
    expect(changes.name).toBe('');
    expect(changes.description).toEqual({ value: '', change: 'value' });
    expect(changes.public_description).toEqual({ clear: true, change: 'clear' });
  });

  it('round-trips snake_case, optional presence, Timestamp, enums and large integer strings', () => {
    const service = methods(PROTO_PATHS.finance, GRPC_PACKAGES.finance, 'FinanceService');
    const method = service.GetExportSnapshot as MethodDefinition<
      Record<string, unknown>,
      Record<string, unknown>
    >;
    const response = {
      snapshot: {
        fund: {
          id: '00000000-0000-4000-8000-000000000006',
          trip_id: '00000000-0000-4000-8000-000000000003',
          holder_user_id: '00000000-0000-4000-8000-000000000002',
          currency: 'VND',
          budget_amount: '9223372036854775807',
          current_balance: '9007199254740993',
          reserved_refund: '0',
          available_balance: '9007199254740993',
          status: 1,
          finance_version: 7,
        },
        contributions: [],
        expenses: [
          {
            id: 'expense',
            title: 'Taxi',
            amount: '9007199254740993',
            status: 'PAID',
            paid_at: { seconds: '9007199254740993', nanos: 123 },
            version: 1,
          },
        ],
        notes: [],
        refunds: [],
        ledger: [
          {
            id: 'ledger',
            sequence: '9007199254740993',
            direction: 2,
            transaction_type: 'EXPENSE',
            amount: '9007199254740993',
            balance_after: '0',
            created_at: { seconds: '9007199254740993', nanos: 0 },
          },
        ],
        environment: 'TEST',
      },
      finance_version: 7,
      captured_at: { seconds: '9007199254740993', nanos: 456 },
    };
    const decoded = method.responseDeserialize(
      method.responseSerialize(response),
    ) as typeof response;
    expect(decoded.snapshot.fund.current_balance).toBe('9007199254740993');
    expect(decoded.snapshot.ledger[0]?.sequence).toBe('9007199254740993');
    expect(decoded.captured_at.seconds).toBe('9007199254740993');
    expect(decoded.snapshot.fund.status).toBe(1);
    expect('description' in decoded.snapshot.expenses[0]!).toBe(false);

    response.snapshot.expenses[0]!.description = '';
    const withEmpty = method.responseDeserialize(
      method.responseSerialize(response),
    ) as typeof response;
    expect(withEmpty.snapshot.expenses[0]!.description).toBe('');
  });
});
