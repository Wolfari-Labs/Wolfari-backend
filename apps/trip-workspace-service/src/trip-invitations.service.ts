import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseProvider } from '@wolfari/database';
import { CommonV1, type TripV1, type IdentityV1 } from '@wolfari/contracts/grpc';
import { IdentityClient } from '@wolfari/contracts/identity-client';
import { parseEventForPublish } from '@wolfari/contracts/events';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { accessUuid, accessRevision, maximumRevision } from './trip-access.domain';
import { fail } from './trip.errors';
import { InvitationCrypto, invitationEmail, invitationTokenHash } from './invitation-crypto';

type InvitationRow = {
  id: string;
  trip_id: string;
  invitation_type: string;
  email: string | null;
  status: string;
  version: number;
  expires_at: Date;
  resolved_at: Date | null;
  invited_by_user_id: string;
  resolved_by_user_id: string | null;
  accepted_member_id: string | null;
  token_hash: string;
  delivery_token_ciphertext: string | null;
};
type TripRow = {
  id: string;
  name: string;
  archived_at: Date | null;
  deleted_at: Date | null;
  closure_lock_id: string | null;
  membership_revision: number;
  export_revision: number;
  plan_version: number;
};
type MemberRow = {
  id: string;
  trip_id: string;
  user_id: string;
  role: string;
  joined_at: Date;
  left_at: Date | null;
};
type Receipt = {
  actor_user_id: string;
  operation_type: string;
  request_hash: string;
  trip_id: string;
  state: string;
  outcome: unknown;
};
type Outcome =
  | TripV1.CreateInvitationResponse
  | TripV1.AcceptInvitationResponse
  | TripV1.PreviewInvitationResponse;
const expired = Symbol('expired');
const states = ['PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED'];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = (value: Date): { seconds: string; nanos: number } => ({
  seconds: String(Math.floor(value.getTime() / 1000)),
  nanos: (value.getTime() % 1000) * 1_000_000,
});
function view(row: InvitationRow): TripV1.Invitation {
  return {
    id: row.id,
    trip_id: row.trip_id,
    invitation_type: row.invitation_type,
    email: row.email?.trim().toLowerCase(),
    status: row.status,
    version: row.version,
    expires_at: stamp(row.expires_at),
    resolved_at: row.resolved_at ? stamp(row.resolved_at) : undefined,
  };
}
function requestedExpiry(value: TripV1.CreateInvitationRequest['expires_at']): Date | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value.seconds !== 'string' ||
    !/^-?\d+$/.test(value.seconds) ||
    !Number.isInteger(value.nanos) ||
    Number(value.nanos) < 0 ||
    Number(value.nanos) > 999_999_999
  )
    return fail('VALIDATION_FAILED', 400);
  const date = new Date(Number(value.seconds) * 1000 + Math.floor(Number(value.nanos) / 1_000_000));
  if (!Number.isFinite(date.getTime())) return fail('VALIDATION_FAILED', 400);
  return date;
}

