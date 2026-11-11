# Single-host trial verification — 2026-11-11

Scope: local preparation only. Branch `feat/single-host-trial-deploy`, base `7b59158`. No commit/push/cloud/DNS/secrets/personal demo data changes.

## Evidence

- Node24.19.0 / pnpm10.34.5, Windows: full build (TypeScript), lint and unit gates; 2008 tests in136 files.
- Regression includes production profile fail-closed, loopback URL/target validation, SMTP auth/mandatory TLS/sender, exact registration allowlist, trusted proxy IP, Secure cookies and Origin/CSRF. Gateway HTTP regression uses a mocked upstream, not real Identity/DB.
- Disposable preflight tests cover new-directory refusal, secret generation/pairing, root-infra independence at app startup and mismatched ports. No personal `.env` or database used.
- Runtime dependency audit:0 high/critical/low,3 moderate stream-json advisories via MinIO. Full audit:4 moderate (adds minimatch via ESLint),0 high/critical/low. Audit exits1; not a clean security audit.
- Frozen-lockfile install and migration checksum validation; clean Linux/native installation still unverified.
- Static Compose model: loopback published ports, restart/log limits, project volumes, fixed broker hostname, no default Mailpit. No Docker daemon required for this check.
- Bash syntax: `bash -n` backup/restore through WSL. Runtime backup/restore NOT RUN.
- Source export/extract rehearsal:1602 files, all manifest SHA256 hashes matched, Linux scripts LF; export again after final edits. Working-tree manifest is not a release commit.
- Docker Linux engine became available. Sequential isolated integrations PASS/exit0: database33, Identity27, Trip/Plan39, Invitations19, Members19, Finance129, Finance lifecycle29 groups. Counts overlap; Members uses a Finance protocol fixture, whereas Finance lifecycle runs real Trip + Finance. Real storage/private-upload checks passed; provider payments remain simulated.
- Isolated Chromium acceptance PASS/exit0 in both dev (`20261111124234-658fa3db`) and built preview (`20261111124900-9e4b7090`): one scenario/17 business steps each, no skips/retries. Both source snapshots matched at completion. Backend tree SHA256 at test time: `6bf847b4db209c353296ecc07c34f1989f78bb540f3dde9ed5b67facf7de0de2` (documentation updates below occur after that snapshot).
- These tests use disposable local-profile infrastructure and Mailpit, not the production trial profile/Brevo/public TLS. Test-only MOCK_FLIGHT/Finance notifications/outbox do not change disabled trial defaults. No personal demo stack was started or reset. See Web deployment README for failed-run history and test synchronization fixes.

## Blockers / not run

- Linux systemd verify/install/start/reboot, private MinIO policy behavior, Brevo delivery, real hostname cookie/CSRF/HTTPS and upload NOT RUN.
- Encrypted backup/off-host recovery/numeric ownership/broker recovery/rollback drill NOT RUN. Shell syntax is not recovery evidence.
- Container/OS vulnerability scan NOT RUN. Existing pinned images and source-built MinIO need validation on Linux.
- Local technical G1 checks pass, with moderate-advisory risk review still required. Public launch remains BLOCKED until G0–G3 in the workspace runbook pass. Membership lifecycle integration prerequisite now passes; its trial default remains false until explicitly enabled and tested on the private VM. Finance payments/outbox/notification and MOCK_FLIGHT worker remain disabled.

## Reproduce

From Backend: `corepack pnpm install --frozen-lockfile`, `corepack pnpm build`, `corepack pnpm lint`, `corepack pnpm test --maxWorkers=2`, `corepack pnpm audit --prod`, `corepack pnpm audit`, `node scripts/trial-compose-check.mjs`.

Read `../../HUONG_DAN_DEPLOY_WOLFARI_GOOGLE_CLOUD.md` for operator commands and isolated integration/VM gates. Do not run personal-demo reset or trial migrations against the wrong environment.
