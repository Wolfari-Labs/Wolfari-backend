import type { DatabaseProvider } from '@wolfari/database';
import { createHash } from 'node:crypto';
import { fail } from './trip.errors';

export { fail, TripError } from './trip.errors';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
export const MAX_INT32 = 2_147_483_647;

export type OperationRow = {
  operation_id: string;
  trip_id: string;
  operation_type: string;
  actor_user_id: string | null;
  request_hash: string;
  state: string;
  outcome: unknown;
};

export type QueryClient = Parameters<Parameters<DatabaseProvider['withTransaction']>[0]>[0];

export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) return fail('VALIDATION_FAILED', 400);
  return value.toLowerCase();
}

export function positiveRevision(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > MAX_INT32) {
    return fail('VALIDATION_FAILED', 400);
  }
  return Number(value);
}

export function nullableText(value: unknown): string | null {
  if (value !== null && typeof value !== 'string') return fail('VALIDATION_FAILED', 400);
  return value;
}

export function instant(value: unknown): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return fail('VALIDATION_FAILED', 400);
    return new Date(value.getTime());
  }
  if (typeof value !== 'string') return fail('VALIDATION_FAILED', 400);
  const match = RFC3339.exec(value);
  if (!match) return fail('VALIDATION_FAILED', 400);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return fail('VALIDATION_FAILED', 400);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fail('VALIDATION_FAILED', 400);
  return parsed;
}

export function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('Invalid database timestamp');
  return parsed.toISOString();
}

export function digest(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export async function receiptById(
  client: QueryClient,
  operationId: string,
): Promise<OperationRow | undefined> {
  const result = await client.query<OperationRow>(
    `SELECT operation_id,trip_id,operation_type,actor_user_id,request_hash,state,outcome
     FROM trip_operations WHERE operation_id=$1`,
    [operationId],
  );
  return result.rows[0];
}

export async function lockOperation(client: QueryClient, operationId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [operationId]);
}

export async function insertReceipt(
  client: QueryClient,
  values: {
    operationId: string;
    tripId: string;
    operationType: string;
    actorUserId: string;
    requestHash: string;
    contextRevision: number;
    outcome: unknown;
    commandPayload: unknown;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO trip_operations(
       operation_id,trip_id,operation_type,actor_user_id,request_hash,state,context_revision,outcome,
       started_at,completed_at,command_payload
     ) VALUES($1,$2,$3,$4,$5,'SUCCEEDED',$6,$7::jsonb,now(),now(),$8::jsonb)`,
    [
      values.operationId,
      values.tripId,
      values.operationType,
      values.actorUserId,
      values.requestHash,
      values.contextRevision,
      JSON.stringify(values.outcome),
      JSON.stringify(values.commandPayload),
    ],
  );
}

export function verifyReceipt(
  receipt: OperationRow,
  input: {
    operationType: string;
    actorUserId: string;
    requestHash: string;
    tripId?: string;
  },
): unknown {
  if (
    receipt.operation_type !== input.operationType ||
    receipt.actor_user_id !== input.actorUserId ||
    receipt.request_hash !== input.requestHash ||
    (input.tripId !== undefined && receipt.trip_id !== input.tripId)
  ) {
    return fail('IDEMPOTENCY_CONFLICT', 409);
  }

  if (receipt.state !== 'SUCCEEDED') {
    return fail('STATE_CONFLICT', 409);
  }

  return typeof receipt.outcome === 'string' ? JSON.parse(receipt.outcome) : receipt.outcome;
}
