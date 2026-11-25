import { describe, expect, it } from 'vitest';
import { TripV1 } from '@wolfari/contracts/grpc';
import type { DailyWeather } from '../weather.service';
import { itemKey, recommend, RULE_VERSION, tripDates } from './rules';

const ts = (iso: string) => ({ seconds: String(Date.parse(iso) / 1000), nanos: 0 });
const day = (date: string, w: Partial<DailyWeather> = {}): [string, DailyWeather] => [
  date,
  { date, temperature_max_c: 30, temperature_min_c: 24, rain_probability: 0.1, uv_index: 4, ...w },
];
const activity = (id: string, type: string, title: string, iso: string): TripV1.Activity => ({
  id,
  title,
  activity_type: type,
  starts_at: ts(iso),
  position: 0,
});
// SRS FR-DS03 sample: a rainy day, a beach and a church.
const plan = (extra: Partial<TripV1.PlanSnapshot> = {}): TripV1.PlanSnapshot => ({
  trip_id: 't',
  plan_version: 10,
  timezone: 'Asia/Ho_Chi_Minh',
  start_at: ts('2026-10-12T00:00:00+07:00'),
  end_at: ts('2026-10-14T00:00:00+07:00'),
  activities: [
    activity('a1', 'BEACH', 'Biển Mỹ Khê', '2026-10-12T08:00:00+07:00'),
    activity('a2', 'CHURCH', 'Nhà thờ Con Gà', '2026-10-12T15:00:00+07:00'),
  ],
  packing_items: [],
  dress_codes: [],
  selected_locations: [],
  ...extra,
});
const weather = new Map([day('2026-10-12', { rain_probability: 0.6 }), day('2026-10-13')]);
const names = (r: ReturnType<typeof recommend>) =>
  r.proposals.map((p) => p.packing_item?.name ?? p.dress_code?.label);

describe('trip dates', () => {
  it('covers [start, end) in the Trip time zone', () =>
    expect(tripDates(plan())).toEqual(['2026-10-12', '2026-10-13']));
});

