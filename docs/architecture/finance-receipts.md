# Finance receipts — API105/106

API105 uploads a private temporary document; API106 downloads a document only after a
Finance business record has bound it. This milestone does not report or confirm a
contribution, post a ledger entry, or implement expense submission. Business bindings
in integration tests are explicit fixtures for those future writers.

The implementation follows SRS2.3 / DDL API Event1.1 and the approved receipt scope
of 2026-10-15. `finance_files` is an implementation extension to the baseline ERD;
it is introduced by Finance V002, without modifying V001 or claiming other pending
decisions are settled. The API description is in
[finance-receipts.openapi.json](../api/finance-receipts.openapi.json).

## HTTP behavior and permissions

| Endpoint                                                       | Behavior                                                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/funds/{fund_id}/receipts`                        | One multipart field `file`; returns 201 with `data: {object_key,mime_type,size_bytes}` and correlation metadata. |
| `GET /api/v1/funds/{fund_id}/receipts/download?object_key=...` | Returns binary content with attachment disposition, `private, no-store` and `nosniff`.                           |

Both require an Identity session and current Trip membership. Cookie uploads use the
existing Gateway CSRF check. Actor identity comes from the session, never form/query
fields. Unknown/duplicate query fields, additional form fields/files and GET bodies
are rejected. Unsupported methods return 404. Invalid input returns 400, missing
session 401, absent/inaccessible resource 404, upload state conflict 409 and unavailable
dependencies/capacity/integrity failures 503. Errors do not contain object keys or bytes.

Upload checks active Trip at request authorization and OPEN Fund under a local lock
before staging metadata. Staging does not change `finance_version`, balance, command
receipts, audit, ledger or outbox. A later business attachment must use that business
operation's current Trip guard and Fund transaction; this staging check is not a
durable authorization to mutate Finance later.

- Unbound files cannot be downloaded, including by their uploader. The UI previews
  the local file before submission.
- Contribution evidence is readable only by its contributor or the **current Holder**,
  and only while the viewer remains a Trip member. Owner has no separate override.
- Expense documents are readable to current members for an existing, non-deleted
  expense. The original relation remains after the current receipt field is replaced.
- Archived Trips and closed Funds retain read access for current members; uploads
  are blocked. A raw key, namespace match or public Trip link grants no access.

## Validation and transport limits

JPEG, PNG and PDF are limited to **10MiB (10,485,760 bytes)**, inclusive. The server
checks actual bytes, magic and decoder/parser output; filenames are discarded.
Images are decoded with a 10-million-pixel limit and one frame. PDFs must parse,
contain 1–1,000 pages and not require decryption. Parser work has a five-second budget
in a worker with a 128MiB JavaScript heap limit; that heap limit is not a bound on
all native decoder memory. Original bytes, including embedded metadata, are retained
with their SHA256. This is structural validation, not a malware scanner.

The Gateway caps multipart bytes at file limit + 64KiB and reading time at 15 seconds.
Gateway and Finance each admit at most two active file operations per instance and
reject additional work with 503. There is no unbounded request queue. Two new unary
RPCs use bytes, a 30-second deadline and 12MiB message limits. Only the dedicated
Gateway file client has these larger limits; the existing Finance client retains
its default 4MiB receive bound. No base64 or internal HTTP file bypass is introduced.

Client disconnect cancels gRPC. Finance forwards cancellation/deadline to validation
and storage HTTP requests; SQL already in progress may finish. Such an interrupted
upload can leave only temporary metadata/object state. Each storage HTTP request has
a ten-second wall-clock limit. Downloads verify size and SHA256 before responding;
the bounded unary transfer is buffered, not end-to-end streaming from MinIO.
The HTTP body is binary, not a signed/public URL. Retry of an upload may create a new
temporary file: API105 does not promise idempotent upload replay.

Parser references: [Busboy limits and truncation](https://github.com/mscdex/busboy),
[pdf-lib load options](https://pdf-lib.js.org/docs/api/interfaces/loadoptions).

## Storage, attachment and cleanup

Bucket `wolfari-finance-receipts` is private and separate from Identity avatars.
Keys contain Fund ID, random UUID and SHA256, with a server-selected extension.
Finance owns both the metadata and download decision. Existing unregistered raw keys
are not automatically backfilled or granted access.

Upload inserts `UPLOADING` before PUT, then marks `READY` only after successful PUT.
There is no distributed SQL/MinIO transaction. A failed PUT, lost finalization or lost
HTTP response leaves a discoverable temporary row. Binding records exactly one
contribution or expense through same-Fund foreign keys. Identity, content metadata
and existing binding are immutable; SQL deletion is prohibited. Replacing the current
business evidence key never removes the older binding.

Future business writers must:

1. Resolve the temporary metadata by Fund, key and uploader; verify storage content
   before opening the business transaction (`ReceiptService.prepareAttachment`,
   which calls `ReceiptStorage.verify`).
2. Acquire the business Trip guard and Fund lock, then call `ReceiptRepository.bind`
   in the same SQL transaction as the business record/evidence update.
3. Recheck uploader, READY/unbound state and same-Fund target. The binding helper
   takes the Fund lock again safely and then the file lock; do not reverse this order.

Only unbound objects expire, after 24 hours. The worker runs every minute and claims
up to 20 candidates per pass under Fund → file locks. A claim irreversibly changes
the row to `DELETING`; attachment then fails. If attachment wins, cleanup rechecks
the row and skips it. No MinIO call occurs inside that SQL transaction.

Deletion tombstones are retained and revisited after one hour, even after a successful
DELETE. This removes an object written late by an uploader that crashed after a prior
cleanup pass. Storage failure also remains retryable. This policy trades small retained
metadata rows and repeated DELETE calls for crash recovery; it does not define long-term
metadata retention or guarantee deletion at exactly hour 24 under backlog/outage.
Bound history is never automatically purged. No 30/90-day receipt/outbox retention
policy changes are part of this migration.

## Local setup and verification

After reviewing configuration, the developer runs:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm env:init
corepack pnpm infra:up
corepack pnpm db:migrate --service finance
corepack pnpm db:status --service finance
corepack pnpm finance:test
```

`env:init` adds missing MinIO settings to Finance without replacing existing values.
Finance readiness now requires V001 and V002. The development database is not
automatically migrated by code editing; the integration harness migrates its own
isolated databases. Existing internal gRPC remains loopback/test only; production
TLS/provider integration is outside this milestone.

Tests cover real HTTP/gRPC/PostgreSQL/MinIO upload/download, exact 10MiB PDF, malformed
multipart/content, private bucket, Self/Holder/expense permissions, revoked membership,
replacement history, archive/closed states, cleanup-versus-attachment and late PUT,
storage corruption and Trip failure. Unit tests cover parser cancellation, capacity
and failed staging/finalization. No SQL fixture should be described as a completed
manual-contribution or expense API.
