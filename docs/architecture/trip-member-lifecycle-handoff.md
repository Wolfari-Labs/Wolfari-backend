# Lifecycle handoff and runbook

## Release boundary

`TRIP_MEMBERSHIP_LIFECYCLE_ENABLED=false` is the default. Listing/polling/replay
remain available; the flag blocks NEW intents only. Recovery never depends on
this flag. Configure FINANCE_GRPC_TARGET and independent TRIP_FINANCE_SECRET via
env:init before enabling in an isolated test environment. Transport retains the
repository's loopback development restriction; this is not production TLS work.

Do not enable against real users before Finance Execute/Get/Cancel and the shared
BeginFinanceOperation/CompleteOperation protocol exist and all relevant Finance
writers obey the same guard. This branch intentionally leaves those generic Trip
RPCs unimplemented. Missing dependency is not a reason to bypass Finance.

## API and protocol

API030 GET members; API033 POST leave; API034 DELETE member; API038 GET operation.
New Trip RPCs ListMembers/LeaveTrip/RemoveMember allow ApiGateway only, 2000ms.
GetOperationResult adds actor_user_id field 2 and is initiator-only for this
slice. The catalog's internal Trip caller is not activated by adding a new secret;
recovery uses the local repository. Field numbers/meanings of old RPCs remain.

Finance Execute/Cancel adds membership_target field 5 with membership_id/user_id/
reason. The actor is the leaving Member or removing Owner; the TARGET is explicit
and may differ. Command scope/type is LEAVE_MEMBER or REMOVE_MEMBER. Validate
operation_id/hash, authorization context, target and terminal status; do not use
an old access context to authorize unrelated writes. COMMITTED is returned only
after Finance effects and its durable receipt commit atomically.

REST uses Identity session actor, Idempotency-Key UUID, correlation ID and existing
error envelope. Unknown body keys including actor_user_id are rejected. 409
FINANCE_OBLIGATION_BLOCKED carries no private Finance IDs. 503/timeout tells the
client to retry the same key, not create a new operation. 202 means not complete;
polling returns 200 even for FAILED/NEEDS_REVIEW. No membership/Trip cache should
treat an operation receipt as current authority.

## Tân — Planning/Location/Packing

- Continue Trip-first row lock, then fresh membership/policy/editor read in the
  SAME transaction as Plan mutation; hold through commit. No pooled/autocommit
  authorization followed by a separate write.
- Grant/assignee identity is membership ID, not user ID. Validate same-Trip active
  membership under that lock; inactive IDs must not be selected.
- Lifecycle owns departure cleanup, not CRUD. It resets only packing assigned to
  the departing ID and writes PlanUpdated/PACKING_ITEM UPSERT entries.
- Keep activity creation/completion attribution; history is not authorization.
- Timeline runtime is tested directly. Location/Packing CRUD integrations remain
  NOT RUN until those modules are implemented.

## Automation/Export consumers

MemberLeft/MemberRemoved are existing catalog events: aggregate Membership,
aggregate_id = old membership ID, aggregate_version = membership_revision;
payload trip_id/user_id/membership_revision. PlanUpdated is emitted only when
packing changes. Do not bind these to the AccountEmailRequested-only handler.

Consumer must dedupe in inbox with its local effect, handle old/reordered versions
and read current context before delivery. A delayed MemberLeft after rejoin must
not disable the new membership blindly by user_id. Event invalidation is eventual,
not a substitute for authorization at mutation/download time. Export must check
current membership before download, even for a previously generated snapshot.

Outbox commit and publisher confirmation do not prove consumer effects. The
integration suite uses an exclusive capture queue only, not a production binding.
Monitor PENDING/FAILED outbox entries and LIFECYCLE_PENDING_RECOVERY/NEEDS_REVIEW
logs; no PII, secrets or reason text should be logged.

## Recovery operator

1. GET operation as initiator or inspect the database through authorized operations
   tooling. Record operation ID, state, retry_count and next_retry_at; never paste
   internal command payload/Finance details into public responses.
2. Restore Finance connectivity or repair the proven invariant issue. COMMITTED
   means recover forward; do not undo Finance manually.
3. Build first. `corepack pnpm trip:retry-lifecycle <operation-id>` is read-only
   dry-run. Review its minimal output and the Finance terminal evidence.
4. `corepack pnpm trip:retry-lifecycle <operation-id> --execute` schedules the SAME
   NEEDS_REVIEW operation for recovery. It reads the configured Trip .env; verify
   the environment before using it. No force-unlock, membership edits, or new ID.
5. Observe terminal state and audit/event count. If Finance remains unavailable,
   leave the guard and investigate; repeated retries are not proof of success.

No Admin endpoint/UI is added. All unresolved operations are retained regardless
of the unresolved global retention policy.

## Hà progress and dependencies

| Area                                | Current branch status                                      | Remaining                                                     |
| ----------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| Trip core, Plan access, Invitations | Existing runtime preserved; Invitations base is stacked    | Rebase/merge main after PR #9                                 |
| Membership lifecycle                | Trip-side implementation with isolated validation          | Finance/shared protocol integration before enable             |
| Planning timeline                   | Runtime exists; not the old "no Planning runtime" status   | Tân's Location/Packing workflows                              |
| Membership events                   | Producer/outbox implemented                                | Automation watch/reminder/current-recipient effect            |
| Architecture contracts              | 42 RPC declarations; 29 business handlers after this slice | 13 target stubs, including generic guard/runtime dependencies |
| Identity/Gateway                    | Existing authentication plus lifecycle transport           | Identity and Admin product backlog unchanged                  |
| FR-TR05 overall                     | PARTIAL, not E2E complete                                  | Finance rules, shared guard, downstream consumers and export  |

Historical reports and the official DOCX status tables describe their original
snapshot; this handoff supersedes their runtime counts, not their business rules.
