# Finance Automation context

Finance.GetAutomationContext is a read-only internal RPC for Automation. It resolves the current eligible audience for contribution and closure messages. It does not enqueue, schedule or deliver notifications. There is no public REST endpoint.

## Requirements and source convention

The existing [Finance protobuf](../../packages/contracts/proto/wolfari/finance/v1/finance.proto) and [RPC catalog](../../packages/contracts/catalog/rpc-v1.json) define the request, minimal response, Automation-only caller and 2-second transport deadline. Business rules come from [SRS 2.3](../Wolfari_SRS_v2.3_ChinhThuc.docx), sections 5.2, 5.7 and 5.8, and [DDL/API/Event 1.1](../Wolfari_DDL_API_Event_Specification_v1.1_ChinhThuc.docx), section 6.

The source documents and protobuf do not enumerate source_type strings. This implementation defines the following closed convention for callers; it adds no protobuf field, event type or schema migration.

| source_type          | source_id                 | Eligible audience                                               | due_at                               |
| -------------------- | ------------------------- | --------------------------------------------------------------- | ------------------------------------ |
| CONTRIBUTION_REQUEST | Contribution request UUID | Current members with PENDING contributions in that request      | Current request deadline, if present |
| CONTRIBUTION_DUE     | Contribution UUID         | That PENDING contribution's member                              | Current request deadline, if present |
| CONTRIBUTION_REVIEW  | Contribution UUID         | Current Fund Holder while the contribution is TRANSFER_REPORTED | Absent                               |
| CLOSURE              | Closure UUID              | Required snapshot users who have not confirmed that closure     | Absent                               |

Contribution purposes require both Fund and request OPEN. Closure requires Fund CLOSING and the specified closure PENDING_CONFIRMATIONS. A source must belong to the supplied Fund. CONFIRMED, WAIVED, CANCELLED and REVERSED contributions yield no audience for these purposes. A stale contribution reminder never changes into a Holder review message.

Trip must be ACTIVE and each recipient must have a current readable membership. Archived/deleted Trips and departed members cannot receive these contexts. A conservative historical-source check excludes debtor memberships joined after the contribution was created, and closure memberships joined after the closure was requested. Normal lifecycle processing already waives old pending obligations and blocks membership changes during closure; the additional check rejects inconsistent stale data rather than resurrecting an old notification after rejoin. Trip currently projects membership timestamps at millisecond precision, so an ambiguous same-millisecond source/join boundary is conservatively excluded. This cutoff does not apply to CONTRIBUTION_REVIEW, whose recipient comes from the current Fund holder_user_id. This read does not introduce a Holder handover workflow.

The request's actual UTC deadline is returned only for request/due purposes with a nonempty authorized audience. An omitted deadline stays omitted. Finance does not subtract 24 hours, calculate overdue occurrences, substitute the Trip start time, or invent a closure deadline. Scheduling belongs to Automation.

## Authorization and configuration

Caller metadata must contain exactly one x-caller-service=Automation, its own x-service-secret and a UUID x-correlation-id. AUTOMATION_FINANCE_SECRET is distinct from Gateway and Trip credentials. The RPC catalog still controls method access: this credential grants no existing Finance writer, public reader or Trip operation.

Run corepack pnpm env:init to populate missing local configuration. It generates the shared credential once and distributes it only to Finance and Automation, with FINANCE_GRPC_TARGET for Automation. Existing values are preserved. No secret belongs in tracked files. Missing or short Automation credentials deny this RPC while existing Finance startup remains compatible. The current internal transport is loopback/test only; this change does not establish production TLS or production readiness.

## Read consistency and failure behavior

1. Read a parameterized Finance source snapshot containing only identifiers, versions, states, membership cutoffs, deadline and candidate IDs. Each snapshot uses a short read-only transaction with a local statement timeout derived from the remaining deadline.
2. Check each candidate through the existing Finance-to-Trip GetAccessContext client, outside SQL transactions. At most eight authorization checks run concurrently under one shared deadline. No audience truncation or per-batch deadline extension is allowed.
3. Re-read the Finance snapshot and compare the full source fingerprint. Return recipients only when source state, version, deadline and candidate membership are unchanged.

Trusted Trip business denial excludes a recipient. A transport failure, malformed context, expired deadline or changed Finance snapshot returns SERVICE_UNAVAILABLE for the whole request. It never returns a partially checked audience. Pool acquisition retains the existing database provider timeout; expiry is checked after acquisition before reading source data. No timed-out operation is abandoned with a live connection. These checks are observations, not an atomic cross-service dispatch lock; Automation must revalidate immediately before delivery and must check Identity account state and current notification preferences.

| Condition                                                                    | Domain / gRPC result                                       |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Missing or mismatched credential/caller                                      | PERMISSION_DENIED                                          |
| Invalid UUID or unsupported purpose                                          | VALIDATION_FAILED / INVALID_ARGUMENT                       |
| Missing source or source in another Fund                                     | RESOURCE_NOT_FOUND / NOT_FOUND                             |
| Existing but ineligible source, or no authorized recipients                  | Current Fund version/status, empty recipients, no deadline |
| Failed dependency, invalid dependency response, deadline or changed snapshot | SERVICE_UNAVAILABLE / UNAVAILABLE                          |

The successful response contains finance_version, Fund status, authorized_recipients with user_id, optional due_at, and optional source_revision. source_revision is populated only for CONTRIBUTION_REVIEW from the existing contribution.version, including an ineligible source with no audience. The source fingerprint already checks this revision across the two SQL reads. Other purposes omit it. The additive field lets Holder inbox consumers distinguish metadata events from a later report after rejection; it is not Fund version or a new business revision counter. It contains no amounts, account numbers, request titles, notes, payment snapshots, receipt keys or provider payloads. The read does not change ledger, balance, Fund/source version, audit, outbox or command receipts.

## Validation and remaining work

Unit tests cover purpose/state selection, strict input, membership and timestamp validation, concurrency/deadline limits, source changes and gRPC credential isolation. The isolated integration fixture exercises PostgreSQL queries plus actual Finance and Trip gRPC, response projection, current permissions and no-write assertions. Run corepack pnpm finance:automation-context:test for the focused fixture, or corepack pnpm finance:test for the full Finance integration suite.

Local verification on 25 October 2026: workspace build and lint pass; the full unit suite passes 1,561 tests in 110 files, full Finance integration passes 122 groups, and database integration passes 28 groups. Contract catalogs/generated sources are reproducible and unchanged against the parent commit. The full Finance run includes the real PostgreSQL submillisecond rejoin regression and checks that all 17 Finance tables remain unchanged across context reads. The isolated fixtures were cleaned. These results apply to this local change, not to an already published CI run or real notification delivery.

The [durable outbox relay](finance-outbox.md) and [Finance inbox consumer](finance-notification-inbox.md) now implement publication and in-app projections for ContributionRequested/ClosureRequested and ContributionUpdated Holder review, both disabled by default. Closure messages additionally enforce a per-user/source 24-hour limit. Other Finance event consumers, push/email, Reminder API132 and Finance.GetExportSnapshot remain separate work. Consumers must retain event IDs: sibling contribution events may share a Fund version, and an explicit closure reminder may emit a new event without increasing finance_version. This RPC alone is not proof of those workflows being complete.
