/* Generated from schemas/events-v1.schema.json. Do not edit by hand. */

export type WolfariEventV1 = (
  | {
      actor_user_id?: Uuid;
      system_actor?: null;
      [k: string]: unknown;
    }
  | {
      actor_user_id?: null;
      system_actor?: string;
      [k: string]: unknown;
    }
) &
  (
    | {
        event_type?: 'AccountStatusChanged';
        producer?: 'Identity';
        aggregate_type?: 'User';
        payload?: AccountStatusChanged;
        [k: string]: unknown;
      }
    | {
        event_type?: 'MemberInvited';
        producer?: 'Trip';
        aggregate_type?: 'Invitation';
        payload?: MemberInvited;
        [k: string]: unknown;
      }
    | {
        event_type?: 'PlanUpdated';
        producer?: 'Trip';
        aggregate_type?: 'Plan';
        payload?: PlanUpdated;
        [k: string]: unknown;
      }
    | {
        event_type?: 'MemberLeft';
        producer?: 'Trip';
        aggregate_type?: 'Membership';
        payload?: MembershipChanged;
        [k: string]: unknown;
      }
    | {
        event_type?: 'MemberRemoved';
        producer?: 'Trip';
        aggregate_type?: 'Membership';
        payload?: MembershipChanged;
        [k: string]: unknown;
      }
    | {
        event_type?: 'TripArchived';
        producer?: 'Trip';
        aggregate_type?: 'Trip';
        payload?: TripRevision;
        [k: string]: unknown;
      }
    | {
        event_type?: 'TripDeleted';
        producer?: 'Trip';
        aggregate_type?: 'Trip';
        payload?: TripDeleted;
        [k: string]: unknown;
      }
    | {
        event_type?: 'TripReopened';
        producer?: 'Trip';
        aggregate_type?: 'Trip';
        payload?: TripRevision;
        [k: string]: unknown;
      }
    | {
        event_type?: 'ContributionRequested';
        producer?: 'Finance';
        aggregate_type?: 'Fund';
        payload?: ContributionRequested;
        [k: string]: unknown;
      }
    | {
        event_type?: 'ContributionUpdated';
        producer?: 'Finance';
        aggregate_type?: 'Fund';
        payload?: ContributionUpdated;
        [k: string]: unknown;
      }
    | {
        event_type?: 'ClosureRequested';
        producer?: 'Finance';
        aggregate_type?: 'Fund';
        payload?: ClosureRequested;
        [k: string]: unknown;
      }
    | {
        event_type?: 'ClosureCancelled';
        producer?: 'Finance';
        aggregate_type?: 'Fund';
        payload?: ClosureState;
        [k: string]: unknown;
      }
    | {
        event_type?: 'FinanceClosed';
        producer?: 'Finance';
        aggregate_type?: 'Fund';
        payload?: ClosureState;
        [k: string]: unknown;
      }
    | {
        event_type?: 'GenerateExport';
        producer?: 'Trip';
        aggregate_type?: 'ExportJob';
        payload?: GenerateExport;
        [k: string]: unknown;
      }
    | {
        event_type?: 'ExportStarted';
        producer?: 'ExportWorker';
        aggregate_type?: 'ExportJob';
        payload?: ExportStarted;
        [k: string]: unknown;
      }
    | {
        event_type?: 'ExportCompleted';
        producer?: 'ExportWorker';
        aggregate_type?: 'ExportJob';
        payload?: ExportCompleted;
        [k: string]: unknown;
      }
    | {
        event_type?: 'ExportFailed';
        producer?: 'ExportWorker';
        aggregate_type?: 'ExportJob';
        payload?: ExportFailed;
        [k: string]: unknown;
      }
    | {
        event_type?: 'MemberJoined';
        producer?: 'Trip';
        aggregate_type?: 'Membership';
        payload?: MembershipChanged;
        [k: string]: unknown;
      }
    | {
        event_type?: 'AccountEmailRequested';
        producer?: 'Identity';
        aggregate_type?: 'User';
        payload?: AccountEmailRequested;
        [k: string]: unknown;
      }
  ) & {
    event_id: Uuid;
    event_type: string;
    schema_version: 1;
    occurred_at: Instant;
    producer: 'Identity' | 'Trip' | 'Finance' | 'ExportWorker';
    aggregate_type: string;
    aggregate_id: Uuid;
    aggregate_version: PositiveInt;
    correlation_id: Uuid;
    causation_id: Uuid | null;
    operation_id: Uuid | null;
    trip_id: Uuid | null;
    actor_user_id: Uuid | null;
    system_actor: string | null;
    payload: {
      [k: string]: unknown;
    };
  };
