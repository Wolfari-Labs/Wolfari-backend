# Finance outbox publication

Finance business writers already insert events in the same transaction as their local effects. This relay publishes those committed rows from finance_db to RabbitMQ. It does not deliver notifications, run reminder schedules or write financial business state.

## Source contract and rollout

The implementation follows [SRS 2.3](../Wolfari_SRS_v2.3_ChinhThuc.docx) sections 9.1-9.2 and [DDL/API/Event 1.1](../Wolfari_DDL_API_Event_Specification_v1.1_ChinhThuc.docx) section 7.1, the existing Finance V001 outbox schema, [event catalog](../../packages/contracts/catalog/events-v1.json) and [topology](../../packages/contracts/catalog/topology-v1.json). No migration, event type or protobuf change is required.

Only ContributionRequested, ContributionUpdated, ClosureRequested, ClosureCancelled and FinanceClosed may be published. Each stored envelope must pass the strict producer validator, including producer=Finance, Fund identity/version and payload invariants. The relay preserves event_id, occurred_at (including PostgreSQL microseconds), aggregate version, causal/operation identifiers and payload. Sibling events and explicit closure reminders can share a Fund version; the relay never coalesces them by version.

FINANCE_OUTBOX_ENABLED defaults to false and requires the literal value true to start the background worker. Existing Finance integration suites retain disabled publication. The relay asserts the durable topic exchange wolfari.events.v1 only. It does not provision or change consumer queues or bindings.

The [Finance inbox consumer](finance-notification-inbox.md) owns a dedicated queue for ContributionRequested, ClosureRequested and ContributionUpdated Holder review, checking current Finance/Identity state before in-app creation. Closure reminders share a per-user/source 24-hour limit. Other Finance event consumers remain pending. Catalog bindings are not proof of deployed topology. Current AccountEmail uses a separate queue. Keep this worker disabled in shared development/release environments until all intended durable Finance bindings and compatible consumers are provisioned and accepted. The outbox-only isolated test uses its own capture queue and no Automation, SMTP or push process; the separate Finance notification test exercises the three supported event projections. ContributionUpdated reminder rescheduling and terminal event consumers remain separate.

## Claim, publish and recovery

1. Atomically claim one due PENDING row using FOR UPDATE SKIP LOCKED. Assign a fresh UUID claim token, a 30-second lease and a saturating attempt counter. Broker work happens after this SQL statement commits.
2. Validate the stored event before sending. Invalid schema/type/producer/payload becomes retained FAILED with the generic INVALID_EVENT reason. The invalid payload is never published to a broker or DLQ and is never logged.
3. Send one persistent, mandatory message using event_id as messageId. Await the confirm callback and separately handle matching basic.return. A mandatory return is a failure even when the broker subsequently sends a positive acknowledgement. The publish() boolean is buffer pressure, not delivery success.
4. Mark PUBLISHED only with a matching event ID, current fresh token, attempt count, PENDING status and unexpired lease. Expired or superseded workers cannot complete or reschedule the current claim.
5. Retry transient errors at 10 seconds, 30 seconds, 2 minutes, 5 minutes and then 15 minutes, capped at 15 minutes indefinitely. A vanished process leaves a lease that another worker can reclaim. Database failure after a successful confirm also remains recoverable with the original event identity.

The consumer five-retry limit in SRS is not a producer exhaustion requirement. Indefinite capped transient retry is the operational policy chosen for this relay; it prevents a broker outage from automatically exhausting an unpublished financial event. No unresolved or published outbox rows are purged in this checkpoint; the broader retention decision remains separate.

Each process runs one batch at a time and claims at most 10 rows sequentially per tick. The poll interval is 1 second. Each claim receives its own lease rather than sharing an expiring batch lease. Connection/channel/exchange setup is bounded to 5 seconds, with a 2-second socket handshake timeout, and publisher confirmation is bounded to 5 seconds. AbortSignal closes the underlying Node socket on timeout, disconnect, broker blocking or shutdown. Database operations borrow a connection from the existing bounded pool and apply a 5-second client query timeout to every outbox statement. Failed or timed-out borrowed connections are destroyed, including an interrupted replay transaction. Shutdown stops new claims, cancels undecided broker work and waits for that bounded worker operation.

