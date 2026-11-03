import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { DatabaseProvider } from '@wolfari/database';
import { isCalendarDate } from '../packages/common/src/calendar-date';
import {
  normalizeActivityFields,
  planRequestHash,
} from '../apps/trip-workspace-service/src/planning/plan.service';
import { projectActivity } from '../apps/api-gateway/src/plan-proxy';
import {
  GatewayReadinessController,
  checkDependency,
} from '../apps/api-gateway/src/readiness.controller';
import { TripPlanAccessService } from '../apps/trip-workspace-service/src/trip-plan-access.service';
import { MemberProfilesService } from '../apps/trip-workspace-service/src/membership/member-profiles.service';
import type { LifecycleService } from '../apps/trip-workspace-service/src/operations/lifecycle.service';
import { digest } from '../apps/trip-workspace-service/src/trip-common';
// @ts-expect-error native CLI module
import { inspectDemoAccounts, validateSeedJournal } from './demo-accounts.mjs';

const actor = '10000000-0000-4000-8000-000000000001';
const trip = '20000000-0000-4000-8000-000000000001';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Demo 1 calendar contract', () => {
  it.each(['2026-11-01', '2024-02-29', '0001-01-01', '9999-12-31'])('accepts %s', (value) => {
    expect(isCalendarDate(value)).toBe(true);
    expect(normalizeActivityFields({ scheduled_date: value }, false)).toEqual({
      scheduled_date: value,
    });
  });
  it.each([
    '2026-02-29',
    '2026-04-31',
    '0000-01-01',
    '2026-1-01',
    '',
    '2026-11-01T00:00:00Z',
    1,
    undefined,
  ])('rejects invalid day %s', (value) => {
    expect(isCalendarDate(value)).toBe(false);
    expect(() => normalizeActivityFields({ scheduled_date: value }, false)).toThrow();
  });
  it('distinguishes clear and omission and keeps pre-extension hashes byte-for-byte', () => {
    expect(normalizeActivityFields({ scheduled_date: null }, false)).toEqual({
      scheduled_date: null,
    });
    const fields = normalizeActivityFields(
      { title: 'Walk', activity_type: 'OTHER', position: 0 },
      true,
    );
    expect(fields).not.toHaveProperty('scheduled_date');
    const legacyFields = {
      title: 'Walk',
      activity_type: 'OTHER',
      description: null,
      public_description: null,
      selected_location_id: null,
      starts_at: null,
      ends_at: null,
      position: 0,
    };
    const input = {
      command: 'CREATE_ACTIVITY' as const,
      actorUserId: actor,
      tripId: trip,
      operationId: actor,
      correlationId: actor,
      expectedPlanVersion: 1,
      fields,
    };
    expect(planRequestHash(input)).toBe(
      digest({
        actor_user_id: actor,
        command: 'CREATE_ACTIVITY',
        trip_id: trip,
        payload: { expected_plan_version: 1, fields: legacyFields },
      }),
    );
    expect(
      planRequestHash({ ...input, fields: { ...fields, scheduled_date: '2026-11-01' } }),
    ).not.toBe(planRequestHash(input));
  });
  it('projects a legacy receipt without a day as null', () => {
    const result = projectActivity({
      id: actor,
      trip_id: trip,
      title: 'Legacy',
      activity_type: 'OTHER',
      position: 0,
      status: 1,
      source: 1,
      created_by_user_id: actor,
      plan_version: 1,
    });
    expect(result.scheduled_date).toBeNull();
  });
});

describe('Owner policy reads', () => {
  function service(role: string | null) {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM trips t'))
        return {
          rows: role
            ? [
                {
                  trip_id: trip,
                  plan_edit_policy: 'OWNER_ONLY',
                  membership_revision: 7,
                  membership_role: role,
                },
              ]
            : [],
        };
      if (sql.includes('FROM trip_plan_editors')) return { rows: [{ trip_member_id: actor }] };
      return { rows: [] };
    });
    return {
      query,
      api: new TripPlanAccessService({
        withTransaction: async (fn: (client: unknown) => unknown) => fn({ query }),
      } as unknown as DatabaseProvider),
    };
  }
  it('returns inert active editor assignments without writes', async () => {
    const { api, query } = service('OWNER');
    expect(await api.getPolicy(actor, trip)).toEqual({
      policy: 'OWNER_ONLY',
      membership_revision: 7,
      editor_member_ids: [actor],
    });
    expect(query.mock.calls.every(([sql]) => !/INSERT|UPDATE|DELETE/.test(sql))).toBe(true);
  });
  it.each([
    ['MEMBER', 'PERMISSION_DENIED'],
    [null, 'RESOURCE_NOT_FOUND'],
  ])('denies %s', async (role, code) => {
    await expect(service(role).api.getPolicy(actor, trip)).rejects.toMatchObject({ code });
  });
});

