import { loadSync, type MethodDefinition, type ServiceDefinition } from '@grpc/proto-loader';
import { describe, expect, it } from 'vitest';
import { GRPC_LOADER_OPTIONS, GRPC_PACKAGES, PROTO_PATHS, RPC_CATALOG } from './grpc';

function methods(path: string, packageName: string, serviceName: string): ServiceDefinition {
  const definition = loadSync(path, GRPC_LOADER_OPTIONS);
  return definition[`${packageName}.${serviceName}`] as ServiceDefinition;
}

describe('gRPC contracts', () => {
  it('loads exactly the 19 RPCs declared by the catalog', () => {
    const loaded = [
      methods(PROTO_PATHS.identity, GRPC_PACKAGES.identity, 'IdentityService'),
      methods(PROTO_PATHS.trip, GRPC_PACKAGES.trip, 'TripService'),
      methods(PROTO_PATHS.finance, GRPC_PACKAGES.finance, 'FinanceService'),
      methods(PROTO_PATHS.travel, GRPC_PACKAGES.travel, 'TravelService'),
    ];
    expect(loaded.flatMap(service => Object.keys(service))).toHaveLength(19);
    expect(RPC_CATALOG).toHaveLength(19);
    expect(RPC_CATALOG.filter(entry => entry.deadline_ms === 10_000).map(entry => entry.method).sort()).toEqual(['GetRoute', 'GetWeather']);
  });

  it('round-trips snake_case, optional presence, Timestamp, enums and large integer strings', () => {
    const service = methods(PROTO_PATHS.finance, GRPC_PACKAGES.finance, 'FinanceService');
    const method = service.GetExportSnapshot as MethodDefinition<Record<string, unknown>, Record<string, unknown>>;
    const response = {
      snapshot: {
        fund: {
          id: '00000000-0000-4000-8000-000000000006', trip_id: '00000000-0000-4000-8000-000000000003',
          holder_user_id: '00000000-0000-4000-8000-000000000002', currency: 'VND',
          budget_amount: '9223372036854775807', current_balance: '9007199254740993',
          reserved_refund: '0', available_balance: '9007199254740993', status: 1, finance_version: 7,
        },
        contributions: [],
        expenses: [{ id: 'expense', title: 'Taxi', amount: '9007199254740993', status: 'PAID', paid_at: { seconds: '9007199254740993', nanos: 123 }, version: 1 }],
        notes: [], refunds: [],
        ledger: [{ id: 'ledger', sequence: '9007199254740993', direction: 2, transaction_type: 'EXPENSE', amount: '9007199254740993', balance_after: '0', created_at: { seconds: '9007199254740993', nanos: 0 } }],
        environment: 'TEST',
      },
      finance_version: 7,
      captured_at: { seconds: '9007199254740993', nanos: 456 },
    };
    const decoded = method.responseDeserialize(method.responseSerialize(response)) as typeof response;
    expect(decoded.snapshot.fund.current_balance).toBe('9007199254740993');
    expect(decoded.snapshot.ledger[0]?.sequence).toBe('9007199254740993');
    expect(decoded.captured_at.seconds).toBe('9007199254740993');
    expect(decoded.snapshot.fund.status).toBe(1);
    expect('description' in decoded.snapshot.expenses[0]!).toBe(false);

    response.snapshot.expenses[0]!.description = '';
    const withEmpty = method.responseDeserialize(method.responseSerialize(response)) as typeof response;
    expect(withEmpty.snapshot.expenses[0]!.description).toBe('');
  });
});