describe('FR-DS03 rules', () => {
  it('SRS sample: rain 60%, BEACH and CHURCH give rain gear, swimwear and modest and beach dress codes', () => {
    const r = recommend({ plan: plan(), weather, type: 'ALL' });
    expect(names(r)).toEqual(['Ô', 'Áo mưa', 'Đồ bơi', 'Đồ đi biển', 'Trang phục kín đáo']);
    const umbrella = r.proposals.find((p) => p.packing_item?.name === 'Ô')!;
    expect(umbrella).toMatchObject({
      rule_ids: ['PK-RAIN'],
      reasons: ['Ngày 12/10 khả năng mưa 60%'],
    });
    expect(
      r.proposals.find((p) => p.dress_code?.label === 'Trang phục kín đáo')?.dress_code,
    ).toMatchObject({
      scope_type: TripV1.DressScope.DRESS_SCOPE_ACTIVITY,
      activity_id: 'a2',
    });
    expect(r.proposals.find((p) => p.dress_code?.label === 'Trang phục kín đáo')).toMatchObject({
      date: '2026-10-12',
    });
    expect(RULE_VERSION).toMatch(/^dss-/);
  });
  it('rain of exactly 50% triggers, 49% does not', () => {
    const at = (p: number) =>
      names(
        recommend({
          plan: plan({ activities: [] }),
          weather: new Map([day('2026-10-12', { rain_probability: p })]),
          type: 'PACKING',
        }),
      );
    expect(at(0.5)).toContain('Ô');
    expect(at(0.49)).not.toContain('Ô');
  });
  it('merges one item suggested by several days or rules into one proposal with each reason', () => {
    const w = new Map([
      day('2026-10-12', { rain_probability: 0.7 }),
      day('2026-10-13', { rain_probability: 0.8 }),
    ]);
    const r = recommend({ plan: plan({ activities: [] }), weather: w, type: 'PACKING' });
    expect(r.proposals.filter((p) => p.packing_item?.name === 'Ô')).toHaveLength(1);
    expect(r.proposals[0]!.reasons).toEqual([
      'Ngày 12/10 khả năng mưa 70%',
      'Ngày 13/10 khả năng mưa 80%',
    ]);
  });
  it('cold, UV and walking thresholds come from config with SRS defaults', () => {
    const p = plan({
      activities: [
        activity('w1', 'WALKING', 'Phố cổ', '2026-10-13T08:00:00+07:00'),
        activity('w2', 'SIGHTSEEING', 'Bảo tàng', '2026-10-13T10:00:00+07:00'),
      ],
    });
    const w = new Map([day('2026-10-13', { temperature_min_c: 17, uv_index: 8 })]);
    expect(names(recommend({ plan: p, weather: w, type: 'PACKING' }))).toEqual([
      'Áo ấm',
      'Kem chống nắng',
      'Giày đi bộ thoải mái',
    ]);
    expect(
      names(
        recommend({
          plan: p,
          weather: w,
          type: 'PACKING',
          thresholds: { coldMaxC: 15, uvMin: 9, walkingPerDay: 3 },
        }),
      ),
    ).toEqual([]);
  });
  it('flags an item already on the list and never bumps its quantity', () => {
    const r = recommend({
      plan: plan({ packing_items: [{ id: 'p1', name: 'ô ', quantity: '2' }] }),
      weather,
      type: 'PACKING',
    });
    expect(r.proposals.find((p) => p.packing_item?.name === 'Ô')).toMatchObject({
      warnings: ['ALREADY_IN_PLAN'],
      packing_item: { quantity: '1' },
    });
  });
  it('never overrides a dress code written by hand for that activity', () => {
    const r = recommend({
      plan: plan({
        dress_codes: [
          {
            id: 'd1',
            activity_id: 'a2',
            label: 'Áo dài',
            source: TripV1.EntitySource.ENTITY_SOURCE_MANUAL,
          },
        ],
      }),
      weather,
      type: 'DRESS_CODE',
    });
    expect(names(r)).toEqual(['Đồ đi biển']);
  });
  it('still runs activity rules when weather is missing, and says so', () => {
    const r = recommend({ plan: plan(), weather: new Map(), type: 'ALL' });
    expect(r.warnings).toEqual(['WEATHER_UNAVAILABLE']);
    expect(names(r)).toEqual(['Đồ bơi', 'Đồ đi biển', 'Trang phục kín đáo']);
  });
  it('respects the scope and proposes nothing outside the input', () => {
    const r = recommend({ plan: plan(), weather, type: 'ALL', scope: { activity_ids: ['a2'] } });
    expect(names(r)).toEqual(['Ô', 'Áo mưa', 'Trang phục kín đáo']);
    expect(
      recommend({ plan: plan(), weather, type: 'ALL', scope: { date: '2026-10-13' } }).proposals,
    ).toEqual([]);
  });
  it('gives stable ids so a preview and its apply name the same item', () =>
    expect(recommend({ plan: plan(), weather, type: 'ALL' }).proposals.map((p) => p.id)).toEqual(
      recommend({ plan: plan(), weather, type: 'ALL' }).proposals.map((p) => p.id),
    ));
  it('places an activity with only a scheduled date on that day', () => {
    const p = plan({
      activities: [
        {
          id: 'b',
          title: 'Bãi Sao',
          activity_type: 'BEACH',
          scheduled_date: '2026-10-13',
          position: 0,
        },
      ],
    });
    expect(recommend({ plan: p, weather, type: 'DRESS_CODE' }).proposals[0]).toMatchObject({
      date: '2026-10-13',
    });
    expect(
      recommend({ plan: p, weather, type: 'ALL', scope: { date: '2026-10-12' } }).proposals.map(
        (x) => x.packing_item?.name,
      ),
    ).toEqual(['Ô', 'Áo mưa']);
  });
  it('normalizes Vietnamese names', () => expect(itemKey('  Áo  MƯA ')).toBe('ao mua'));
});
