# Membership lifecycle — Trip-side implementation

Date: 2026-10-02. Branch: `feat/trip-member-lifecycle`, stacked on Invitations
`64e32b91a1b4a6b1ae13c5d083b84df63a772b86` with the user's approval. Update base
after PR #9 merges; do not assume current main already contains Invitations.

## Scope and requirement mapping

SRS v2.3 FR-TR04/05, QD08/09/21/22 and section 8; ERD v1.2;
DDL/API/Event v1.1 API030/033/034/038 are the baseline. This Markdown records the
approved implementation clarifications without changing source DOCX or SQL baselines.

| Requirement           | This branch                                                                      | Remaining dependency                                                                   |
| --------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Member list           | Active member reads six-field membership projection; include_left optional       | Identity display-name fanout intentionally absent                                      |
| Leave/remove          | Trip prepare, Finance adapter, finalize, replay, recovery                        | Finance Execute/Get/Cancel runtime                                                     |
| Finance obligations   | Same protocol for leave/remove; reject fails closed                              | Real Holder/payment/refund/closure checks and PENDING to WAIVED/MEMBER_LEFT            |
| Permission revocation | Current membership, selected editors, GetAccessContext and real Plan transaction | Other services must fresh-authorize and use shared guard for writes                    |
| Packing               | Unassign/TODO/reset completion; before/after audit                               | Packing CRUD runtime remains separate                                                  |
| Events                | MemberLeft/Removed plus PlanUpdated when packing changed                         | Automation reminders/watch/recipient invalidation                                      |
| History               | Membership, activity attribution and financial references retained               | Export download authorization when Export runtime exists                               |
| Distributed guard     | Lifecycle-initiated protocol only                                                | BeginFinanceOperation/CompleteOperation and all Finance writers using the shared guard |

No Owner transfer, archive/delete/reopen, Finance/Planning/Location CRUD, ban list,
Admin support API or purge. No new migration: V001/V002 already contain required
columns, indexes and constraints. A future migration would be Trip V003, not an
edit of the baseline. Retention 30/90 days remains unresolved; nothing is purged.

## Permission and state matrix

Active MEMBER leaves self; active OWNER removes a MEMBER in the same Trip.
Member removing someone else: 403. Outsider/departed/Admin without membership: 404. Missing/wrong-Trip target: 404. Owner target/self-leave: 409 STATE_CONFLICT;
the client should explain that ownership must first be transferred through a
future supported workflow. Never infer Owner from created_by_user_id.

Archived Trip rejects new commands; deleted Trip is hidden. COMPLETED by date
alone does not prohibit departure. Closure lock or unresolved operation guard
blocks new membership commands. Stale expected revision yields VERSION_CONFLICT;
an inactive target with a fresh expected revision yields STATE_CONFLICT.

Finance must confirm even that no Fund exists. Never interpret unavailable as
"no obligations". Finance owns Holder-not-CLOSED, unclear payment,
TRANSFER_REPORTED, pending refund and closure restrictions. Eligible unpaid
PENDING contributions become WAIVED/MEMBER_LEFT; no generic debt prohibition,
ledger deletion or fabricated refund. Fixture rejection is not proof of these
business rules in Finance runtime.

## Intent, transaction and lock order

1. Gateway validates current Identity session. Service caller/secret/correlation
   are checked. No RPC runs inside a SQL transaction.
2. T1: operation advisory lock, Trip row, members ordered by ID; fresh database
   authorization, target/state/closure/guard/expected revision. Persist immutable
   target membership/user, normalized command/hash, correlation and authorization
   context in trip_operations. Commit PROCESSING before calling Finance.
3. Finance Execute outside SQL; same operation_id/hash on every retry.
4. T2: same root lock order, then editor rows and packing rows. Verify Finance
   terminal receipt and exact target. Atomically set left_at, left_reason,
   delete selected-editor row, reset target's packing, increment revisions, write
   audit and all outbox rows, store terminal operation receipt.
5. Existing publisher delivers after commit. No broker call inside T2.

Trip-first locking is explicit in core/access/policy and already in Planning.
Under READ COMMITTED, permission reads occur in a new statement after lock waits.
Invitation additionally locks invitation rows after members. Child order does
not introduce cross-command cycles while every writer holds the Trip root.

Audit/receipt/outbox failure rolls back every T2 effect. Finance COMMITTED cannot
be rolled back by PostgreSQL in Trip: retain the durable guard and recover
forward. Account lock after partial commit must not strand the intent.

