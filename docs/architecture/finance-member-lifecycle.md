# Finance obligations for Trip member lifecycle

## Scope

This increment completes the Finance side of `LEAVE_MEMBER` and `REMOVE_MEMBER`.
Trip remains the owner of membership state. Finance decides whether the target has
an unresolved financial obligation and, when safe, waives unpaid contributions
before it stores a terminal operation receipt.

The baseline is SRS v2.3 FR-TR05/QD08–09/BR-FN02, ERD v1.2 and DDL/API/Event v1.1.
Both lifecycle commands use the same financial rules. There is no new REST API,
RPC, event type, migration or public Finance projection in this increment.

## Decision matrix

| Finance fact                                               | Result                                       |
| ---------------------------------------------------------- | -------------------------------------------- |
| Trip has no Fund                                           | `COMMITTED`; no Finance effect               |
| Target is Holder and Fund is not `CLOSED`                  | `FINANCE_OBLIGATION_BLOCKED`                 |
| Fund is `CLOSING` or has a pending closure                 | blocked                                      |
| Contribution is `TRANSFER_REPORTED`                        | blocked                                      |
| Contribution is eligible `PENDING`                         | change to `WAIVED` with reason `MEMBER_LEFT` |
| Payment is active, uncertain or under review               | blocked                                      |
| Payment is final `FAILED`/`EXPIRED` without reconciliation | does not block an eligible waiver            |
| Target Refund is `PENDING`/`HOLDER_REPORTED`               | blocked                                      |
| Confirmed target Refund has an unresolved reversal request | blocked                                      |
| Stable confirmed, cancelled or reversed Refund             | historical; does not block                   |
| Expense or Financial Note refers to target                 | historical; does not block                   |
| Confirmed contribution and its ledger are consistent       | historical; does not block                   |

A confirmed contribution remains group money. Departure never deletes ledger
entries, changes the Fund balance, invents an Expense, creates a Refund or calls a
bank/provider. A member who wants money returned must use the explicit Refund
workflow before departure. Partial contribution payment remains unsupported.

Finance fails closed for inconsistent money history. A `CONFIRMED` contribution
requires its original `CONTRIBUTION` ledger entry and no reversal. A `REVERSED`
contribution requires both the original entry and a linked `REVERSAL`. A ledger
attached to `PENDING`, `TRANSFER_REPORTED`, `WAIVED` or `CANCELLED` is also a
blocker. Provider success without the matching state/ledger is unresolved.

## Transaction and lock order

`ExecuteTripOperation` performs one Finance transaction:

1. take an advisory transaction lock for `operation_id`;
2. return an existing terminal receipt after verifying actor, scope, hash, Trip
   and exact membership target;
3. lock the Fund for the Trip, if it exists;
4. lock pending closure, target contributions, their attempts/webhooks and target
   Refunds in stable ID order, then read original/reversal ledger evidence;
5. evaluate every blocker before changing a contribution;
6. if allowed, update all eligible target `PENDING` rows to `WAIVED`, set
   `waived_reason=MEMBER_LEFT` and `waived_at`;
7. write one audit and one `ContributionUpdated` outbox event per waived row;
8. store the terminal Finance receipt in the same transaction.

Each waived contribution increments its own version once. The Fund finance version
increments once for the whole lifecycle operation, even when several contributions
are waived. Their events have distinct `event_id` values and share that new Fund
aggregate version. Request versions, balance, ledger and Refund reservation do not
change.

If one blocker exists, Finance stores a `REJECTED` receipt and applies no partial
waiver. SQL, audit, event or receipt failure rolls back every Finance effect.
`FINANCE_OBLIGATION_BLOCKED` returns no contribution, payment or Refund IDs.

## Idempotency, cancellation and recovery

Execute and `CancelOperationIfNotCommitted` serialize on the same operation ID.
If cancellation wins, later Execute replays `CANCELLED` and cannot waive anything.
If Execute wins, cancellation returns the durable `COMMITTED` result and never
reverses its effects. Same operation with a different actor, hash, scope, Trip or
target is rejected.

Trip persists T1 before calling Finance and finalizes membership in T2 only after a
valid `COMMITTED` receipt. A lost response uses `GetOperationResult`; Finance
`COMMITTED` is recovered forward and is never rolled back from Trip. A tested Trip
T2 failure leaves membership active while the contribution waiver is durable, then
the background worker completes the same operation exactly once after restart.

## Release boundary and validation

`TRIP_MEMBERSHIP_LIFECYCLE_ENABLED` remains `false` by default. The focused command
is:

```powershell
corepack pnpm finance:lifecycle:test
```

It starts isolated Identity, Gateway, Trip, Finance and PostgreSQL/MinIO resources
and uses real service transport. Coverage includes no-Fund leave, multiple waivers,
all-or-nothing rejection, Payment and Refund blockers, Holder until `CLOSED`,
Expense/Note history, `CLOSING`, privacy and recover-forward after Finance commit.
The harness removes its containers, volumes and network.

This completes the Finance obligation runtime, not all of FR-TR05. Production
enablement still depends on Automation reminder/watch recipient effects, Export
authorization at download time, release configuration and operational review.

See [Trip lifecycle design](trip-member-lifecycle.md),
[handoff/runbook](trip-member-lifecycle-handoff.md) and
[historical plus current validation](trip-member-lifecycle-validation.md).
