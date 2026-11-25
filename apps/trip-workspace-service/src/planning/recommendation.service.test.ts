import { describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@wolfari/database';
import { TravelV1 } from '@wolfari/contracts/grpc';
import { RecommendationService, storedItems } from './recommendation.service';
import type { TravelClient } from './travel.client';

const actor = '10000000-0000-4000-8000-000000000001',
  trip = '20000000-0000-4000-8000-000000000001',
  rec = '50000000-0000-4000-8000-000000000001',
  key = '60000000-0000-4000-8000-000000000001',
  activity = '70000000-0000-4000-8000-000000000001',
  correlation = '80000000-0000-4000-8000-000000000001';
const access = {
  id: trip,
  start_at: '2026-12-01T00:00:00Z',
  end_at: '2026-12-03T00:00:00Z',
  timezone: 'Asia/Ho_Chi_Minh',
  role: 'OWNER',
  selected_editor: false,
  membership_id: actor,
  plan_edit_policy: 'OWNER_ONLY',
  plan_version: 4,
  export_revision: 7,
  archived_at: null,
};
const items = [
  {
    id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    kind: 'PACKING',
    packing_item: { name: 'Ô', quantity: '1', unit: 'cái', category: 'Khác' },
    reasons: ['Ngày 1/12 khả năng mưa 60%'],
    rule_ids: ['PK-RAIN'],
    warnings: [],
  },
  {
    id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    kind: 'PACKING',
    packing_item: { name: 'Đồ bơi', quantity: '1' },
    reasons: ['Có hoạt động đi biển'],
    rule_ids: ['PK-BEACH'],
    warnings: [],
  },
  {
    id: 'cccccccccccccccccccccccc',
    kind: 'DRESS_CODE',
    dress_code: { label: 'Trang phục kín đáo', activity_id: activity },
    reasons: ['Nhà thờ'],
    rule_ids: ['DC-MODEST'],
    warnings: [],
  },
];
const receipt = (o: Record<string, unknown> = {}) => ({
  id: rec,
  trip_id: trip,
  rule_version: 'dss-2026.11.1',
  base_plan_version: 4,
  proposal: { items, warnings: [], sources: [] },
  apply_request_id: null,
  status: 'PREVIEWED',
  applied_plan_version: null,
  created_at: new Date(),
  expires_at: new Date(Date.now() + 60_000),
  recommendation_type: 'ALL',
  ...o,
});

function harness(
  opts: {
    access?: Partial<typeof access>;
    receipt?: Record<string, unknown>;
    saved?: unknown;
    existing?: string[];
    travel?: Partial<TravelClient>;
  } = {},
) {
  const inserts: string[] = [];
  let stored: Record<string, unknown> = receipt(opts.receipt);
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM trips t JOIN'))
      return { rows: [{ ...access, ...opts.access }], rowCount: 1 };
    if (sql.includes('FROM trip_operations'))
      return { rows: opts.saved ? [opts.saved] : [], rowCount: opts.saved ? 1 : 0 };
    if (sql.startsWith('SELECT id,trip_id,rule_version')) return { rows: [stored], rowCount: 1 };
    if (sql.includes('FROM packing_items WHERE trip_id'))
      return { rows: (opts.existing ?? []).map((k) => ({ key: k })), rowCount: 0 };
    if (sql.includes('SELECT id FROM activities')) return { rows: [{ id: activity }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO packing_items') || sql.startsWith('INSERT INTO dress_codes')) {
      inserts.push(/^INSERT INTO (\w+)/.exec(sql)![1]!);
      return {
        rows: [{ id: `90000000-0000-4000-8000-00000000000${inserts.length}` }],
        rowCount: 1,
      };
    }
    if (sql.startsWith('UPDATE trips SET plan_version'))
      return { rows: [{ plan_version: 5 }], rowCount: 1 };
    if (sql.startsWith("UPDATE recommendation_receipts SET status='APPLIED'")) {
      stored = {
        ...stored,
        status: 'APPLIED',
        applied_plan_version: params[2],
        proposal: { ...(stored.proposal as object), applied: JSON.parse(String(params[3])) },
      };
      return { rows: [stored], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE recommendation_receipts SET status='REJECTED'")) {
      stored = { ...stored, status: 'REJECTED' };
      return { rows: [stored], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO recommendation_receipts'))
      return { rows: [{ ...stored, proposal: JSON.parse(String(params[4])) }], rowCount: 1 };
    if (sql.includes('FROM activities WHERE trip_id=$1 ORDER BY'))
      return {
        rows: [
          {
            id: activity,
            trip_id: trip,
            title: 'Nhà thờ',
            activity_type: 'CHURCH',
            selected_location_id: null,
            starts_at: '2026-12-01T03:00:00Z',
            ends_at: null,
            scheduled_date: null,
            position: 0,
            status: 'TODO',
            source: 'MANUAL',
            completed_at: null,
          },
        ],
        rowCount: 1,
      };
    return { rows: [], rowCount: 1 };
  });
  const database = {
    query,
    withTransaction: async (work: (c: { query: typeof query }) => unknown) => work({ query }),
  } as unknown as DatabaseProvider;
  const travel = {
    configured: true,
    recommend: vi.fn(async () => ({
      proposal: [
        {
          id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
          packing_item: { name: 'Ô', quantity: '1' },
          reason: 'Ngày 1/12 khả năng mưa 60%',
          rule_ids: ['PK-RAIN'],
          warnings: [],
        },
        {
          id: 'dddddddddddddddddddddddd',
          dress_code: { label: 'Đồ đi biển', activity_id: '00000000-0000-4000-8000-000000000999' },
          reason: 'x',
          rule_ids: ['DC-BEACH'],
        },
      ],
      rule_version: 'dss-2026.11.1',
      input_hash: 'f'.repeat(64),
      warnings: ['WEATHER_UNAVAILABLE'],
      provider_sources: [
        {
          provider: 'OPEN_METEO',
          fetched_at: { seconds: '1795600000' },
          stale: false,
          is_mock: false,
          attribution: [{ text: 'Weather data by Open-Meteo.com', url: 'https://open-meteo.com/' }],
        },
      ],
    })),
    ...opts.travel,
  } as unknown as TravelClient;
  return { svc: new RecommendationService(database, travel), query, inserts, travel };
}
const apply = {
  actor_user_id: actor,
  recommendation_id: rec,
  apply_request_id: key,
  item_ids: items.map((i) => i.id),
  expected_plan_version: 4,
};

describe('storedItems', () => {
  it('keeps only well-formed proposals for activities that exist', () => {
    const out = storedItems(
      [
        {
          id: 'a1',
          packing_item: { name: '  Ô ', quantity: '1e9' },
          reason: 'r1\nr2',
          rule_ids: ['PK-RAIN', 'bad rule'],
        },
        { id: 'a2', dress_code: { label: 'X', activity_id: 'gone' } },
        { packing_item: { name: 'no id', quantity: '1' } },
      ] as TravelV1.ProposalItem[],
      new Set(['a']),
    );
    expect(out).toEqual([
      {
        id: 'a1',
        kind: 'PACKING',
        packing_item: { name: 'Ô', quantity: '1' },
        reasons: ['r1', 'r2'],
        rule_ids: ['PK-RAIN'],
        warnings: [],
      },
    ]);
  });
});

describe('preview', () => {
  it('lets a member preview without apply rights and stores an allowlisted proposal', async () => {
    const h = harness({ access: { role: 'MEMBER' } });
    const res = await h.svc.preview(
      { actor_user_id: actor, trip_id: trip, type: 'ALL' },
      correlation,
    );
    expect(res.can_apply).toBe(false);
    expect(res.items.map((i) => i.id)).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaa']);
    expect(res.warnings).toEqual(['WEATHER_UNAVAILABLE']);
    expect(res.sources[0]).toMatchObject({
      provider: 'OPEN_METEO',
      fetched_at: new Date(1795600000 * 1000).toISOString(),
    });
    const plan = (h.travel.recommend as ReturnType<typeof vi.fn>).mock.calls[0]![0].plan;
    expect(plan.activities[0]).toMatchObject({ id: activity, activity_type: 'CHURCH' });
  });
  it('answers SERVICE_UNAVAILABLE when Travel is down or not configured', async () => {
    await expect(
      harness({
        travel: {
          recommend: vi.fn(async () => {
            throw new Error('down');
          }),
        },
      }).svc.preview({ actor_user_id: actor, trip_id: trip, type: 'ALL' }, correlation),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await expect(
      harness({ travel: { configured: false } as Partial<TravelClient> }).svc.preview(
        { actor_user_id: actor, trip_id: trip, type: 'ALL' },
        correlation,
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
  it('rejects an unknown type or a malformed date', async () => {
    await expect(
      harness().svc.preview({ actor_user_id: actor, trip_id: trip, type: 'X' }, correlation),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      harness().svc.preview(
        { actor_user_id: actor, trip_id: trip, type: 'ALL', date: '1/12' },
        correlation,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('apply', () => {
  it('adds the chosen items as DSS rows in one Plan version', async () => {
    const h = harness();
    const res = await h.svc.apply(apply, correlation);
    expect(h.inserts).toEqual(['packing_items', 'packing_items', 'dress_codes']);
    expect(
      h.query.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE trips SET plan_version')),
    ).toHaveLength(1);
    expect(res).toMatchObject({ status: 'APPLIED', applied_plan_version: 5 });
    expect(h.query.mock.calls.some(([sql]) => String(sql).includes("'DSS'"))).toBe(true);
  });
  it('applies only what was chosen and skips names already on the list', async () => {
    const h = harness({ existing: ['ô'] });
    const res = await h.svc.apply(
      { ...apply, item_ids: [items[0]!.id, items[1]!.id] },
      correlation,
    );
    expect(h.inserts).toEqual(['packing_items']);
    expect((res as { applied?: { skipped: unknown[] } }).applied?.skipped).toEqual([
      { item_id: items[0]!.id, reason: 'ALREADY_IN_PLAN' },
    ]);
  });
  it('replays the same key without creating a second set', async () => {
    const h = harness({
      receipt: { status: 'APPLIED', applied_plan_version: 5 },
      saved: {
        operation_id: key,
        trip_id: trip,
        operation_type: 'APPLY_RECOMMENDATION',
        actor_user_id: actor,
        state: 'SUCCEEDED',
        outcome: {},
        request_hash: (await import('../trip-common.js')).digest({
          operationType: 'APPLY_RECOMMENDATION',
          actor,
          recommendationId: rec,
          expected: 4,
          itemIds: items.map((i) => i.id).sort(),
        }),
      },
    });
    const res = await h.svc.apply(apply, correlation);
    expect(h.inserts).toEqual([]);
    expect(res.status).toBe('APPLIED');
  });
  it('blocks a member who cannot edit, a moved Plan and an expired preview', async () => {
    await expect(
      harness({ access: { role: 'MEMBER' } }).svc.apply(apply, correlation),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      harness({ access: { plan_version: 5 } }).svc.apply(
        { ...apply, expected_plan_version: 5 },
        correlation,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(
      harness({ receipt: { expires_at: new Date(Date.now() - 1) } }).svc.apply(apply, correlation),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT', details: { reason: 'EXPIRED' } });
    await expect(
      harness().svc.apply({ ...apply, item_ids: ['eeeeeeeeeeeeeeeeeeeeeeee'] }, correlation),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('ignore', () => {
  it('rejects the preview without touching the Plan', async () => {
    const h = harness();
    const res = await h.svc.ignore({ actor_user_id: actor, recommendation_id: rec });
    expect(res.status).toBe('REJECTED');
    expect(h.inserts).toEqual([]);
  });
});
