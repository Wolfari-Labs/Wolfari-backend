import { randomUUID } from 'node:crypto';
import { parseEventForPublish } from '@wolfari/contracts/events';
import type { QueryClient } from '../trip-common';

export type PlanChange = {
  type: 'ACTIVITY' | 'DRESS_CODE';
  id: string;
  action: 'UPSERT' | 'DELETE';
};
export async function insertPlanUpdated(
  client: QueryClient,
  input: {
    tripId: string;
    actorUserId: string;
    operationId: string;
    correlationId: string;
    planVersion: number;
    changes: PlanChange[];
  },
): Promise<void> {
  const envelope = parseEventForPublish({
    event_id: randomUUID(),
    event_type: 'PlanUpdated',
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    producer: 'Trip',
    aggregate_type: 'Plan',
    aggregate_id: input.tripId,
    aggregate_version: input.planVersion,
    correlation_id: input.correlationId,
    causation_id: null,
    operation_id: input.operationId,
    trip_id: input.tripId,
    actor_user_id: input.actorUserId,
    system_actor: null,
    payload: {
      trip_id: input.tripId,
      plan_version: input.planVersion,
      source_version: input.planVersion,
      changed_entities: input.changes,
      tombstones: input.changes
        .filter((change) => change.action === 'DELETE')
        .map(({ type, id }) => ({ type, id, source_version: input.planVersion })),
    },
  });
  await client.query(
    `INSERT INTO outbox_events(event_id,event_type,schema_version,aggregate_id,
    aggregate_version,correlation_id,payload,aggregate_type,producer,occurred_at,
    operation_id,trip_id,actor_user_id,system_actor,causation_id)
    VALUES($1,$2,1,$3,$4,$5,$6::jsonb,'Plan','Trip',$7,$8,$3,$9,NULL,NULL)`,
    [
      envelope.event_id,
      envelope.event_type,
      input.tripId,
      input.planVersion,
      input.correlationId,
      JSON.stringify(envelope.payload),
      envelope.occurred_at,
      input.operationId,
      input.actorUserId,
    ],
  );
}
