# Notification account eligibility

Identity.GetNotificationEligibility is a read-only internal RPC for Automation. It provides the current account check needed before Finance notifications are made available or sent. It does not grant Trip access, establish that a financial action is still pending, create a notification, or enable a sender.

## Requirement and implementation convention

[SRS 2.3](../Wolfari_SRS_v2.3_ChinhThuc.docx), FR-AU01 and section 9.2, requires valid recipient accounts and current source authorization before dispatch. The existing Finance.GetAutomationContext resolves eligible source recipients and Trip membership, but does not inspect Identity account state. GetProfiles returns profile data without account state and is not authorized for Automation. GetInvitationIdentity is restricted to Trip and also exposes email. A background consumer has no end-user access token for ValidateSession.

This additive method supplies that missing dependency without widening the existing profile or invitation lookup callers. The exact RPC name, bounded batch, boolean projection and conservative deletion-timestamp check are implementation conventions introduced for this change and require normal contract review; they are not quoted as existing methods in the source specification. No schema, event, migration, REST route or new credential is introduced.

## Request, response and account rules

The request contains user_ids, with 1 to 100 raw entries. Every entry must be a UUID with supported version and variant, without whitespace. IDs are normalized to lowercase and duplicates removed in first-occurrence order. The raw bound applies before deduplication, so a large repeated list is rejected. Empty or invalid lists fail with INVALID_ARGUMENT before querying Identity.

The response contains recipients, with exactly one {user_id, eligible} record for every unique normalized requested ID. Eligibility is true only when users.status is ACTIVE and both deletion_requested_at and anonymized_at are null. Missing, LOCKED, DELETION_PENDING and ANONYMIZED accounts are indistinguishably false. The timestamp guard also excludes inconsistent records whose status was reset without clearing deletion state. Email verification is not an additional condition: the source allows ACTIVE accounts before email verification.

The query selects only IDs. Neither the query projection nor response includes email, display name, avatar, account-status reasons, credentials, tokens or financial information. A database failure is UNAVAILABLE, not a successful all-false or empty audience. No result is cached across requests.

## Authorization and deadlines

Only Automation may invoke the new method using its existing AUTOMATION_IDENTITY_SECRET. Exactly one caller, service-secret and UUID correlation metadata value is accepted; duplicated or ambiguous authentication metadata is denied. Other services remain denied even when they supply their own valid credentials. Existing RPC authorization lists are unchanged.

The shared Identity client applies the catalog's two-second deadline and supports a caller's shorter remaining deadline. The read has a local 1.5-second budget. Pool acquisition retains the existing bounded connection timeout; after acquisition, an expired local budget causes failure before SQL. The query uses the remaining budget as a client query timeout and discards failed connections. Pool waiting can still finish after the caller's deadline; this change does not claim instantaneous distributed cancellation. There is no network call or write transaction in the handler.

As with the current internal clients, local integration uses existing transport settings. This checkpoint does not establish production TLS or rate-limit acceptance.

## Consumer integration boundary

A later Finance consumer must combine current Finance source context with this account check, fail closed on either dependency failure, and revalidate near actual delivery. The observations do not form a cross-service atomic transaction and cannot revoke a message already accepted by a provider.

In-app notifications remain available when a user disables push/email, as explicitly required by FR-AU01. Channel preferences govern later push/email delivery; they must not be treated as an inbox opt-out. Durable inbox deduplication, Finance queue consumption, reminder scheduling and external delivery are separate checkpoints. Existing Finance outbox publication remains disabled by default.

## Verification

Focused unit coverage checks malformed inputs, raw batch limits, normalization and ordering, minimal projections, denied callers and ambiguous metadata, database errors, deadline exhaustion and connection cleanup. The isolated Identity integration fixture exercises actual PostgreSQL and gRPC, account transitions, caller isolation, minimal wire responses and no Identity writes. It runs as part of corepack pnpm identity:test and the existing identity-integration CI job.

Local verification on 25 October 2026: all 1,727 unit tests in 118 files pass, including 77 focused Identity service/controller cases. The full Identity integration suite passes 27 groups, including eight new eligibility groups; successful and rejected reads preserve fingerprints across all eight Identity tables. Workspace build/lint, contract lint, generated-source reproducibility and backward compatibility against parent 16c6b4a pass. Scoped formatting and whitespace checks pass. The isolated test project was cleaned and verified to have no remaining containers, volumes or networks.

The initial integration attempt stopped before Docker because the new fixture resolved proto-loader from the Identity package instead of its owning contracts package. The corrected fixture passed the complete second run without adding dependencies. Test evidence and failure history remain local. Earlier PR checks do not cover this unpublished additive method; the existing identity-integration CI job will run it after owner publication.

## References

- The existing [Identity protobuf](../../packages/contracts/proto/wolfari/identity/v1/identity.proto) and [RPC catalog](../../packages/contracts/catalog/rpc-v1.json) define the exact method, caller and response.
- [gRPC deadlines](https://grpc.io/docs/guides/deadlines/) distinguishes a client's deadline from the application's responsibility to stop ongoing work.
- [node-postgres client options](https://node-postgres.com/apis/client) documents client query timeouts separately from server statement timeouts.
- [Protobuf evolution](https://protobuf.dev/programming-guides/proto3/#updating) describes additive message evolution. Existing field numbers remain unchanged; compatibility is checked against the parent commit.