export type Uuid = string;
export type PositiveInt = number;
export type Instant = string;
export type Sha256 = string;
export type NonNegativeInt = number;

export interface AccountStatusChanged {
  user_id: Uuid;
  status: 'ACTIVE' | 'LOCKED' | 'DELETION_PENDING' | 'ANONYMIZED';
  user_version: PositiveInt;
}
export interface MemberInvited {
  invitation_id: Uuid;
  trip_id: Uuid;
  invitation_version: PositiveInt;
}
export interface PlanUpdated {
  trip_id: Uuid;
  plan_version: PositiveInt;
  changed_entities: ChangedEntity[];
  source_version: PositiveInt;
  tombstones: Tombstone[];
}
export interface ChangedEntity {
  type: string;
  id: Uuid;
  action: 'UPSERT' | 'DELETE';
}
export interface Tombstone {
  type: string;
  id: Uuid;
  source_version: PositiveInt;
}
export interface MembershipChanged {
  trip_id: Uuid;
  user_id: Uuid;
  membership_revision: PositiveInt;
}
export interface TripRevision {
  trip_id: Uuid;
  export_revision: PositiveInt;
}
export interface TripDeleted {
  trip_id: Uuid;
  export_revision: PositiveInt;
  deleted_at: Instant;
}
export interface ContributionRequested {
  fund_id: Uuid;
  trip_id: Uuid;
  request_id: Uuid;
  /**
   * @minItems 1
   */
  contribution_ids: [Uuid, ...Uuid[]];
  finance_version: PositiveInt;
}
export interface ContributionUpdated {
  fund_id: Uuid;
  trip_id: Uuid;
  contribution_id: Uuid;
  status: 'PENDING' | 'TRANSFER_REPORTED' | 'CONFIRMED' | 'WAIVED' | 'CANCELLED';
  finance_version: PositiveInt;
}
export interface ClosureRequested {
  fund_id: Uuid;
  trip_id: Uuid;
  closure_id: Uuid;
  snapshot_hash: Sha256;
  finance_version: PositiveInt;
}
export interface ClosureState {
  fund_id: Uuid;
  trip_id: Uuid;
  closure_id: Uuid;
  finance_version: PositiveInt;
}
export interface GenerateExport {
  job_id: Uuid;
  attempt_id: Uuid;
  job_version: PositiveInt;
  snapshot_key: string;
  snapshot_hash: Sha256;
  snapshot_schema_version: PositiveInt;
  format: 'XLSX' | 'PDF' | 'PNG';
  preset_version: PositiveInt;
  result_key: string;
}
export interface ExportStarted {
  job_id: Uuid;
  attempt_id: Uuid;
}
export interface ExportCompleted {
  job_id: Uuid;
  attempt_id: Uuid;
  result_key: string;
  sha256: Sha256;
  mime_type: string;
  size_bytes: NonNegativeInt;
  completed_at: Instant;
}
export interface ExportFailed {
  job_id: Uuid;
  attempt_id: Uuid;
  error_code: string;
  retryable: false;
}
export interface AccountEmailRequested {
  user_id: Uuid;
  token_id: Uuid;
  purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD';
}
