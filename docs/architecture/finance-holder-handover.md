# Fund Holder handover — SRS v1.2 integration

This additive workflow implements FR-FIN-06 from the supplied SRS v1.2 following the user's authorization to resolve the Finance integration gaps. It changes the older SRS v2.3/QD09 convention that held one Holder fixed until closure. The new endpoints are not an assertion that all Finance requirements or all client screens are accepted.

## Workflow and HTTP contract

- `GET /api/v1/funds/{fundId}/holder-handovers` reads the latest 100 workflows; `GET /api/v1/holder-handovers/{id}` reads a specific workflow. Current readable membership is required.
- `POST /api/v1/funds/{fundId}/holder-handovers` lets the current Owner nominate a different active member, including the Owner. Body: `new_holder_user_id`, `expected_finance_version`.
- `POST /api/v1/holder-handovers/{id}/accept` lets only the nominated successor accept. Body: `expected_version`, `expected_finance_version`.
- `POST /api/v1/holder-handovers/{id}/refresh-snapshot` captures a fresh snapshot and clears both confirmations. Owner or either party may request this while ACCEPTED.
- `POST /api/v1/holder-handovers/{id}/confirm` records one party's confirmation. Body adds `expected_snapshot_finance_version`. Both confirmations must refer to the same currently valid snapshot.
- `POST /api/v1/holder-handovers/{id}/cancel` lets Owner or either party cancel before completion. Body adds a nonblank `reason` (up to 1024 characters).

Writes require the existing idempotency key and Trip finance guard. A pending operation returns HTTP202 for polling/replay. Mutation responses include the workflow ID, old/new Holder IDs, status, workflow version, current Finance version, snapshot version/data, staleness and confirmation timestamps. Status transitions: NOMINATED → ACCEPTED → COMPLETED; NOMINATED/ACCEPTED → CANCELLED. One partial unique index guarantees at most one active workflow per Fund.

## Snapshot, concurrency and recovery

The Finance row lock serializes capture, confirmation and money writers. Snapshot includes balance, reserved refunds, available balance, last ledger sequence, pending contribution/refund/expense/payment/exception IDs and active destination IDs. A SHA-256 fingerprint also covers the status/version/update data of contributions, refunds, expenses and destinations, the status, amount, reconciliation flag, error code, provider transaction and phase of provider attempts (not their retry timestamps, which reconciliation rewrites every pass), and attributable webhook receipts. This detects provider state changes even when a Fund version has not advanced. Deleted draft expenses are excluded from the pending list; refunds with a pending reversal request count as pending obligations.

GET reports `snapshot_stale=true` and hides both confirmation timestamps if Finance version or fingerprint differs. Confirm rechecks both under the Fund lock; stale confirmation is rejected with VERSION_CONFLICT. Refresh clears confirmations and captures current values. A new handover version is returned even if the Finance version is unchanged. Workflow metadata actions increment only workflow version; completed transfer increments Finance version once.

The second valid confirmation changes Holder and completes the workflow in one transaction with audit and command receipt. It creates no ledger entry and does not claim that Wolfari transferred real money. All existing payment destinations are deactivated, unconfirmed and made nondefault; historical contribution/payment snapshots remain unchanged for later reconciliation. The new Holder must confirm a valid new receiving configuration before new payment instructions are issued.

Current active status of both parties is rechecked by every non-cancellation mutation using Trip's guarded authority. Closure and membership/expense restrictions are enforced by the corresponding writers, not by frontend visibility. The old Holder remains responsible through ACCEPTED. Cancellation preserves that Holder. Legitimate incoming money and existing obligations continue through the existing reconciliation flows and invalidate stale snapshot consent. Provider money that reaches a previous Holder's destination after completion is never posted automatically: the attempt is parked with `PREVIOUS_HOLDER_REVIEW_REQUIRED`, exactly one review receipt is kept per provider fact and reason, the reconciliation worker stops re-querying it, and only the current Holder can settle it with `previous_holder_transfer_confirmed=true`.

The workflow reuses durable Finance command receipts and Trip recovery; retry with the same key/normalized body returns the original acknowledgement without repeating transfer. The former Holder may read their completed acknowledgement if still a current readable member. A changed request with the same key is an idempotency conflict.

## Known limitations

- Contributions still PENDING at completion keep their original destination snapshot. No payment instruction or new MoMo attempt is issued for them until they are cancelled and re-requested, or settled by a manual report that the current Holder confirms with `previous_holder_transfer_confirmed=true`. A re-issue path that rebinds outstanding contributions to the new Holder's confirmed destination is a separate product decision.
- MoMo attempts still CREATED (not yet dispatched) at completion are not expired; if dispatched later they target the old destination and are then parked as described above.
- The snapshot, including pending payment and exception IDs, is readable by every current member through the handover endpoints, while listing payment exceptions themselves stays Owner/Holder only.
- Each unresolved review receipt still blocks closure and must be resolved individually.

## Verification

`corepack pnpm finance:handovers:test` runs isolated PostgreSQL and real HTTP/gRPC services. Its cases cover authority, duplicate active workflow, repeat request, outsider masking, new expense/closure guards, both confirmations, version and provider-state staleness, refresh, atomic transfer, destination resets, unchanged ledger, cancellation and recovery after Finance commit before Trip completion. It must be run successfully before claiming integration acceptance. The targeted domain/HTTP unit suite exercises authorization and transition boundaries; these unit checks alone do not prove database atomicity or client integration.

Web/Android/iOS integration and real external money/provider delivery are separate acceptance work. Financial responsibility is acknowledged by the users; Wolfari neither moves money nor independently verifies a bank transfer.