Ordinary Plan/policy mutations may execute during a pending lifecycle guard.
Finalize uses current revisions/assignments, not a stale policy snapshot; it does
not reject committed Finance merely because policy/Plan changed since prepare.
Finalization still requires the original target to be an active MEMBER and an
active Owner to remain. Unexpected invariant violation stays guarded for review.

| Action                                     | membership_revision | export_revision | plan_version               |
| ------------------------------------------ | ------------------- | --------------- | -------------------------- |
| Successful departure                       | +1                  | +1 once         | +1 only if packing changed |
| Prepare/retry/replay/reject/cancel         | 0                   | 0               | 0                          |
| Invitation accept, unchanged convention    | +1                  | +1              | 0                          |
| Policy/editor change, unchanged convention | +1 when changed     | 0               | 0                          |

Reason is trimmed, required, 1–1000 characters; left_reason is LEFT/REMOVED.
Full reason and packing before/after live in internal audit/intent, not event or
member list. Activities keep created/completed attribution. Packing assigned to
the departing membership is unassigned/TODO with completion actor/time cleared.

## Rejoin and invitation clarification

Rejoin always inserts a NEW membership ID; never reactivate an old row or copy an
editor assignment. ALL_MEMBERS grants rights through the current policy, not
restoration of an old grant. A new invitation must have created_at strictly later
than every recorded departure of that user from that Trip. Comparison stays in
PostgreSQL at full timestamp precision. Creation uses clock_timestamp after the
Trip lock rather than the transaction-start timestamp.

Pending invitations are not globally revoked. A still-pending old LINK remains
available to another eligible user, subject to existing single-accept semantics.
Resend rotates a token on the SAME row and does not reset created_at. Old EMAIL
must be revoked/recreated where pending-email uniqueness prevents replacement.
Old accepted tokens/receipts remain bound to accepted_member_id; after departure,
accept replay does not resurrect access, even after a later rejoin.

## Concurrency and effective revocation

The permission change becomes effective at T2 commit, not at request start or
Finance commit. Until then return PROCESSING/PENDING_RECOVERY, not success.

- Leave/remove or double-remove: one active guard/target effect; another new
  command conflicts, same key replays. No synthetic no-op audit.
- Grant/remove: grant before finalize is deleted; grant after finalize cannot
  select inactive membership. Current revision is incremented once at departure.
- Accept/remove: accept is blocked by the durable guard. Old removal can never
  resolve a later membership merely by user ID.
- Plan first: it holds Trip through authorization and commit, then revoke commits.
- Revoke first: waiting Plan reads fresh membership after the lock and fails.
- Requests starting after revoke commit cannot read/mutate via old membership.
  A read snapshot opened before commit may complete; already sent data cannot be
  recalled. GetAccessContext is a point-in-time result, not reusable authority.

## Recovery and safe replay

Finance COMMITTED => finish Trip. REJECTED/CANCELLED => terminal FAILED and release
guard. NOT_FOUND => CancelOperationIfNotCommitted; never unlock on NOT_FOUND alone.
Finance must serialize Execute/Cancel by operation ID. Later Execute sees the
terminal cancellation. No TTL force-unlock and no new operation ID for retries.

Request path makes one bounded Execute attempt; recovery performs Get/Cancel.
All RPCs are bounded by remaining request budget/2000ms. This is within the
maximum of two synchronous retries, without requiring two retries. Gateway
timeout/503 is ambiguous: poll or replay the same key and payload.

Recovery runs every second, schedules attempts at 10/30/120/300/900 seconds and
then NEEDS_REVIEW. A 15-second worker reservation uses next_retry_at, not a
business-guard lease. Expired reservation permits replay, NEVER releasing guard.
Conditional failure updates cannot overwrite another worker's newer claim or
terminal receipt. Two workers may safely encounter the same idempotent receipt.

Leave replay checks authenticated actor + original receipt command/trip/hash
before requiring active membership. It returns only operation_id/trip_id/state,
status/error_code/next_retry_at, never current Trip/Plan/Finance details. Rejoin
does not change the original target. Remove replay still checks current Owner.
Polling is initiator-only for lifecycle operations; no Admin bypass or generic
access to other Trip receipts. Same key/different body conflicts; a key owned by
another user is masked. Failed command replay retains the terminal failure.

See [handoff/runbook](trip-member-lifecycle-handoff.md),
[OpenAPI](../api/trip-member-lifecycle.openapi.json) and
[validation](trip-member-lifecycle-validation.md).