describe('Member names are enrichment, not authorization', () => {
  async function run(options: { offline?: boolean; revoked?: boolean; denied?: boolean } = {}) {
    const names = vi.fn();
    if (options.offline) names.mockRejectedValue(new Error('private upstream detail'));
    else
      names.mockResolvedValue({
        profiles: [
          { id: actor, display_name: 'Member One' },
          { id: trip, display_name: 'Must never be exposed' },
        ],
      });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list = vi.fn(async () => {
      if (options.denied) throw Object.assign(new Error(), { code: 'RESOURCE_NOT_FOUND' });
      return { items: [{ id: actor, trip_id: trip, user_id: actor, role: 2 }] };
    });
    const query = vi.fn(async () => ({ rowCount: options.revoked ? 0 : 1 }));
    const api = new MemberProfilesService(
      { list } as unknown as LifecycleService,
      { query } as unknown as DatabaseProvider,
      {
        getOrThrow: (key: string) =>
          key === 'IDENTITY_GRPC_TARGET' ? '127.0.0.1:13201' : 's'.repeat(32),
      } as ConfigService,
    );
    const internal = api as unknown as { identity: { getProfiles: typeof names } };
    vi.spyOn(internal.identity, 'getProfiles').mockImplementation(names);
    try {
      const result = await api.list(
        { actor_user_id: actor, trip_id: trip },
        actor,
        Date.now() + 1500,
      );
      return { result, names };
    } finally {
      if (options.denied) expect(names).not.toHaveBeenCalled();
      api.onApplicationShutdown();
    }
  }
  it('looks up only authorized page IDs; no extra profiles leak', async () => {
    const { result, names } = await run();
    expect(result.items).toHaveLength(1);
    expect(result.items?.[0]?.display_name).toBe('Member One');
    expect(names.mock.calls[0]?.[0]).toEqual({ user_ids: [actor] });
  });
  it('keeps membership data available when enrichment fails', async () => {
    const { result } = await run({ offline: true });
    expect(result.items?.[0]?.display_name).toBeUndefined();
    expect(result.items?.[0]?.user_id).toBe(actor);
  });
  it('denies revocation during lookup', async () => {
    await expect(run({ revoked: true })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
  it('does not call Identity for an unauthorized list', async () => {
    await expect(run({ denied: true })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});

describe('Local diagnostics', () => {
  it('rejects non-loopback diagnostic targets without making requests', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await checkDependency('https://example.test')).toBe('down');
    expect(await checkDependency('http://127.0.0.1:1234/path')).toBe('down');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not couple core readiness to Finance/Automation', async () => {
    for (const name of ['IDENTITY', 'TRIP', 'FINANCE', 'AUTOMATION'])
      vi.stubEnv(
        name + '_HTTP_URL',
        'http://127.0.0.1:' + { IDENTITY: 3101, TRIP: 3102, FINANCE: 3104, AUTOMATION: 3105 }[name],
      );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => new Response('', { status: /310[45]/.test(url) ? 503 : 200 })),
    );
    const api = new GatewayReadinessController();
    expect((await api.ready()).status).toBe('ok');
    await expect(api.dependencies()).rejects.toMatchObject({ status: 503 });
  });
  it('reads journal and Identity without logging passwords or mutating data', async () => {
    const state = {
      version: 1,
      instanceId: 'demo',
      accounts: {
        owner: { email: 'legacy-owner@example.test', password: 'never-output-this' },
      },
    };
    const query = vi.fn(async () => ({
      rows: [
        { email: 'legacy-owner@example.test', status: 'ACTIVE', email_verified_at: new Date() },
      ],
    }));
    const result = await inspectDemoAccounts(
      {
        manifest: { instanceId: 'demo' },
        configs: { 'identity-service': { DATABASE_URL: 'secret-url' } },
      },
      {
        readFile: async () => JSON.stringify(state),
        connect: async () => ({ query, end: async () => {} }),
      },
    );
    expect(JSON.stringify(result)).not.toContain('never-output-this');
    expect(JSON.stringify(result)).not.toContain('secret-url');
    expect(result.accounts).toEqual([
      { role: 'owner', email: 'legacy-owner@example.test', status: 'ACTIVE', verified: true },
    ]);
    expect(query.mock.calls[0]?.[0]).toBe('BEGIN READ ONLY');
    expect(() => validateSeedJournal(state, 'other')).toThrow('DEMO_SEED_MANIFEST_MISMATCH');
    expect(() => validateSeedJournal({ ...state, accounts: [] }, 'demo')).toThrow(
      'DEMO_SEED_ACCOUNTS_INVALID',
    );
  });
});
