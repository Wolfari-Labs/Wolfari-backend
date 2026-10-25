# Financial Notes (API107–110)

Financial Notes record shared trip activities without moving money in Wolfari. A note belongs to one enabled Fund and can optionally carry a non-negative VND amount and a current Trip member as payer. The amount is informational: create, update and delete never insert a ledger row, change Fund balance, reserve a refund, or create an expense/contribution.

`GET /api/v1/funds/{fund_id}/notes` is available to current Trip members, including archived Trips and CLOSED Funds. It returns non-deleted rows in `(created_at, id)` descending order with a Fund-scoped cursor. Mutations require an active Trip, OPEN Fund and no closure lock. Any active member can create. The creator can update/delete their own note; the current Owner can manage another member's note. A newly assigned payer must still be an active member, while a historical payer remains readable after leaving.

Writes use `expected_finance_version`; update/delete also use `expected_version`. An exact PATCH no-op returns the current snapshot without incrementing either version or writing audit. Real changes increment the note version where applicable and Fund `finance_version` exactly once. Delete is soft and returns an Operation.

Commands `CREATE_FINANCIAL_NOTE`, `UPDATE_FINANCIAL_NOTE` and `DELETE_FINANCIAL_NOTE` use the shared Begin/receipt/Complete protocol. Reusing an idempotency UUID with another normalized payload conflicts. Terminal replay rechecks current membership and creator/Owner permission. There is no Notes event or outbox message in the current catalog.

The public contract is [finance-notes.openapi.json](../api/finance-notes.openapi.json). `amount` remains a decimal string at HTTP/gRPC boundaries so signed `int64` values stay exact.
