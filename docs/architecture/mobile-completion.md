# Mobile lifecycle, personal reminders and Plan PDF

Implementation and external setup are described in the sibling mobile `docs/mobile-completion.md`.

- New public routes are documented by `docs/api/mobile-completion.openapi.json`.
- Trip-only ownership/archive/delete mutations keep the Trip row lock through a Finance state-only read. No new Finance command can begin until the mutation finishes. Archive/delete require absent or CLOSED Fund. Transfer preserves Holder, checks ACTIVE target identity and blocks closing/handover or outstanding operations.
- Historical initiator receipts are readable after transfer/delete; all writes keep the same operation key on recovery.
- `GetAutomationContext` is implemented for current ACTIVITY/PACKING sources, authorized for Automation only.
- Automation V007 adds personal reminder context and indexes. Apply with `pnpm db:migrate`; original baseline files are unchanged.
- Set `REMINDER_WORKER_ENABLED=true` for the personal scheduler. Set `PUSH_DELIVERY_ENABLED=true` with server-only `EXPO_PUSH_ACCESS_TOKEN` after native Firebase/APNs credentials and Expo enhanced push security are configured. Both flags default false.
- New workers use PostgreSQL leases; RabbitMQ remains required by the existing source consumers/outbox, not by direct personal reminder delivery.
- The push worker sends generic lock-screen text, rechecks account/Trip/device/preferences, tracks tickets and receipts, retries bounded temporary failures, and deactivates DeviceNotRegistered tokens. At-least-once provider submission may duplicate a push after an ambiguous network failure; inbox creation is deduplicated.
- PDF is on-demand PLAN-only. It uses a repeatable-read snapshot and embedded OFL Nunito font, limits records/bytes/concurrency, rechecks current membership after rendering and returns private/no-store bytes. It does not activate the future asynchronous Export Worker or Finance export.
- Existing private expense receipt API is reused by mobile for image/PDF viewing and sharing. MinIO remains private; no bearer token is placed in a file URL.

Run `pnpm mobile:completion:test` for isolated Gateway/Identity/Trip/Finance/Automation/PostgreSQL coverage, including real reminder timers, lifecycle rollback and private PDF. Expo HTTP is fixture-only in that test; do not call it proof of device push delivery. Backend CI runs this suite and uploads the test Plan PDF. Run lint, full tests and contracts checks before merging.
