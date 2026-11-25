import { createHash } from 'node:crypto';
import { TripV1 } from '@wolfari/contracts/grpc';
import type { DailyWeather } from '../weather.service';

/**
 * FR-DS03 packing and dress-code rules. A pure function of the Plan and the daily weather:
 * no network, no database. Every proposal names its rules and a reason a person can read.
 * Bump RULE_VERSION whenever a rule or a default threshold changes; Trip stores it per receipt.
 */
export const RULE_VERSION = 'dss-2026.11.1';
/** Fixed by the SRS (FR-DS03): rain probability of 50% or more suggests rain gear. */
export const RAIN_THRESHOLD = 0.5;
export type Thresholds = { coldMaxC: number; uvMin: number; walkingPerDay: number };
/** Approved defaults; Admin may override them through provider_configs (module DSS). */
export const DEFAULT_THRESHOLDS: Thresholds = Object.freeze({
  coldMaxC: 18,
  uvMin: 6,
  walkingPerDay: 2,
});
export type RecommendationType = 'PACKING' | 'DRESS_CODE' | 'ALL';

export type Proposal = {
  id: string;
  kind: 'PACKING' | 'DRESS_CODE';
  packing_item?: { name: string; quantity: string; unit?: string; category: string };
  dress_code?: {
    scope_type: TripV1.DressScope;
    label: string;
    description: string;
    activity_id?: string;
  };
  /** The day the proposal is about, for display; an ACTIVITY dress code itself carries no date. */
  date?: string;
  reasons: string[];
  rule_ids: string[];
  warnings: string[];
};
export type RuleInput = {
  plan: TripV1.PlanSnapshot;
  weather: ReadonlyMap<string, DailyWeather>;
  type: RecommendationType;
  scope?: { date?: string; activity_ids?: readonly string[] };
  thresholds?: Partial<Thresholds>;
};

const WALKING = new Set(['WALKING', 'SIGHTSEEING']);
const MODEST = new Set(['TEMPLE', 'CHURCH']);

