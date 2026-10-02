import { loadSync, type MethodDefinition, type ServiceDefinition } from '@grpc/proto-loader';
import { describe, expect, it } from 'vitest';
import { GRPC_LOADER_OPTIONS, GRPC_PACKAGES, PROTO_PATHS, RPC_CATALOG } from './grpc';

function methods(path: string, packageName: string, serviceName: string): ServiceDefinition {
  const definition = loadSync(path, GRPC_LOADER_OPTIONS);
  return definition[`${packageName}.${serviceName}`] as ServiceDefinition;
}

describe('gRPC contracts', () => {
  it('round-trips additive lifecycle targets and initiator without altering legacy request fields', () => {
    const finance = methods(PROTO_PATHS.finance, GRPC_PACKAGES.finance, 'FinanceService');
    for (const name of ['ExecuteTripOperation', 'CancelOperationIfNotCommitted']) {
      const rpc = finance[name] as MethodDefinition<Record<string, unknown>, object>;
      const legacy = {
        operation_id: 'op',
        request_hash: 'hash',
        authorization_context: { trip_id: 'trip', context_revision: 4 },
      };
      expect(rpc.requestDeserialize(rpc.requestSerialize(legacy))).toEqual(legacy);
      const target = { membership_id: 'membership', user_id: 'target-user', reason: 'Reason' };
      expect(
        rpc.requestDeserialize(rpc.requestSerialize({ ...legacy, membership_target: target })),
      ).toEqual({ ...legacy, membership_target: target });
    }
    const poll = methods(PROTO_PATHS.trip, GRPC_PACKAGES.trip, 'TripService')
      .GetOperationResult as MethodDefinition<object, object>;
    expect(
      poll.requestDeserialize(
        poll.requestSerialize({ operation_id: 'op', actor_user_id: 'initiator' }),
      ),
    ).toEqual({ operation_id: 'op', actor_user_id: 'initiator', _actor_user_id: 'actor_user_id' });
  });
  it('excludes cipher/hash from invitation responses and one-time link from resend', () => {
    const service = methods(PROTO_PATHS.trip, GRPC_PACKAGES.trip, 'TripService');
    const resend = service.ResendInvitation as MethodDefinition<object, object>;
    const value = resend.responseDeserialize(
      resend.responseSerialize({
        invitation: {
          id: 'id',
          version: 2,
          token_hash: 'hidden',
          delivery_token_ciphertext: 'hidden',
        },
        one_time_link: 'hidden',
      }),
    );
    expect(JSON.stringify(value)).not.toContain('hidden');
    const delivery = service.GetInvitationDelivery as MethodDefinition<object, object>;
    expect(
      delivery.requestDeserialize(
        delivery.requestSerialize({ invitation_id: 'id', expected_invitation_version: 4 }),
      ),
    ).toMatchObject({ expected_invitation_version: 4 });
  });
  it('round-trips activity PATCH presence, clears, timestamps and zero position', () => {
    const method = methods(PROTO_PATHS.trip, GRPC_PACKAGES.trip, 'TripService')
      .UpdateActivity as MethodDefinition<Record<string, unknown>, Record<string, unknown>>;
    const roundTrip = (input: Record<string, unknown>) =>
      method.requestDeserialize(method.requestSerialize(input));
    const absent = roundTrip({});
    for (const key of ['description', 'starts_at', 'ends_at', 'position']) {
      expect(Object.hasOwn(absent, key)).toBe(false);
    }
    const value = roundTrip({
      description: { value: '' },
      starts_at: { value: { seconds: '1800000000', nanos: 123000000 } },
      position: 0,
    });
    expect(value.description).toEqual({ value: '', change: 'value' });
    expect(value.starts_at).toEqual({
      value: { seconds: '1800000000', nanos: 123000000 },
      change: 'value',
    });
    expect(value.position).toBe(0);
    const clear = roundTrip({ description: { clear: true }, ends_at: { clear: true } });
    expect(clear.description).toEqual({ clear: true, change: 'clear' });
    expect(clear.ends_at).toEqual({ clear: true, change: 'clear' });
  });

  it('loads exactly the 42 RPCs declared by the catalog', () => {
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
    expect(RPC_CATALOG).toHaveLength(42);
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

  it('round-trips Trip access flags and Plan policy mutation without changing existing fields', () => {
    const service = methods(PROTO_PATHS.trip, GRPC_PACKAGES.trip, 'TripService');
    const access = service.GetAccessContext as MethodDefinition<
      Record<string, unknown>,
      Record<string, unknown>
    >;
    const context = access.responseDeserialize(
      access.responseSerialize({
        context: {
          trip_id: '00000000-0000-4000-8000-000000000003',
          allowed: false,
          permissions: ['TRIP_VIEW'],
          can_read_trip: true,
          can_update_trip_metadata: false,
          can_edit_plan: false,
        },
      }),
    ) as { context: Record<string, unknown> };
    expect(context.context).toMatchObject({
      allowed: false,
      permissions: ['TRIP_VIEW'],
      can_read_trip: true,
      can_update_trip_metadata: false,
      can_edit_plan: false,
    });

    const update = service.UpdatePlanPolicy as MethodDefinition<
      Record<string, unknown>,
      Record<string, unknown>
    >;
    const request = update.requestDeserialize(
      update.requestSerialize({
        operation_id: '00000000-0000-4000-8000-000000000011',
        actor_user_id: '00000000-0000-4000-8000-000000000002',
        trip_id: '00000000-0000-4000-8000-000000000003',
        policy: 2,
        editor_member_ids: ['00000000-0000-4000-8000-000000000004'],
        expected_membership_revision: 7,
      }),
    );
    expect(request).toMatchObject({
      policy: 2,
      editor_member_ids: ['00000000-0000-4000-8000-000000000004'],
      expected_membership_revision: 7,
    });
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
