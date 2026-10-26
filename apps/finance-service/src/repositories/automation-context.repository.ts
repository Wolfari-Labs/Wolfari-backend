import { Inject, Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import { FinanceReadError, UUID } from '../finance.errors';

export type AutomationSourceType =
  'CONTRIBUTION_REQUEST' | 'CONTRIBUTION_DUE' | 'CONTRIBUTION_REVIEW' | 'CLOSURE';
export interface AutomationCandidate {
  userId: string;
  /** Source time in epoch microseconds; null means the current Holder has no historical cutoff. */
  cutoffMicros: string | null;
}
export interface AutomationContextSnapshot {
  fundId: string;
  tripId: string;
  financeVersion: number;
  fundStatus: 'OPEN' | 'CLOSING' | 'CLOSED';
  sourceType: AutomationSourceType;
  sourceId: string;
  sourceStatus: string;
  sourceVersion: number;
  requestStatus: string | null;
  requestVersion: number | null;
  dueAt: string | null;
  eligible: boolean;
  candidates: AutomationCandidate[];
}
type SnapshotRow = {
  fund_id: string;
  trip_id: string;
  finance_version: number;
  fund_status: AutomationContextSnapshot['fundStatus'];
  source_id: string;
  source_status: string;
  source_version: number;
  request_status: string | null;
  request_version: number | null;
  due_at: Date | string | null;
  source_consistent: boolean;
  candidates: Array<{ user_id: string; cutoff_micros: string | null }>;
};
const fundColumns = 'f.id AS fund_id,f.trip_id,f.finance_version,f.status AS fund_status';
const requestSql = `SELECT ${fundColumns},
  r.id AS source_id,r.status AS source_status,r.version AS source_version,
  r.status AS request_status,r.version AS request_version,r.due_at,true AS source_consistent,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'user_id',c.member_user_id,'cutoff_micros',
    (EXTRACT(EPOCH FROM c.created_at)*1000000)::bigint::text) ORDER BY c.member_user_id)
    FROM contributions c WHERE c.request_id=r.id AND c.fund_id=f.id AND c.status='PENDING'),
    '[]'::jsonb) AS candidates
  FROM funds f JOIN contribution_requests r ON r.fund_id=f.id
  WHERE f.id=$1 AND r.id=$2`;
function contributionSql(review: boolean): string {
  return `SELECT ${fundColumns},
    c.id AS source_id,c.status AS source_status,c.version AS source_version,
    r.status AS request_status,r.version AS request_version,r.due_at,true AS source_consistent,
    jsonb_build_array(jsonb_build_object('user_id',${review ? 'f.holder_user_id' : 'c.member_user_id'},
      'cutoff_micros',${review ? 'NULL::text' : '(EXTRACT(EPOCH FROM c.created_at)*1000000)::bigint::text'})) AS candidates
    FROM funds f JOIN contributions c ON c.fund_id=f.id
    JOIN contribution_requests r ON r.id=c.request_id AND r.fund_id=f.id
    WHERE f.id=$1 AND c.id=$2`;
}
const closureSql = `SELECT ${fundColumns},
  c.id AS source_id,c.status AS source_status,c.snapshot_finance_version AS source_version,
  NULL::text AS request_status,NULL::integer AS request_version,NULL::timestamptz AS due_at,
  NOT EXISTS(SELECT 1 FROM closure_confirmations x
    WHERE x.closure_id=c.id AND x.snapshot_hash<>c.snapshot_hash) AS source_consistent,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id',x.user_id,'cutoff_micros',
    (EXTRACT(EPOCH FROM c.requested_at)*1000000)::bigint::text) ORDER BY x.user_id)
    FROM closure_confirmations x WHERE x.closure_id=c.id AND x.confirmed_at IS NULL),
    '[]'::jsonb) AS candidates
  FROM funds f JOIN finance_closures c ON c.fund_id=f.id
  WHERE f.id=$1 AND c.id=$2`;
const queries: Record<AutomationSourceType, string> = {
  CONTRIBUTION_REQUEST: requestSql,
  CONTRIBUTION_DUE: contributionSql(false),
  CONTRIBUTION_REVIEW: contributionSql(true),
  CLOSURE: closureSql,
};
function unavailable(): never {
  throw new FinanceReadError('SERVICE_UNAVAILABLE');
}
function storedUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) return unavailable();
  return value.toLowerCase();
}
function version(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 2147483647;
}
function project(row: SnapshotRow, type: AutomationSourceType): AutomationContextSnapshot {
  if (
    !['OPEN', 'CLOSING', 'CLOSED'].includes(row.fund_status) ||
    !version(row.finance_version) ||
    !version(row.source_version) ||
    row.source_consistent !== true ||
    !Array.isArray(row.candidates)
  )
    return unavailable();
  const closure = type === 'CLOSURE';
  const request = type === 'CONTRIBUTION_REQUEST';
  const statuses = closure
    ? ['PENDING_CONFIRMATIONS', 'CANCELLED', 'COMPLETED']
    : request
      ? ['OPEN', 'CLOSED', 'CANCELLED']
      : ['PENDING', 'TRANSFER_REPORTED', 'CONFIRMED', 'WAIVED', 'CANCELLED', 'REVERSED'];
  if (
    !statuses.includes(row.source_status) ||
    (closure
      ? row.request_status !== null || row.request_version !== null || row.due_at !== null
      : !['OPEN', 'CLOSED', 'CANCELLED'].includes(row.request_status ?? '') ||
        !version(row.request_version))
  )
    return unavailable();
  const due = row.due_at === null ? null : new Date(row.due_at);
  if (due && !Number.isFinite(due.getTime())) return unavailable();
  const eligible = closure
    ? row.fund_status === 'CLOSING' && row.source_status === 'PENDING_CONFIRMATIONS'
    : row.fund_status === 'OPEN' &&
      row.request_status === 'OPEN' &&
      (request ||
        row.source_status === (type === 'CONTRIBUTION_REVIEW' ? 'TRANSFER_REPORTED' : 'PENDING'));
  const candidates = row.candidates
    .map((candidate) => {
      if (!candidate || typeof candidate !== 'object') return unavailable();
      const cutoff = candidate.cutoff_micros;
      if (
        type === 'CONTRIBUTION_REVIEW'
          ? cutoff !== null
          : typeof cutoff !== 'string' || !/^-?\d{1,20}$/.test(cutoff)
      )
        return unavailable();
      return { userId: storedUuid(candidate.user_id), cutoffMicros: cutoff };
    })
    .sort((left, right) => left.userId.localeCompare(right.userId));
  if (new Set(candidates.map((item) => item.userId)).size !== candidates.length)
    return unavailable();
  return {
    fundId: storedUuid(row.fund_id),
    tripId: storedUuid(row.trip_id),
    financeVersion: row.finance_version,
    fundStatus: row.fund_status,
    sourceType: type,
    sourceId: storedUuid(row.source_id),
    sourceStatus: row.source_status,
    sourceVersion: row.source_version,
    requestStatus: row.request_status,
    requestVersion: row.request_version,
    dueAt: due?.toISOString() ?? null,
    eligible,
    candidates: eligible ? candidates : [],
  };
}

@Injectable()
export class FinanceAutomationContextRepository {
  constructor(
    @Inject(DatabaseProvider) private readonly database: Pick<DatabaseProvider, 'withTransaction'>,
  ) {}

  async find(
    fundId: string,
    sourceType: AutomationSourceType,
    sourceId: string,
    deadline: number,
  ): Promise<AutomationContextSnapshot | null> {
    return this.database.withTransaction(async (client) => {
      if (!Number.isFinite(deadline) || Date.now() >= deadline) return unavailable();
      await client.query('SET TRANSACTION READ ONLY');
      const remaining = Math.floor(deadline - Date.now());
      if (remaining <= 0) return unavailable();
      await client.query("SELECT set_config('statement_timeout',$1,true)", [
        String(Math.min(remaining, 2147483647)),
      ]);
      if (Date.now() >= deadline) return unavailable();
      const result = await client.query<SnapshotRow>(queries[sourceType], [fundId, sourceId]);
      if (Date.now() >= deadline || result.rows.length > 1) return unavailable();
      const row = result.rows[0];
      if (!row) return null;
      const snapshot = project(row, sourceType);
      if (snapshot.fundId !== fundId || snapshot.sourceId !== sourceId) return unavailable();
      return snapshot;
    });
  }
}