/** Vietnamese-insensitive key: "Áo mưa" and "ao  mua" are the same item. */
export function itemKey(name: string) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** The local calendar day of a timestamp in the Trip's time zone. */
export function localDate(ts: { seconds?: string | number } | undefined, timezone: string) {
  if (!ts?.seconds) return undefined;
  const d = new Date(Number(ts.seconds) * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** "2026-10-12" → "12/10". */
const dm = (date: string) => `${Number(date.slice(8, 10))}/${Number(date.slice(5, 7))}`;
const pct = (p: number) => `${Math.round(p * 100)}%`;
const stableId = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 24);

/** Each date the Trip covers, half-open [start_at, end_at) in its own time zone. */
export function tripDates(plan: TripV1.PlanSnapshot): string[] {
  const tz = plan.timezone || 'Asia/Ho_Chi_Minh';
  const first = localDate(plan.start_at, tz);
  const endTs = plan.end_at?.seconds ? Number(plan.end_at.seconds) - 1 : undefined;
  const last = endTs === undefined ? first : localDate({ seconds: endTs }, tz);
  if (!first || !last) return [];
  const out: string[] = [];
  for (
    let t = Date.parse(`${first}T12:00:00Z`);
    t <= Date.parse(`${last}T12:00:00Z`) && out.length < 366;
    t += 86400000
  )
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export function recommend(input: RuleInput): { proposals: Proposal[]; warnings: string[] } {
  const { plan, weather, type } = input;
  const t: Thresholds = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
  const tz = plan.timezone || 'Asia/Ho_Chi_Minh';
  const onlyDate = input.scope?.date;
  const onlyActivities = input.scope?.activity_ids?.length
    ? new Set(input.scope.activity_ids)
    : undefined;
  const dates = tripDates(plan).filter((d) => !onlyDate || d === onlyDate);
  const activities = (plan.activities ?? [])
    .map((a) => ({ a, date: localDate(a.starts_at, tz) ?? a.scheduled_date }))
    .filter(
      ({ a, date }) =>
        (!onlyActivities || onlyActivities.has(a.id ?? '')) && (!onlyDate || date === onlyDate),
    );
  const warnings: string[] = [];
  const missing = dates.filter((d) => !weather.has(d));
  if (missing.length) warnings.push('WEATHER_UNAVAILABLE');

  const packing = new Map<string, Proposal>();
  const addItem = (name: string, category: string, rule: string, reason: string, unit?: string) => {
    const key = itemKey(name);
    const found = packing.get(key);
    if (found) {
      if (!found.rule_ids.includes(rule)) found.rule_ids.push(rule);
      if (!found.reasons.includes(reason)) found.reasons.push(reason);
      return;
    }
    packing.set(key, {
      id: stableId(`packing:${key}`),
      kind: 'PACKING',
      packing_item: { name, quantity: '1', category, ...(unit ? { unit } : {}) },
      reasons: [reason],
      rule_ids: [rule],
      warnings: [],
    });
  };

  // Weather rules, one reason per day that triggers them (the first three days are named).
  for (const date of dates) {
    const w = weather.get(date);
    if (!w) continue;
    if (w.rain_probability >= RAIN_THRESHOLD) {
      const reason = `Ngày ${dm(date)} khả năng mưa ${pct(w.rain_probability)}`;
      addItem('Ô', 'Khác', 'PK-RAIN', reason, 'cái');
      addItem('Áo mưa', 'Quần áo', 'PK-RAIN', reason, 'cái');
    }
    if (w.temperature_min_c <= t.coldMaxC)
      addItem(
        'Áo ấm',
        'Quần áo',
        'PK-COLD',
        `Ngày ${dm(date)} thấp nhất ${Math.round(w.temperature_min_c)}°C`,
        'cái',
      );
    if (w.uv_index !== undefined && w.uv_index >= t.uvMin)
      addItem(
        'Kem chống nắng',
        'Vệ sinh',
        'PK-UV',
        `UV ngày ${dm(date)} là ${Math.round(w.uv_index)}`,
        'chai',
      );
  }
  // Activity rules.
  for (const { a } of activities.filter(({ a }) => a.activity_type === 'BEACH'))
    addItem('Đồ bơi', 'Quần áo', 'PK-BEACH', `Có hoạt động đi biển: ${a.title}`, 'bộ');
  const walkingByDay = new Map<string, number>();
  for (const { a, date } of activities)
    if (date && WALKING.has(a.activity_type ?? ''))
      walkingByDay.set(date, (walkingByDay.get(date) ?? 0) + 1);
  for (const [date, count] of [...walkingByDay].sort())
    if (count >= t.walkingPerDay)
      addItem(
        'Giày đi bộ thoải mái',
        'Quần áo',
        'PK-WALK',
        `Ngày ${dm(date)} có ${count} điểm đi bộ, tham quan`,
        'đôi',
      );

  // Items already on the list are still shown, flagged, and never bump a quantity.
  const existing = new Set((plan.packing_items ?? []).map((p) => itemKey(p.name ?? '')));
  for (const [key, p] of packing) if (existing.has(key)) p.warnings.push('ALREADY_IN_PLAN');

  const dress: Proposal[] = [];
  const codes = plan.dress_codes ?? [];
  const addDress = (
    activity: TripV1.Activity,
    date: string | undefined,
    rule: string,
    label: string,
    description: string,
    reason: string,
  ) => {
    const mine = codes.filter((c) => c.activity_id === activity.id);
    // A dress code someone wrote by hand for this activity is never overwritten by a rule.
    if (mine.some((c) => c.source === TripV1.EntitySource.ENTITY_SOURCE_MANUAL)) return;
    const key = `dress:${activity.id}:${itemKey(label)}`;
    const found = dress.find((d) => d.id === stableId(key));
    if (found) {
      if (!found.rule_ids.includes(rule)) found.rule_ids.push(rule);
      found.reasons.push(reason);
      return;
    }
    dress.push({
      id: stableId(key),
      kind: 'DRESS_CODE',
      dress_code: {
        scope_type: TripV1.DressScope.DRESS_SCOPE_ACTIVITY,
        label,
        description,
        activity_id: activity.id,
      },
      ...(date ? { date } : {}),
      reasons: [reason],
      rule_ids: [rule],
      warnings: mine.some((c) => itemKey(c.label ?? '') === itemKey(label))
        ? ['ALREADY_IN_PLAN']
        : [],
    });
  };
  for (const { a, date } of activities) {
    if (MODEST.has(a.activity_type ?? ''))
      addDress(
        a,
        date,
        'DC-MODEST',
        'Trang phục kín đáo',
        'Áo có tay, quần hoặc váy dài qua gối; tránh đồ hở vai.',
        `${a.title} là nơi tôn nghiêm`,
      );
    if (a.activity_type === 'BEACH')
      addDress(
        a,
        date,
        'DC-BEACH',
        'Đồ đi biển',
        'Đồ bơi, áo khoác mỏng, dép và khăn tắm.',
        `${a.title} là hoạt động ở biển`,
      );
    const w = date ? weather.get(date) : undefined;
    if (a.activity_type === 'OUTDOOR' && w?.uv_index !== undefined && w.uv_index >= t.uvMin)
      addDress(
        a,
        date,
        'DC-SUN',
        'Chống nắng',
        'Mũ rộng vành, kính râm, áo chống nắng.',
        `${a.title} ngoài trời lúc UV ${Math.round(w.uv_index)}`,
      );
  }

  const proposals = [
    ...(type === 'DRESS_CODE' ? [] : [...packing.values()]),
    ...(type === 'PACKING' ? [] : dress),
  ].map((p) => ({
    ...p,
    reasons: p.reasons
      .slice(0, 3)
      .concat(p.reasons.length > 3 ? [`và ${p.reasons.length - 3} ngày khác`] : []),
  }));
  return { proposals, warnings };
}
