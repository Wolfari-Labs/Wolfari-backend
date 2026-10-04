import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { DatabaseProvider } from '@wolfari/database';
import { CommonV1, RPC_CATALOG } from '../packages/contracts/src/grpc';
import {
  command,
  requestHash,
  operationView,
  verifyReplay,
  validateReceipt,
  retryDelays,
  type LifecycleRow,
} from '../apps/trip-workspace-service/src/membership/membership.domain';
import { MembershipRepository } from '../apps/trip-workspace-service/src/membership/membership.repository';
import { LifecycleService } from '../apps/trip-workspace-service/src/operations/lifecycle.service';
import { LifecycleFinanceClient } from '../apps/trip-workspace-service/src/operations/lifecycle-finance.client';
import { projectOperation } from '../apps/api-gateway/src/membership-proxy';
// @ts-expect-error Native ESM configuration shared with launcher.
import { appEnvironment, apps } from './config.mjs';
const input = {
  operation_id: randomUUID(),
  actor_user_id: randomUUID(),
  trip_id: randomUUID(),
  reason: ' Leave ',
  expected_membership_revision: 3,
};
const member = randomUUID();
const config = (values: Record<string, string> = {}) =>
  ({ get: (key: string) => values[key] }) as ConfigService;
const cmd = command(input, 'LEAVE_MEMBER');
function row(): LifecycleRow {
  return {
    operation_id: input.operation_id,
    trip_id: input.trip_id,
    actor_user_id: input.actor_user_id,
    operation_type: 'LEAVE_MEMBER',
    request_hash: requestHash(cmd, member),
    state: 'SUCCEEDED',
    retry_count: 0,
    next_retry_at: null,
    command_payload: {
      ...cmd,
      version: 1,
      targetMemberId: member,
      targetUserId: input.actor_user_id,
      correlationId: randomUUID(),
      authorizationContext: { active_user_ids: [] },
    },
    outcome: {
      status: CommonV1.ReceiptStatus.RECEIPT_STATUS_COMMITTED,
      blocking_ids: [randomUUID()],
      finance_version: 99,
    },
  };
}
describe('membership lifecycle boundaries', () => {
  it('only Trip and Finance receive the independent Trip-to-Finance credential', () => {
    const values = {
      TRIP_FINANCE_SECRET: 's'.repeat(64),
      FINANCE_GRPC_TARGET: '127.0.0.1:3204',
      TRIP_MEMBERSHIP_LIFECYCLE_ENABLED: 'false',
    };
    for (const app of apps) {
      const env = appEnvironment(app, values, {});
      expect(env.TRIP_FINANCE_SECRET).toBe(
        ['trip-workspace-service', 'finance-service'].includes(app.name)
          ? values.TRIP_FINANCE_SECRET
          : undefined,
      );
      expect(env.TRIP_MEMBERSHIP_LIFECYCLE_ENABLED).toBe(
        app.name === 'trip-workspace-service' ? 'false' : undefined,
      );
    }
  });
  it.each(['ListMembers', 'LeaveTrip', 'RemoveMember'])('restricts %s to Gateway', (name) => {
    expect(RPC_CATALOG.find((r) => r.method === name)).toMatchObject({
      callers: ['ApiGateway'],
      deadline_ms: 2000,
    });
  });
  it.each([
    { reason: '' },
    { reason: ' '.repeat(10) },
    { reason: 'x'.repeat(1001) },
    { reason: 1 },
    { expected_membership_revision: 0 },
    { expected_membership_revision: '3' },
    { expected_membership_revision: 1.5 },
    { operation_id: 'bad' },
    { actor_user_id: 'bad' },
  ])('rejects invalid command %j', (override) => {
    expect(() => command({ ...input, ...override }, 'LEAVE_MEMBER')).toThrow('VALIDATION_FAILED');
  });
  it('normalizes reason and binds target membership, actor, command, revision', () => {
    expect(cmd.reason).toBe('Leave');
    for (const changed of [
      { ...cmd, reason: 'Other' },
      { ...cmd, actorUserId: randomUUID() },
      { ...cmd, expectedRevision: 4 },
    ])
      expect(requestHash(changed, member)).not.toBe(requestHash(cmd, member));
    expect(requestHash(cmd, randomUUID())).not.toBe(requestHash(cmd, member));
  });
  it('replays leave without fresh membership and never returns Finance private fields', () => {
    const saved = row();
    expect(() => verifyReplay(saved, cmd)).not.toThrow();
    const view = projectOperation(operationView(saved));
    expect(view).toEqual({
      operation_id: saved.operation_id,
      trip_id: saved.trip_id,
      state: 'SUCCEEDED',
      outcome: { status: 'COMMITTED' },
    });
    expect(JSON.stringify(view)).not.toContain('finance_version');
  });
  it('masks another actor receipt, rejects changed payload and target', () => {
    expect(() => verifyReplay(row(), { ...cmd, actorUserId: randomUUID() })).toThrow(
      'RESOURCE_NOT_FOUND',
    );
    expect(() => verifyReplay(row(), { ...cmd, reason: 'changed' })).toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
    expect(() => verifyReplay(row(), { ...cmd, memberId: randomUUID() })).toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
  });
  it.each(['COMMITTED', 'REJECTED', 'CANCELLED'] as const)(
    'validates Finance terminal %s',
    (name) => {
      const saved = row();
      expect(
        validateReceipt(saved, {
          operation_id: saved.operation_id,
          request_hash: saved.request_hash,
          completed_at: { seconds: '1', nanos: 0 },
          outcome: {
            status: CommonV1.ReceiptStatus[`RECEIPT_STATUS_${name}`],
            blocking_ids: ['private'],
          },
        }).blocking_ids,
      ).toEqual([]);
    },
  );
  it.each([
    { request_hash: 'bad' },
    { operation_id: randomUUID() },
    { completed_at: undefined },
    { outcome: { status: 0 } },
    { outcome: { status: 1, error_code: 'FINANCE_OBLIGATION_BLOCKED' } },
    { outcome: { status: 2, error_code: 'private detail' } },
  ])('rejects invalid receipt %j', (override) => {
    const saved = row();
    expect(() =>
      validateReceipt(saved, {
        operation_id: saved.operation_id,
        request_hash: saved.request_hash,
        completed_at: { seconds: '1', nanos: 0 },
        outcome: { status: 1, blocking_ids: [] },
        ...override,
      } as CommonV1.Receipt),
    ).toThrow();
  });
  it('preserves retry schedule and defaults to disabled without Finance', () => {
    expect(retryDelays).toEqual([10, 30, 120, 300, 900]);
    const client = new LifecycleFinanceClient(config());
    client.onApplicationShutdown();
    expect(
      () => new LifecycleFinanceClient(config({ TRIP_MEMBERSHIP_LIFECYCLE_ENABLED: 'true' })),
    ).toThrow();
  });
  it('leave replay does not require current membership authorization', async () => {
    const saved = row();
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('trip_operations') ? [saved] : [],
      rowCount: 1,
    }));
    const db = {
      withTransaction: (fn: (c: unknown) => unknown) => fn({ query }),
    } as unknown as DatabaseProvider;
    const repo = new MembershipRepository(db);
    expect((await repo.prepare(cmd, randomUUID(), false)).fresh).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('trip_members'))).toBe(false);
  });
  it('remove replay requires current Owner despite a valid receipt', async () => {
    const remove = { ...cmd, command: 'REMOVE_MEMBER' as const, memberId: member };
    const saved = {
      ...row(),
      operation_type: 'REMOVE_MEMBER' as const,
      request_hash: requestHash(remove, member),
      command_payload: { ...row().command_payload, ...remove },
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('trip_operations')) return { rows: [saved], rowCount: 1 };
      if (sql.includes('SELECT * FROM trip_members'))
        return {
          rows: [{ id: randomUUID(), user_id: cmd.actorUserId, left_at: null, role: 'MEMBER' }],
          rowCount: 1,
        };
      return { rows: [{ id: cmd.tripId }], rowCount: 1 };
    });
    const db = {
      withTransaction: (fn: (c: unknown) => unknown) => fn({ query }),
    } as unknown as DatabaseProvider;
    await expect(
      new MembershipRepository(db).prepare(remove, randomUUID(), true),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
  it('rejects a forged invalid timestamp cursor before opening a database transaction', async () => {
    const repo = { db: { withTransaction: vi.fn() } } as unknown as MembershipRepository;
    const service = new LifecycleService(repo, {} as LifecycleFinanceClient, config());
    const cursor = Buffer.from(
      JSON.stringify({
        version: 1,
        trip: cmd.tripId,
        includeLeft: false,
        joined: '2026-02-31T00:00:00.000000Z',
        id: member,
      }),
    ).toString('base64url');
    await expect(
      service.list({ trip_id: cmd.tripId, actor_user_id: cmd.actorUserId, limit: 20, cursor }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(repo.db.withTransaction).not.toHaveBeenCalled();
  });
  it('does not expose non-lifecycle receipts through polling', async () => {
    const repo = {
      operation: vi.fn().mockResolvedValue({ ...row(), operation_type: 'CREATE_TRIP' }),
      db: {},
    } as unknown as MembershipRepository;
    const service = new LifecycleService(repo, {} as LifecycleFinanceClient, config());
    await expect(
      service.getOperation(input.operation_id, input.actor_user_id),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});
