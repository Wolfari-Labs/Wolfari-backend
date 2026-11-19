# Trip dress codes (FR-PL03, API050–053)

Baseline: SRS 2.3 FR-PL03 / AC-PL03 / R03, DDL-API-Event 1.1 `DressCodeWrite`, ERD `dress_codes`.
The original table and `PlanUpdated` change type already existed. Migration V004 adds one optional private reference-image key and scope/index constraints; old rows remain unchanged.

## Endpoints

| API | Route                                             | Permission  | Result                         |
| --- | ------------------------------------------------- | ----------- | ------------------------------ |
| 050 | `GET /api/v1/trips/{trip_id}/dress-codes`         | Member      | `{ items, next_cursor: null }` |
| 051 | `POST /api/v1/trips/{trip_id}/dress-codes`        | Plan Editor | `201` DressCode                |
| 052 | `PATCH /api/v1/trips/{trip_id}/dress-codes/{id}`  | Plan Editor | `200` DressCode                |
| 053 | `DELETE /api/v1/trips/{trip_id}/dress-codes/{id}` | Plan Editor | `200` PlanVersion              |

Writes need `Idempotency-Key` (UUID) and `expected_plan_version`. `GET /plan` returns the same rows and now
includes `capabilities: { dress_codes_write: true }` so clients can tell this server offers the writer;
clients still have to honour `permissions.can_edit`.

## Rules

- Exactly one scope, as in ERD `ck_dress_codes_1`: `TRIP` (no date, no activity), `DAY` (`plan_date`) or
  `ACTIVITY` (`activity_id`). `PATCH` keeps omitted fields, `null` clears, and the merged row must still be
  a valid scope, so switching scope sends the old reference as `null`.
- `DAY`: the calendar day, in the Trip timezone, must intersect `[start_at, end_at)` (AC-PL03).
- `ACTIVITY`: the activity must belong to the same Trip. Deleting an Activity deletes its dress codes
  (existing FR-PL01 behaviour).
- `label` 1–100 characters after trimming; `description` and `public_description` up to 10 000 characters,
  blank stored as `null`.
- New rows are `MANUAL`. Editing keeps the stored `source`; nothing here overwrites a row from a job.
- Archived Trip: `409 STATE_CONFLICT`. Stale version: `409 VERSION_CONFLICT` with the current
  `plan_version` and `export_revision`.
- A changed write raises `plan_version` and `export_revision` once, writes one audit row
  (`DRESS_CODE_CREATED|UPDATED|DELETED`), one `PlanUpdated` outbox event (a tombstone on delete) and one
  receipt in the same transaction. A `PATCH` that changes nothing stores a receipt and keeps the version.
- Replay with the same key and body returns the stored outcome, also after the row was deleted; a
  different body is `409 IDEMPOTENCY_CONFLICT`. Editor access is checked before the receipt is read.

## Not included

- API050 returns one complete page; `limit`/`cursor` are rejected until a Trip can hold enough rows to need them.
- DSS suggestions and Apply (FR-DS03, API068), palettes, and re-validating `DAY` dress codes when Trip
  dates change (BR-TR02 preview) are not part of this change.

## Verification

`scripts/dress-code.test.ts` (validation, permissions, replay, Gateway mapping),
`packages/contracts/src/demo1-openapi.test.ts` (routes and schemas) and
`scripts/dress-code-integration.mjs`, run by `corepack pnpm trip:test` through Gateway, Trip service and
PostgreSQL.

## Optional private reference image

Plan advertises `dress_code_images_write: true`. A Plan Editor uploads one JPEG/PNG via `POST /api/v1/trips/{trip_id}/dress-code-images` (multipart field `file`, max 2 MiB, 20 million pixels, one frame). The service strips metadata, rotates/resizes to at most 1536px and stores a JPEG in a private MinIO bucket. Trip service needs MINIO_ENDPOINT, MINIO_ACCESS_KEY and MINIO_SECRET_KEY.

The response contains only image_id, MIME and size. Pass image_id as `reference_image_id` on the normal versioned create/PATCH; omit to retain or null to remove. An unattached ID belongs to its Trip/uploader and is valid for 24 hours. Unreferenced objects older than 48 hours are cleaned hourly after the first upload. Upload staging alone does not change the Plan.

Members read the bound image using `GET /api/v1/trips/{trip_id}/dress-codes/{dress_code_id}/reference-image`. Current membership is checked each time, including archived reads. The response is JPEG with no-store; Plan/HTTP/protobuf never expose object keys, bucket URLs or tokens. Projection only adds `reference_image_available: true` when attached. An archived historical metadata receipt remains replayable.

Tests: dress-code-image.service.test.ts, dress-code-image-http.test.ts and real Gateway/PostgreSQL/MinIO scenarios in scripts/dress-code-integration.mjs. Mobile covers choose/replace/remove, member viewing after reload and older-backend capability fallback.
