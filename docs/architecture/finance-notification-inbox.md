# Finance contribution notification inbox

Automation consumes `ContributionRequested` and creates generic `AVAILABLE` in-app notifications for the currently eligible debtors. The existing Self inbox API126–131 exposes these rows. This slice does not send push/email, schedule reminders, cancel previously available notices, or handle the other four Finance event types.

## Source and scope

The business baseline is [SRS 2.3](../Wolfari_SRS_v2.3_ChinhThuc.docx), FR-FN02/FR-AU01 and sections 9.1/9.4/9.5, with the ContributionRequested payload in [DDL/API/Event 1.1](../Wolfari_DDL_API_Event_Specification_v1.1_ChinhThuc.docx). Queue names, the consumer name and generic content below are implementation conventions for review, not new assertions of source-document approval. Retention and production acceptance remain open.

The request writer inserts all contributions and their IDs in one Finance transaction. No existing API adds or reassigns debtors within an existing request; new obligations need a new request. Consequently the current request audience is a subset of the original event audience. A later join adds no obligation, and Finance excludes a rejoined membership newer than its old contribution. Revisit this invariant before adding any recipient-editing API. The actor is included when they are also an eligible debtor.

## Processing and privacy

1. Validate the compatible v1 envelope, Finance producer, event type, UUIDs, unique contribution IDs and envelope/payload consistency. Project known fields only. Additive fields never become message content.
2. Check Automation's durable inbox for this event ID. An identical processed event needs no external read; reuse of that ID with a different known-field fingerprint goes to DLQ.
3. Call [Finance.GetAutomationContext](finance-automation-context.md) with `CONTRIBUTION_REQUEST` and the request ID. Accept a current version at least as new as the event, not an older version. No Fund-version deduplication is used.
4. Check [Identity.GetNotificationEligibility](notification-account-eligibility.md) in batches of at most 100. Missing/inactive accounts are excluded. Each response must account for the whole batch; a dependency failure or malformed response retries the entire event.
5. Re-read Finance and compare version, status, recipients and deadline. A changed source retries. Two matching trusted missing-source results, or a stable ineligible/empty source, commit a suppressed inbox result.
6. Atomically insert `inbox_events(consumer_name,event_id)` and all recipient notifications in `automation_db`, then ACK. The per-recipient dedupe key includes the event ID and user ID. SQL failure rolls back both; a lost ACK may redeliver but cannot create a second set of rows.

Finance checks current Trip state and membership. Identity and Finance reads are observations, not a distributed transaction: source/account state can change after a successful check. Every RPC has at most two seconds and the orchestration shares ten seconds. SQL work has a five-second response budget after bounded pool acquisition; a failed/uncertain connection is destroyed. There are no network calls in the SQL transaction and no cross-database SQL.

The notification stores identifiers, type `CONTRIBUTION_REQUESTED`, title `Yêu cầu đóng góp`, and generic text asking the recipient to open the Trip for current information. No amount, account number, request title/note, email or receipt data is copied. No delivery row is created. Push/email preferences do not disable in-app notifications. Existing notices remain history; [Self inbox authorization masking](notification-management.md) still applies on reads. Runtime warnings contain fixed error codes, not payloads, credentials or SQL errors.

## Broker ownership and recovery

The dedicated `wolfari.automation.finance-notifications.v1` queue binds only `ContributionRequested` on `wolfari.events.v1`. Its catalog binding moves out of the general Automation queue; the worker never consumes that general queue. The catalog does not provision or remove previously deployed bindings.

The main queue, `.dlq` and `.retry.0` through `.retry.4` are durable quorum queues. Retry TTLs are 10, 30, 120, 300 and 900 seconds. Retry queues use at-least-once dead lettering with `reject-publish`, routing back to the main queue through the default exchange. Delivery limits are disabled so quorum redelivery does not silently discard a message after repeated lost acknowledgements. A single-node test proves persistence/restart behavior, not replicated high availability.

The header `x-finance-notification-attempt` counts five explicit retries. Invalid contracts/identity collisions go directly to DLQ; dependency/SQL failures go there after exhaustion. Retry/DLQ publication preserves the original body/event ID, uses persistence, mandatory routing and publisher confirms, and ACKs the original only after positive confirmation without a return. An uncertain transfer closes the session and leaves the original unacknowledged. This may duplicate a transfer; the durable inbox prevents repeated notification effects. A unique transfer token correlates concurrent mandatory returns even for the same message ID.

Setup, confirmation, socket handshake and RPC/SQL waits are bounded. Shutdown aborts the broker socket and drains bounded processing. Interrupted work can commit before disconnect is observed; redelivery then resolves through the inbox. There is no purge, automatic poison replay, or promise of global event order.

For operator recovery, inspect the retained DLQ entry and its generic reason, fix the dependency/contract issue, then republish the **unchanged body and event ID**, resetting the retry header. Require confirmed routing before removing the retained entry. No general-purpose replay CLI or shared-environment replay is included in this slice; the isolated fixture verifies same-ID replay. Changing the event identity would bypass the intended deduplication.

## Configuration and acceptance

`AUTOMATION_FINANCE_NOTIFICATION_ENABLED=false` is the default; only literal `true` enables the consumer. Enabled mode needs the existing RabbitMQ URL, Finance/Identity loopback gRPC targets and Automation's own service credentials. Production startup remains blocked until TLS is implemented. No new credential, schema migration, REST endpoint, protobuf method or event payload is added.

Keep shared `FINANCE_OUTBOX_ENABLED` disabled until **all intended Finance event bindings and consumers** are accepted. This new binding covers only ContributionRequested; it does not complete ContributionUpdated, ClosureRequested, ClosureCancelled or FinanceClosed. Existing general bindings, if manually provisioned elsewhere, need an explicit deployment review. No development environment is activated by this change.

Run `corepack pnpm finance:notification:test` for isolated PostgreSQL/RabbitMQ/MinIO plus Identity, Trip, Finance, Automation and Gateway. It covers real API078 → outbox → broker → Self inbox, current source/account suppression, membership changes, more than 100 recipients, preferences off, SQL rollback/concurrency, duplicates, crash after commit before ACK, dependency retry, DLQ/replay and broker restart. Unit tests cover malformed responses, source changes, exact retry/confirm behavior, bounded shutdown and real stalled TCP cancellation. CI has a separate job; local results do not establish remote CI or production acceptance.

Broker semantics were checked against primary [RabbitMQ confirms](https://www.rabbitmq.com/docs/confirms), [dead-lettering](https://www.rabbitmq.com/docs/dlx), [quorum queues](https://www.rabbitmq.com/docs/quorum-queues) and [amqplib channel API](https://amqp-node.github.io/amqplib/channel_api.html). Those live RabbitMQ pages describe 4.4; the isolated fixture runs the repository-pinned 4.3.5 image.