A crash after broker acceptance but before the SQL acknowledgement can produce a duplicate with the same event_id. This is at-least-once publication, not exactly-once notification delivery. Confirms establish broker acceptance; they do not prove consumer processing, user delivery, every intended binding, or replicated broker availability. Ordering across concurrent workers or retries is not guaranteed. Consumers must deduplicate by event_id, tolerate reordering and validate current source/account/preference state before dispatch.

## Configuration, diagnostics and replay

corepack pnpm env:init supplies missing Finance RABBITMQ_URL and FINANCE_OUTBOX_ENABLED=false while preserving existing values. The change adds broker configuration only to Finance; existing Identity/Trip/Automation settings remain unchanged. Do not store real credentials in templates or tracked files.

GET /health/dependencies reports only enabled, broker up/down and pending/failed counts with Cache-Control: no-store. It does not expose event bodies, IDs, financial details or connection URLs. Database readiness/liveness semantics remain unchanged, and an unavailable broker does not roll back a financial transaction.

Build the current checkout before using the local replay command. For a reviewed, valid FAILED row, an operator can run:

```powershell
corepack pnpm build
corepack pnpm finance:replay-outbox --event-id <uuid> --reason <ticket>
```

The local-only command checks the Finance role/database, explicit UUID, reason and FAILED/unclaimed state. It locks and revalidates the stored event, then resets only delivery bookkeeping. It preserves the original identity, payload and occurrence. It does not replay PUBLISHED records, manufacture new events or repair invalid payloads; invalid contracts require a reviewed producer/contract correction first. No replay is executed automatically.

## Verification

Run corepack pnpm finance:outbox:test for isolated PostgreSQL and RabbitMQ verification. The suite uses the repository's pinned RabbitMQ image and an owned durable capture queue, without sending user messages. Focused unit tests cover confirm/return/nack behavior, lost confirms, setup/shutdown deadlines, strict envelope checks, claim fencing, retries, replay and disabled startup. Existing Finance/database suites verify that default-disabled publication preserves prior behavior.

Local verification on 25 October 2026: 115 unit-test files / 1,643 tests pass; the real outbox suite passes 10 groups, full Finance passes 122 groups, and database integration passes 28 groups. Workspace build/lint, contract reproducibility/compatibility and source/document formatting pass. The final transport declaration cleanup was rechecked with all 18 transport/socket tests. All owned Docker fixtures were removed. A new isolated CI job is defined, but this local change has not been published or checked by remote CI.

## Primary references

- [RabbitMQ publisher confirms](https://www.rabbitmq.com/docs/confirms): mandatory returns precede their confirms; positive confirm and consumer acknowledgement have different meanings.
- [RabbitMQ reliability guide](https://www.rabbitmq.com/docs/reliability): uncertain confirms require retransmission and can duplicate; mandatory routing establishes at least one queue.
- [RabbitMQ queues](https://www.rabbitmq.com/docs/queues): durable topology and persistent messages are both required for broker restart recovery.
- [Node 24 sockets](https://nodejs.org/docs/latest-v24.x/api/net.html#new-netsocketoptions): AbortSignal destroys the socket; amqplib forwards its own socket options to Node. Tests use the installed adapter and a local stalled TCP handshake to verify actual closure.
- [amqplib channel API](https://amqp-node.github.io/amqplib/channel_api.html): publish() is not a Promise; confirm callbacks and return handlers are separate from backpressure.

References checked 25 October 2026. Live RabbitMQ documentation shows 4.4; the integration fixture verifies the repository's pinned 4.3.5 image. These sources explain the protocol; local verification establishes this implementation's behavior and does not claim notification delivery or production readiness.
