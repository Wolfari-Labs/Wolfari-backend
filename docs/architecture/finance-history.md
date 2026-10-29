# Finance history — API162

`GET /api/v1/funds/{fund_id}/history` implements the Member audit-history read listed in DDL/API/Event 1.1 API162, under SRS2.3 FR-AD02 and current Finance read permissions. The [OpenAPI contract](../api/finance-history.openapi.json) specifies the HTTP projection. This is Finance audit history; the separate ledger endpoint continues to describe money movements.

## Access and navigation

Gateway derives the actor from the validated Identity session. Finance checks current Trip Owner/Member permission before SQL and again after reading the page. Former/removed members and deleted Trips receive 404; current members can read archived Trips and closed Funds. An administrator has no implicit membership bypass. Rejoining grants current-member read access. These checks are observations, not a distributed lock against a later membership change.

`limit` defaults to 20 and accepts 1–100. `cursor` is opaque, canonical base64url, at most 1024 characters, bound to the Fund and session actor. Unknown/duplicate query parameters are invalid. Order is `(occurred_at DESC, id DESC)`; the cursor preserves PostgreSQL microseconds to prevent skips at sub-millisecond boundaries. It supplies navigation, not authorization, a signature, a saved snapshot or a total count. Every request rechecks permission. Later appends above the cursor do not appear in subsequent pages; reload the first page to see them. No immutable multi-page snapshot is claimed.

## Public audit projection

Each entry contains `id`, `fund_id`, nullable human/system actor, action, entity type/ID, nullable `from_version`/`to_version`, nullable reason, UTC time with six fractional digits, and correlation ID. Versions are the transition already written by that action; some writers use the entity version and closure writers use the Fund finance version. They are not a universal reconstruction of historical values.

Only the explicit existing Finance business actions are selected. Support/technical or unknown future actions are excluded until their privacy projection is reviewed. SQL extracts only the existing reason column, falling back to a string `details.reason`; it never returns raw JSON details. Gateway applies a second field projection. Bank data, provider payloads, evidence keys, operation IDs and arbitrary before/after objects are not exposed. Human-provided business reasons remain visible to current members, just as other shared Finance content.

Historical writers do not consistently store field-level before/after values. This endpoint does not fabricate them or claim that the broader FR-AD02 writer requirements are fully satisfied. A future writer-audit enhancement needs a reviewed field whitelist and preservation rules. Soft-deleted source entities can still be represented by retained audit rows; no join to current entity content erases their history.

Malformed stored records fail the page with 503 rather than silently truncating or returning partial history. Reasons are bounded to 2,000 UTF-16 code units; SQL avoids transporting more than 8,000 UTF-8 bytes. Response size is capped at 1 MiB. Responses use `private, no-store` and preserve the normal correlation/error envelope. No balances, versions, receipts, events, audit rows or ledger entries are written by a read.

## Deployment

The additive `FinanceService.ListFundHistory` RPC is Gateway-only, with the existing caller secret and a 2-second deadline. Catalog: 113 RPCs, 19 events. Existing loopback/non-production transport restrictions apply.

Apply Finance [V003](../../apps/finance-service/migrations/V003.sql) after V001/V002 with the normal checksum-verifying migration runner, then deploy Finance and Gateway/contracts together. V003 adds `finance_audit_history_idx(fund_id, occurred_at DESC, id DESC)`; no model table or FK is added. Finance readiness requires all three migrations. Index creation takes the normal transactional PostgreSQL index lock; schedule rollout accordingly on a populated database. Existing migrations/checksums are immutable. No development or shared database was migrated by this feature's isolated tests.

## Verification

`corepack pnpm finance:history:test` runs a disposable PostgreSQL/Identity/Trip/Finance/Gateway stack. The same scenarios are included in `corepack pnpm finance:test`, which is already a CI job. Tests cover real command audit, exact cursor ordering, privacy, no write effects, current membership/lifecycle, malformed inputs/rows, internal caller authentication, SQL lock/deadline and Trip outage recovery. Unit tests cover second access-check revocation and protobuf default-field omission. Database tests verify V003 readiness and the index. Local results are recorded separately from remote CI or load acceptance.

Local verification on 29 October 2026 (main37a4b57 plus this change): build/lint, 1,912 unit tests in 126 files, 20 focused history integration groups, 129 full Finance groups and all 13 regression phases pass. The remaining suites cover database29, Finance inbox61, Identity27, Trip39, invitations19, membership19, Price Watch12, Notification7 and outbox10. Contract lint/reproducibility/compatibility against37a4b57 and the isolated seven-app launcher pass. This is local Windows evidence; remote CI and live providers were not exercised.
