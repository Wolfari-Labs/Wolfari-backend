import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import { TravelV1, TripV1 } from '@wolfari/contracts/grpc';
import { createHash } from 'node:crypto';
import {
  DEFAULT_THRESHOLDS,
  localDate,
  recommend,
  RULE_VERSION,
  tripDates,
  type Proposal,
  type RecommendationType,
  type Thresholds,
} from './dss/rules';
import {
  inForecastRange,
  normalizePoint,
  WeatherService,
  type DailyWeather,
  type WeatherLookup,
} from './weather.service';

const TYPES: readonly RecommendationType[] = ['PACKING', 'DRESS_CODE', 'ALL'];
const MAX_ACTIVITIES = 500;
const MAX_POINTS = 8; // a long multi-city trip still costs at most 8 forecast lookups

/** Admin-tunable thresholds (provider_configs, provider/module DSS); bad values fall back. */
export function thresholdsFrom(config: unknown): Thresholds {
  const c = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>;
  const pick = (key: keyof Thresholds, lo: number, hi: number) => {
    const v = c[key];
    return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
      ? v
      : DEFAULT_THRESHOLDS[key];
  };
  return {
    coldMaxC: pick('coldMaxC', -20, 35),
    uvMin: pick('uvMin', 1, 15),
    walkingPerDay: pick('walkingPerDay', 1, 20),
  };
}

/**
 * The point whose forecast stands for each day: the first stop that day with coordinates,
 * else the trip's first selected location. Days without any point have no weather.
 */
export function dayPoints(plan: TripV1.PlanSnapshot) {
  const tz = plan.timezone || 'Asia/Ho_Chi_Minh';
  const located = new Map(
    (plan.selected_locations ?? [])
      .filter((l) => l.id && l.coordinates)
      .map((l) => [l.id!, l.coordinates!] as const),
  );
  const fallback = [...located.values()][0];
  const ordered = [...(plan.activities ?? [])].sort(
    (a, b) =>
      Number(a.starts_at?.seconds ?? 0) - Number(b.starts_at?.seconds ?? 0) ||
      (a.position ?? 0) - (b.position ?? 0),
  );
  const out = new Map<string, { latitude: number; longitude: number }>();
  for (const date of tripDates(plan)) {
    const first = ordered.find(
      (a) =>
        (localDate(a.starts_at, tz) ?? a.scheduled_date) === date &&
        a.selected_location_id &&
        located.has(a.selected_location_id),
    );
    const c = first ? located.get(first.selected_location_id!) : fallback;
    if (!c) continue;
    try {
      out.set(date, normalizePoint(c));
    } catch {
      /* outside Vietnam: no forecast for that day */
    }
  }
  return out;
}

function toProto(p: Proposal): TravelV1.ProposalItem {
  return {
    id: p.id,
    ...(p.packing_item
      ? {
          packing_item: {
            id: '',
            ...p.packing_item,
            source: TripV1.EntitySource.ENTITY_SOURCE_DSS,
          },
        }
      : {}),
    ...(p.dress_code
      ? {
          dress_code: {
            id: '',
            ...p.dress_code,
            ...(p.date ? { plan_date: p.date } : {}),
            source: TripV1.EntitySource.ENTITY_SOURCE_DSS,
          },
        }
      : {}),
    reason: p.reasons.join('\n'),
    rule_ids: p.rule_ids,
    warnings: p.warnings,
  };
}

@Injectable()
export class RecommendationService {
  constructor(
    private readonly database: DatabaseProvider,
    private readonly weather: WeatherService,
  ) {}

  private async thresholds(): Promise<Thresholds> {
    const row = (
      await this.database.query<{ enabled: boolean; config: unknown }>(
        "SELECT enabled,config FROM provider_configs WHERE provider='DSS' AND module='DSS'",
      )
    ).rows[0];
    return thresholdsFrom(row?.enabled === false ? {} : row?.config);
  }

  async recommend(
    request: TravelV1.GetRecommendationRequest,
    now = new Date(),
  ): Promise<TravelV1.GetRecommendationResponse> {
    const plan = request.plan;
    const type = request.type as RecommendationType;
    if (!plan?.trip_id || !TYPES.includes(type) || (plan.activities?.length ?? 0) > MAX_ACTIVITIES)
      throw new Error('VALIDATION_FAILED');
    const scope = {
      ...(request.scope?.date ? { date: request.scope.date } : {}),
      activity_ids: request.scope?.activity_ids ?? [],
    };
    const thresholds = await this.thresholds();

    // One forecast per distinct point, only for days the provider covers.
    const points = dayPoints(plan);
    const wanted = [...points].filter(
      ([date]) => (!scope.date || date === scope.date) && inForecastRange(date, now),
    );
    const byPoint = new Map<
      string,
      { point: { latitude: number; longitude: number }; dates: string[] }
    >();
    for (const [date, point] of wanted) {
      const key = `${point.latitude},${point.longitude}`;
      const entry = byPoint.get(key) ?? { point, dates: [] };
      entry.dates.push(date);
      byPoint.set(key, entry);
    }
    const weather = new Map<string, DailyWeather>();
    const lookups: WeatherLookup[] = [];
    for (const { point, dates } of [...byPoint.values()].slice(0, MAX_POINTS)) {
      const found = await this.weather.lookup(point, now);
      lookups.push(found);
      for (const date of dates) {
        const day = found.days.get(date);
        if (day) weather.set(date, day);
      }
    }

    const result = recommend({ plan, weather, type, scope, thresholds });
    const warnings = [...result.warnings];
    // Days past the 16-day window get no weather rules; say so rather than guess.
    if (tripDates(plan).some((d) => !inForecastRange(d, now)))
      warnings.push('FORECAST_OUT_OF_RANGE');
    const input_hash = createHash('sha256')
      .update(
        JSON.stringify({
          rule: RULE_VERSION,
          plan_version: plan.plan_version,
          type,
          scope,
          thresholds,
          weather: [...weather.values()].sort((a, b) => a.date.localeCompare(b.date)),
        }),
      )
      .digest('hex');
    return {
      proposal: result.proposals.map(toProto),
      rule_version: RULE_VERSION,
      input_hash,
      warnings,
      provider_sources: lookups.map((l) =>
        this.weather.meta(
          l,
          l.days.size
            ? TravelV1.ProviderStatus.PROVIDER_STATUS_SUCCESS
            : TravelV1.ProviderStatus.PROVIDER_STATUS_ERROR,
        ),
      ),
    };
  }
}
