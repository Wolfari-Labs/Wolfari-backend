# Membership lifecycle validation

Date: 2026-10-02. Branch: `feat/trip-member-lifecycle`, stacked directly on
`feat/trip-invitations` at `64e32b91a1b4a6b1ae13c5d083b84df63a772b86`.
Results below describe the local, uncommitted implementation diff, not a published
commit or a GitHub Actions run. No commit, push or PR change was made.

## Observed local gates

| Gate                                                               | Result | Evidence / boundary                                                                            |
| ------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------- |
| `corepack pnpm build`                                              | PASS   | All workspace builds                                                                           |
| `corepack pnpm lint`                                               | PASS   | Repository ESLint                                                                              |
| `corepack pnpm test`                                               | PASS   | 389 tests in 25 files                                                                          |
| `corepack pnpm contracts:lint`                                     | PASS   | 42 RPC declarations, catalog/protobuf checks                                                   |
| `corepack pnpm contracts:check`                                    | PASS   | Generated code reproducible                                                                    |
| `corepack pnpm contracts:test`                                     | PASS   | 33 tests in 4 files; included in the 389 above                                                 |
| `corepack pnpm contracts:breaking --against feat/trip-invitations` | PASS   | Additive protobuf compatibility against the stacked base                                       |
| `corepack pnpm db:test`                                            | PASS   | 19 integration groups                                                                          |
| `corepack pnpm identity:test`                                      | PASS   | 19 integration groups on successful retry                                                      |
| `corepack pnpm trip:test`                                          | PASS   | 39 integration groups, including real Planning timeline runtime                                |
| `corepack pnpm trip:invitations:test`                              | PASS   | 19 integration groups                                                                          |
| `corepack pnpm trip:members:test`                                  | PASS   | 19 lifecycle integration groups; Finance protocol fixture, not Finance E2E                     |
| Prettier check on changed source/docs/config                       | PASS   | Generated artifacts checked by contracts:check                                                 |
| `git diff --check`                                                 | PASS   | No whitespace errors                                                                           |
| Official DOCX/database manifests                                   | PASS   | All 14 entries in docs/SHA256SUMS.txt and database SHA256SUMS.txt/SHA256SUMS.forward.txt match |

Final documentation checks also passed: 37 local link targets across docs/README
and the three lifecycle documents; OpenAPI JSON parses with four paths and all 32
internal references resolved. These are structural checks, not a separate full
OpenAPI conformance certification.

These are local results only. Counts are test cases/groups, not a count of
business requirements proven end to end.

## Lifecycle coverage

- Member leave and Owner remove; current database authorization, Owner invariant,
  wrong-Trip/missing/inactive target, outsider/Admin denial and actor spoofing.
- Read and Plan access after commit; GetAccessContext and selected-editor cleanup;
  packing reset, retained activity attribution and historical membership.
- Revision deltas, stale expected revision, same-key replay, conflicting payload,
  initiator-only polling and safe leave replay after departure/rejoin.
- New membership on rejoin, old-invitation cutoff, old accepted-token replay,
  no copied selected-editor grant and old LINK still usable by another user.
- Archived/deleted/closure states; active operation guard; pagination and
  full-precision stable cursor semantics.
- Finance rejection, lost response, malformed receipt; NOT_FOUND followed by
  cancellation; Execute winning before Cancel and cancellation winning first.
- Leave/remove, double remove, grant/remove and accept/remove coordination.
- Real PostgreSQL blocking evidence via pg_blocking_pids for both Plan-first and
  revoke-first races, using the actual Plan mutation endpoint.
- Mandatory audit/outbox/terminal-receipt failure rolls back Trip finalization;
  recovery completes the same operation after Finance already committed.
- Two recovery workers, recovery while new commands are disabled, bounded retries
  to NEEDS_REVIEW, read-only operator dry-run and same-ID manual scheduling.
- Abrupt termination/restart of the harness-owned Trip child after durable T1 and
  Finance COMMITTED; actual background worker recovers after restart.
- Transactional event rows and publication to an isolated RabbitMQ capture queue.
  This proves producer delivery, not production consumer side effects.

## Isolation and diagnostics

Integration suites use uniquely named Docker Compose projects, private databases,
test-only fixture state, isolated broker resources and harness-owned processes.
The final lifecycle project `wolfari-trip-test-fb9ea2790d` and its test resources
were removed by the harness after its successful run. No development database
reset, source DOCX rewrite, baseline migration or checksum change was performed.

The first Identity run could not prepare MinIO because Docker Hub returned a TLS
handshake timeout. That infrastructure attempt failed; the later complete retry
passed all 19 groups. Earlier lifecycle iterations exposed SQL parameter typing
and test synchronization issues; these were corrected before the final successful
run. Neither an infrastructure failure nor a partial attempt is counted as PASS.

## Not run / release prerequisites

| Gate or integration               | Status  | Reason / required next action                                                                                                                                                                                 |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local `corepack pnpm dev:test`    | NOT RUN | Script calls env:init and launches fixed ports/workers using this checkout's environment. Run on a clean disposable checkout/environment; database liveness checks are not equivalent to this launcher smoke. |
| GitHub Actions for this branch    | NOT RUN | Changes are not committed or pushed. A lifecycle integration CI job is added, but no result is claimed.                                                                                                       |
| Real Finance lifecycle E2E        | NOT RUN | Finance Execute/Get/Cancel runtime, obligation rules and durable receipt behavior remain dependencies. The test-only Finance fixture is not that implementation.                                              |
| Shared Finance writer guard E2E   | NOT RUN | Generic Trip BeginFinanceOperation/CompleteOperation and all relevant Finance writers must use the shared protocol before release.                                                                            |
| Automation membership effects     | NOT RUN | Membership consumer/watch/reminder/current-recipient effects are not implemented by this slice.                                                                                                               |
| Export authorization/download E2E | NOT RUN | Requires Export runtime and fresh membership checks.                                                                                                                                                          |
| Location/Packing CRUD E2E         | NOT RUN | Cleanup is checked through database fixtures; those CRUD workflows belong to their modules. Planning timeline runtime is tested, not mocked.                                                                  |

`TRIP_MEMBERSHIP_LIFECYCLE_ENABLED=false` remains the default. This branch is a
validated Trip-side implementation, **not** a declaration that FR-TR05 or the
distributed Finance protocol is production-ready. Recovery stays enabled even
when new lifecycle commands are disabled. Do not enable for real users until the
dependencies above are integrated and validated.

See [design and requirement mapping](trip-member-lifecycle.md),
[handoff and runbook](trip-member-lifecycle-handoff.md) and
[REST contract](../api/trip-member-lifecycle.openapi.json).