@Injectable()
export class TripInvitationsService implements OnModuleInit, OnApplicationShutdown {
  private readonly identity: IdentityClient;
  private readonly crypto: InvitationCrypto;
  private readonly linkBase: string;
  private timer?: NodeJS.Timeout;
  private maintenance?: Promise<void>;
  constructor(
    private readonly db: DatabaseProvider,
    config: ConfigService,
  ) {
    this.crypto = new InvitationCrypto(config.getOrThrow<string>('TRIP_INVITATION_TOKEN_KEY'));
    const target = config.getOrThrow<string>('IDENTITY_GRPC_TARGET');
    const secret = config.getOrThrow<string>('TRIP_IDENTITY_SECRET');
    if (!/^127\.0\.0\.1:\d+$/.test(target) || secret.length < 32)
      throw new Error('Invalid Trip Identity configuration');
    this.identity = new IdentityClient(target, 'Trip', secret);
    const base = new URL(config.getOrThrow<string>('TRIP_INVITATION_LINK_BASE_URL'));
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error('Invalid invitation link base');
    this.linkBase = base.href.replace(/\/$/, '');
  }
  onModuleInit() {
    this.timer = setInterval(() => {
      if (!this.maintenance)
        this.maintenance = this.expireBatch()
          .catch(() => {})
          .finally(() => {
            this.maintenance = undefined;
          });
    }, 60_000);
    this.timer.unref();
  }
  async onApplicationShutdown() {
    clearInterval(this.timer);
    await this.maintenance;
    this.identity.close();
  }
  private link(token: string) {
    return `${this.linkBase}/invitations/local#token=${token}`;
  }
  private async lock(client: PoolClient, tripId: string, operationId?: string) {
    if (operationId)
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [operationId]);
    await client.query('SELECT id FROM trips WHERE id=$1 FOR UPDATE', [tripId]);
    await client.query('SELECT id FROM trip_members WHERE trip_id=$1 ORDER BY id FOR UPDATE', [
      tripId,
    ]);
    await client.query('SELECT id FROM invitations WHERE trip_id=$1 ORDER BY id FOR UPDATE', [
      tripId,
    ]);
    // New READ COMMITTED statement after all waits: never authorize from a stale join snapshot.
    const row = (
      await client.query<TripRow>('SELECT * FROM trips WHERE id=$1 AND deleted_at IS NULL', [
        tripId,
      ])
    ).rows[0];
    if (!row) return fail('RESOURCE_NOT_FOUND', 404);
    return row;
  }
  private async owner(client: PoolClient, tripId: string, actor: string) {
    const row = (
      await client.query<MemberRow>(
        'SELECT * FROM trip_members WHERE trip_id=$1 AND user_id=$2 AND left_at IS NULL',
        [tripId, actor],
      )
    ).rows[0];
    if (!row) return fail('RESOURCE_NOT_FOUND', 404);
    if (row.role !== 'OWNER') return fail('PERMISSION_DENIED', 403);
  }
  private async audit(
    client: PoolClient,
    row: InvitationRow,
    action: string,
    actor: string | null,
    correlation: string,
  ) {
    await client.query(
      `INSERT INTO trip_audit_logs(trip_id,actor_user_id,system_actor,action,entity_type,entity_id,from_version,to_version,correlation_id)
      VALUES($1,$2,$3,$4,'INVITATION',$5,$6,$7,$8)`,
      [
        row.trip_id,
        actor,
        actor ? null : 'Trip',
        action,
        row.id,
        row.version > 1 ? row.version - 1 : null,
        row.version,
        correlation,
      ],
    );
  }
  private async event(
    client: PoolClient,
    row: InvitationRow,
    trip: TripRow,
    actor: string,
    correlation: string,
    operation: string,
    member?: MemberRow,
  ) {
    const event = parseEventForPublish({
      event_id: randomUUID(),
      schema_version: 1,
      event_type: member ? 'MemberJoined' : 'MemberInvited',
      occurred_at: new Date().toISOString(),
      producer: 'Trip',
      aggregate_type: member ? 'Membership' : 'Invitation',
      aggregate_id: member?.id ?? row.id,
      aggregate_version: member ? trip.membership_revision : row.version,
      trip_id: trip.id,
      actor_user_id: actor,
      system_actor: null,
      correlation_id: correlation,
      causation_id: null,
      operation_id: operation,
      payload: member
        ? {
            trip_id: trip.id,
            user_id: member.user_id,
            membership_revision: trip.membership_revision,
          }
        : { invitation_id: row.id, trip_id: trip.id, invitation_version: row.version },
    });
    await client.query(
      `INSERT INTO outbox_events(event_id,event_type,schema_version,aggregate_id,aggregate_version,correlation_id,payload,aggregate_type,producer,occurred_at,actor_user_id,system_actor,trip_id,operation_id)
      VALUES($1,$2,1,$3,$4,$5,$6::jsonb,$7,'Trip',$8,$9,NULL,$10,$11)`,
      [
        event.event_id,
        event.event_type,
        event.aggregate_id,
        event.aggregate_version,
        correlation,
        JSON.stringify(event.payload),
        event.aggregate_type,
        event.occurred_at,
        actor,
        trip.id,
        operation,
      ],
    );
  }
  private async expire(client: PoolClient, tripId: string, correlation: string) {
    const rows = (
      await client.query<InvitationRow>(
        `UPDATE invitations SET status='EXPIRED',version=version+1,resolved_at=clock_timestamp(),delivery_token_ciphertext=NULL,delivery_token_expires_at=NULL
      WHERE trip_id=$1 AND status='PENDING' AND expires_at<=clock_timestamp() RETURNING *`,
        [tripId],
      )
    ).rows;
    for (const row of rows) await this.audit(client, row, 'INVITATION_EXPIRED', null, correlation);
  }
  async expireBatch() {
    const candidates = (
      await this.db.query<{ trip_id: string }>(
        `SELECT DISTINCT trip_id FROM invitations WHERE status='PENDING' AND expires_at<=clock_timestamp() ORDER BY trip_id LIMIT 100`,
      )
    ).rows;
    for (const row of candidates)
      await this.db.withTransaction(async (client) => {
        // Deleted trips still need cipher cleanup, so do not use public visibility helper.
        await client.query('SELECT id FROM trips WHERE id=$1 FOR UPDATE', [row.trip_id]);
        await client.query('SELECT id FROM invitations WHERE trip_id=$1 ORDER BY id FOR UPDATE', [
          row.trip_id,
        ]);
        await this.expire(client, row.trip_id, randomUUID());
      });
  }
  private async replay(
    client: PoolClient,
    operation: string,
    actor: string,
    command: string,
    tripId: string,
    requestHash: string,
  ): Promise<Outcome | undefined> {
    const receipt = (
      await client.query<Receipt>('SELECT * FROM trip_operations WHERE operation_id=$1', [
        operation,
      ])
    ).rows[0];
    if (!receipt) return undefined;
    if (
      receipt.actor_user_id !== actor ||
      receipt.operation_type !== command ||
      receipt.trip_id !== tripId ||
      receipt.request_hash !== requestHash
    )
      return fail('IDEMPOTENCY_CONFLICT', 409);
    if (receipt.state !== 'SUCCEEDED') return fail('STATE_CONFLICT', 409);
    return receipt.outcome as Outcome;
  }
  private async receipt(
    client: PoolClient,
    operation: string,
    actor: string,
    command: string,
    trip: TripRow,
    requestHash: string,
    outcome: Outcome,
  ) {
    await client.query(
      `INSERT INTO trip_operations(operation_id,trip_id,operation_type,actor_user_id,request_hash,state,context_revision,outcome,started_at,completed_at)
      VALUES($1,$2,$3,$4,$5,'SUCCEEDED',$6,$7::jsonb,clock_timestamp(),clock_timestamp())`,
      [
        operation,
        trip.id,
        command,
        actor,
        requestHash,
        trip.membership_revision,
        JSON.stringify(outcome),
      ],
    );
  }
  async create(
    input: TripV1.CreateInvitationRequest,
    correlation: string,
    deadlineMs = Date.now() + 1800,
  ): Promise<TripV1.CreateInvitationResponse> {
    const actor = accessUuid(input.actor_user_id),
      tripId = accessUuid(input.trip_id),
      operation = accessUuid(input.operation_id);
    const expected = accessRevision(input.expected_membership_revision);
    if (!['EMAIL', 'LINK'].includes(input.invitation_type ?? ''))
      return fail('VALIDATION_FAILED', 400);
    const email = input.invitation_type === 'EMAIL' ? invitationEmail(input.email) : null;
    if (input.invitation_type === 'LINK' && input.email !== undefined)
      return fail('VALIDATION_FAILED', 400);
    const expiry = requestedExpiry(input.expires_at);
    const requestHash = hash({
      actor,
      command: 'CREATE_INVITATION',
      tripId,
      type: input.invitation_type,
      email,
      expiry: expiry?.toISOString() ?? null,
      expected,
    });
    // Remote lookup is outside SQL locks. Outage means no local business mutation.
    const recipient = email
      ? await this.identity.getInvitationIdentity({ email }, correlation, deadlineMs)
      : undefined;
    return this.db.withTransaction(async (client) => {
      const trip = await this.lock(client, tripId, operation);
      await this.owner(client, tripId, actor);
      const replay = await this.replay(
        client,
        operation,
        actor,
        'CREATE_INVITATION',
        tripId,
        requestHash,
      );
      if (replay) return replay as TripV1.CreateInvitationResponse;
      if (trip.archived_at) return fail('STATE_CONFLICT', 409);
      if (trip.membership_revision !== expected)
        return fail('VERSION_CONFLICT', 409, { membership_revision: trip.membership_revision });
      const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!
        .now;
      const expiresAt = expiry ?? new Date(now.getTime() + 7 * 86400_000);
      if (expiresAt <= now) return fail('VALIDATION_FAILED', 400);
      if (
        recipient?.found &&
        (
          await client.query(
            'SELECT 1 FROM trip_members WHERE trip_id=$1 AND user_id=$2 AND left_at IS NULL',
            [tripId, recipient.user_id],
          )
        ).rowCount
      )
        return fail('STATE_CONFLICT', 409);
      await this.expire(client, tripId, correlation);
      if (
        email &&
        (
          await client.query(
            "SELECT 1 FROM invitations WHERE trip_id=$1 AND lower(btrim(email))=$2 AND status='PENDING'",
            [tripId, email],
          )
        ).rowCount
      )
        return fail('STATE_CONFLICT', 409);
      const token = this.crypto.mint();
      const row = (
        await client.query<InvitationRow>(
          `INSERT INTO invitations(trip_id,email,invited_by_user_id,token_hash,expires_at,invitation_type,delivery_token_ciphertext,delivery_token_expires_at,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()) RETURNING *`,
          [
            tripId,
            email,
            actor,
            invitationTokenHash(token),
            expiresAt,
            input.invitation_type,
            email ? this.crypto.encrypt(token) : null,
            email ? expiresAt : null,
          ],
        )
      ).rows[0]!;
      const outcome = { invitation: view(row) };
      await this.audit(client, row, 'INVITATION_CREATED', actor, correlation);
      await this.event(client, row, trip, actor, correlation, operation);
      await this.receipt(client, operation, actor, 'CREATE_INVITATION', trip, requestHash, outcome);
      return { ...outcome, one_time_link: this.link(token) };
    });
  }
  async list(
    input: TripV1.ListInvitationsRequest,
    correlation: string,
  ): Promise<TripV1.ListInvitationsResponse> {
    const actor = accessUuid(input.actor_user_id),
      tripId = accessUuid(input.trip_id);
    const limit = input.limit ?? 20;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (input.status !== undefined && !states.includes(input.status))
    )
      return fail('VALIDATION_FAILED', 400);
    const cursor = input.cursor === undefined ? null : accessUuid(input.cursor);
    return this.db.withTransaction(async (client) => {
      await this.lock(client, tripId);
      await this.owner(client, tripId, actor);
      await this.expire(client, tripId, correlation);
      const rows = (
        await client.query<InvitationRow>(
          `SELECT * FROM invitations WHERE trip_id=$1 AND ($2::uuid IS NULL OR id>$2) AND ($3::text IS NULL OR status=$3) ORDER BY id LIMIT $4`,
          [tripId, cursor, input.status ?? null, limit + 1],
        )
      ).rows;
      return {
        items: rows.slice(0, limit).map(view),
        next_cursor: rows.length > limit ? rows[limit - 1]!.id : undefined,
      };
    });
  }
  async versionCommand(
    input: TripV1.RevokeInvitationRequest,
    correlation: string,
    command: 'REVOKE_INVITATION' | 'RESEND_INVITATION',
  ): Promise<TripV1.CreateInvitationResponse> {
    const actor = accessUuid(input.actor_user_id),
      tripId = accessUuid(input.trip_id),
      operation = accessUuid(input.operation_id),
      id = accessUuid(input.invitation_id),
      expected = accessRevision(input.expected_version);
    const requestHash = hash({ actor, command, tripId, id, expected });
    const result = await this.db.withTransaction(async (client) => {
      const trip = await this.lock(client, tripId, operation);
      await this.owner(client, tripId, actor);
      const replay = await this.replay(client, operation, actor, command, tripId, requestHash);
      if (replay) return replay as TripV1.CreateInvitationResponse;
      if (trip.archived_at) return fail('STATE_CONFLICT', 409);
      await this.expire(client, tripId, correlation);
      let row = (
        await client.query<InvitationRow>('SELECT * FROM invitations WHERE id=$1 AND trip_id=$2', [
          id,
          tripId,
        ])
      ).rows[0];
      if (!row) return fail('RESOURCE_NOT_FOUND', 404);
      if (row.status === 'EXPIRED') return expired;
      if (row.version !== expected)
        return fail('VERSION_CONFLICT', 409, { invitation_version: row.version });
      if (
        row.status !== 'PENDING' ||
        row.version >= maximumRevision ||
        (command === 'RESEND_INVITATION' && row.invitation_type !== 'EMAIL')
      )
        return fail('STATE_CONFLICT', 409);
      if (command === 'RESEND_INVITATION') {
        const token = this.crypto.mint();
        row = (
          await client.query<InvitationRow>(
            `UPDATE invitations SET token_hash=$2,delivery_token_ciphertext=$3,delivery_token_expires_at=expires_at,version=version+1 WHERE id=$1 RETURNING *`,
            [id, invitationTokenHash(token), this.crypto.encrypt(token)],
          )
        ).rows[0]!;
        await this.event(client, row, trip, actor, correlation, operation);
      } else
        row = (
          await client.query<InvitationRow>(
            `UPDATE invitations SET status='REVOKED',resolved_by_user_id=$2,resolved_at=clock_timestamp(),version=version+1,delivery_token_ciphertext=NULL,delivery_token_expires_at=NULL WHERE id=$1 RETURNING *`,
            [id, actor],
          )
        ).rows[0]!;
      const outcome = { invitation: view(row) };
      await this.audit(
        client,
        row,
        command === 'RESEND_INVITATION' ? 'INVITATION_RESENT' : 'INVITATION_REVOKED',
        actor,
        correlation,
      );
      await this.receipt(client, operation, actor, command, trip, requestHash, outcome);
      return outcome;
    });
    if (result === expired) return fail('STATE_CONFLICT', 409);
    return result;
  }
  private recipient(row: InvitationRow, actor: IdentityV1.GetInvitationIdentityResponse) {
    if (!actor.found || actor.status !== CommonV1.AccountStatus.ACCOUNT_STATUS_ACTIVE)
      return fail('PERMISSION_DENIED', 403);
    if (
      row.invitation_type === 'EMAIL' &&
      (actor.normalized_email !== row.email?.trim().toLowerCase() || !actor.email_verified_at)
    )
      return fail('RESOURCE_NOT_FOUND', 404);
    if (row.resolved_by_user_id && row.resolved_by_user_id !== actor.user_id)
      return fail('RESOURCE_NOT_FOUND', 404);
  }
  async tokenCommand(
    input: TripV1.PreviewInvitationRequest,
    correlation: string,
    command: 'PREVIEW_INVITATION' | 'ACCEPT_INVITATION' | 'DECLINE_INVITATION',
    deadlineMs = Date.now() + 1800,
  ): Promise<TripV1.PreviewInvitationResponse | TripV1.AcceptInvitationResponse> {
    const actor = accessUuid(input.actor_user_id),
      tokenHash = invitationTokenHash(input.token);
    const operation = command === 'PREVIEW_INVITATION' ? undefined : accessUuid(input.operation_id);
    const candidate = (
      await this.db.query<InvitationRow>('SELECT * FROM invitations WHERE token_hash=$1', [
        tokenHash,
      ])
    ).rows[0];
    if (!candidate) return fail('RESOURCE_NOT_FOUND', 404);
    const identity = await this.identity.getInvitationIdentity(
      { user_id: actor },
      correlation,
      deadlineMs,
    );
    this.recipient(candidate, identity);
    const profiles = await this.identity.getProfiles(
      { user_ids: [candidate.invited_by_user_id] },
      correlation,
      deadlineMs,
    );
    const inviter = profiles.profiles?.[0]?.display_name ?? '';
    const requestHash = hash({ actor, command, tripId: candidate.trip_id, tokenHash });
    const result = await this.db.withTransaction(async (client) => {
      const trip = await this.lock(client, candidate.trip_id, operation);
      let row = (
        await client.query<InvitationRow>(
          'SELECT * FROM invitations WHERE id=$1 AND token_hash=$2',
          [candidate.id, tokenHash],
        )
      ).rows[0];
      if (!row) return fail('RESOURCE_NOT_FOUND', 404);
      this.recipient(row, identity);
      const activeOriginal = async () => {
        if (
          !row!.accepted_member_id ||
          !(
            await client.query(
              'SELECT 1 FROM trip_members WHERE id=$1 AND trip_id=$2 AND user_id=$3 AND left_at IS NULL',
              [row!.accepted_member_id, trip.id, actor],
            )
          ).rowCount
        )
          return fail('RESOURCE_NOT_FOUND', 404);
      };
      if (operation) {
        const replay = await this.replay(client, operation, actor, command, trip.id, requestHash);
        if (replay) {
          if (command === 'ACCEPT_INVITATION') await activeOriginal();
          return replay as TripV1.PreviewInvitationResponse | TripV1.AcceptInvitationResponse;
        }
      }
      if (command === 'ACCEPT_INVITATION' && row.status === 'ACCEPTED') {
        await activeOriginal();
        const stored = (
          await client.query<{ outcome: TripV1.AcceptInvitationResponse }>(
            `SELECT outcome FROM trip_operations WHERE trip_id=$1 AND operation_type='ACCEPT_INVITATION' AND state='SUCCEEDED' AND outcome->'membership'->>'id'=$2 ORDER BY started_at LIMIT 1`,
            [trip.id, row.accepted_member_id],
          )
        ).rows[0];
        if (!stored) throw new Error('Missing acceptance receipt');
        await this.receipt(client, operation!, actor, command, trip, requestHash, stored.outcome);
        return stored.outcome;
      }
      if (trip.archived_at) return fail('STATE_CONFLICT', 409);
      await this.expire(client, trip.id, correlation);
      row = (await client.query<InvitationRow>('SELECT * FROM invitations WHERE id=$1', [row.id]))
        .rows[0]!;
      if (row.status === 'EXPIRED') return expired;
      if (row.status !== 'PENDING') return fail('STATE_CONFLICT', 409);
      const preview = (): TripV1.PreviewInvitationResponse => ({
        id: row!.id,
        trip_name: trip.name,
        inviter_display_name: inviter,
        status: row!.status,
        expires_at: stamp(row!.expires_at),
      });
      if (command === 'PREVIEW_INVITATION') return preview();
      if (row.version >= maximumRevision) return fail('STATE_CONFLICT', 409);
      let outcome: TripV1.PreviewInvitationResponse | TripV1.AcceptInvitationResponse;
      if (command === 'ACCEPT_INVITATION') {
        // Rejoin needs a genuinely new invitation after the last departure; resend
        // keeps created_at and cannot restore a removed membership or editor grant.
        if (
          (
            await client.query(
              `SELECT 1 FROM trip_members m JOIN invitations i ON i.id=$3
          WHERE m.trip_id=$1 AND m.user_id=$2 AND m.left_at IS NOT NULL AND i.created_at<=m.left_at LIMIT 1`,
              [trip.id, actor, row.id],
            )
          ).rowCount
        )
          return fail('STATE_CONFLICT', 409);
        if (
          trip.closure_lock_id ||
          (
            await client.query(
              "SELECT 1 FROM trip_operations WHERE trip_id=$1 AND state IN ('PROCESSING','PENDING_RECOVERY','NEEDS_REVIEW')",
              [trip.id],
            )
          ).rowCount
        )
          return fail('STATE_CONFLICT', 409);
        if (
          (
            await client.query(
              'SELECT 1 FROM trip_members WHERE trip_id=$1 AND user_id=$2 AND left_at IS NULL',
              [trip.id, actor],
            )
          ).rowCount ||
          trip.membership_revision >= maximumRevision ||
          trip.export_revision >= maximumRevision
        )
          return fail('STATE_CONFLICT', 409);
        const member = (
          await client.query<MemberRow>(
            "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',clock_timestamp()) RETURNING *",
            [trip.id, actor],
          )
        ).rows[0]!;
        row = (
          await client.query<InvitationRow>(
            `UPDATE invitations SET status='ACCEPTED',accepted_member_id=$2,resolved_by_user_id=$3,resolved_at=clock_timestamp(),version=version+1,delivery_token_ciphertext=NULL,delivery_token_expires_at=NULL WHERE id=$1 RETURNING *`,
            [row.id, member.id, actor],
          )
        ).rows[0]!;
        await client.query(
          'UPDATE trips SET membership_revision=membership_revision+1,export_revision=export_revision+1,updated_at=clock_timestamp() WHERE id=$1',
          [trip.id],
        );
        trip.membership_revision++;
        trip.export_revision++;
        outcome = {
          membership: {
            id: member.id,
            trip_id: trip.id,
            user_id: actor,
            role: CommonV1.MembershipRole.MEMBERSHIP_ROLE_MEMBER,
            joined_at: stamp(member.joined_at),
            left_at: undefined,
          },
          revisions: {
            plan_version: trip.plan_version,
            membership_revision: trip.membership_revision,
            export_revision: trip.export_revision,
          },
        };
        await this.event(client, row, trip, actor, correlation, operation!, member);
      } else {
        row = (
          await client.query<InvitationRow>(
            `UPDATE invitations SET status='DECLINED',resolved_by_user_id=$2,resolved_at=clock_timestamp(),version=version+1,delivery_token_ciphertext=NULL,delivery_token_expires_at=NULL WHERE id=$1 RETURNING *`,
            [row.id, actor],
          )
        ).rows[0]!;
        outcome = preview();
      }
      await this.audit(
        client,
        row,
        command === 'ACCEPT_INVITATION' ? 'INVITATION_ACCEPTED' : 'INVITATION_DECLINED',
        actor,
        correlation,
      );
      await this.receipt(client, operation!, actor, command, trip, requestHash, outcome);
      return outcome;
    });
    if (result === expired) return fail('STATE_CONFLICT', 409);
    return result;
  }
  async delivery(
    input: TripV1.GetInvitationDeliveryRequest,
    correlation: string,
    deadlineMs = Date.now() + 1800,
  ): Promise<TripV1.GetInvitationDeliveryResponse> {
    const id = accessUuid(input.invitation_id);
    if (input.expected_invitation_version !== undefined)
      accessRevision(input.expected_invitation_version);
    const select = async () =>
      (
        await this.db.query<InvitationRow>(
          `SELECT i.* FROM invitations i JOIN trips t ON t.id=i.trip_id WHERE i.id=$1 AND i.invitation_type='EMAIL' AND i.status='PENDING' AND i.expires_at>clock_timestamp() AND i.delivery_token_expires_at>clock_timestamp() AND i.delivery_token_ciphertext IS NOT NULL AND t.archived_at IS NULL AND t.deleted_at IS NULL AND ($2::int IS NULL OR i.version=$2)`,
          [id, input.expected_invitation_version ?? null],
        )
      ).rows[0];
    let row = await select();
    if (!row) return { valid: false };
    const recipient = await this.identity.getInvitationIdentity(
      { email: row.email! },
      correlation,
      deadlineMs,
    );
    if (recipient.found && recipient.status !== CommonV1.AccountStatus.ACCOUNT_STATUS_ACTIVE)
      return { valid: false };
    // Recheck after network wait; source authority wins over queued event state.
    row = await select();
    if (!row) return { valid: false };
    return {
      valid: true,
      delivery: {
        recipient_email: invitationEmail(row.email),
        link: this.link(this.crypto.decrypt(row.delivery_token_ciphertext!)),
        expires_at: stamp(row.expires_at),
        invitation_version: row.version,
        recipient_user_id:
          recipient.found && recipient.email_verified_at ? recipient.user_id : undefined,
      },
    };
  }
  async acknowledge(
    input: TripV1.AcknowledgeInvitationDeliveryRequest,
  ): Promise<TripV1.AcknowledgeInvitationDeliveryResponse> {
    const id = accessUuid(input.invitation_id),
      version = accessRevision(input.invitation_version);
    const updated = await this.db.query(
      `UPDATE invitations SET delivery_token_ciphertext=NULL,delivery_token_expires_at=NULL WHERE id=$1 AND version=$2`,
      [id, version],
    );
    return { acknowledged: updated.rowCount === 1 };
  }
}
