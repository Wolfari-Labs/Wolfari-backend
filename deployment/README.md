# Single-host trial deployment

Primary operator runbook: `../../HUONG_DAN_DEPLOY_WOLFARI_GOOGLE_CLOUD.md` at the PBL6 workspace root (outside both Git repositories). Keep a copy with your release handoff.

This profile is an explicit single-host trust boundary, not a TLS/mTLS implementation: Node services bind loopback, internal credentials stay mandatory, and only Caddy exposes HTTPS. Remote plaintext endpoints are rejected. Public helpers remain disabled by `NODE_ENV=production`. Do not enable the profile on a multi-host/container-per-app topology.

`trial:init` requires a new absolute directory and never overwrites one. Complete SMTP and registration allowlist before `trial:check`. The CLI defaults to `/etc/wolfari`; `WOLFARI_CONFIG_DIR` may select a disposable test configuration. All seven services run as the same restricted OS account in this bounded trial, so this is not OS-user-level isolation between service secrets.

`trial:check` validates config, paired secrets and migration checksums; it does not prove a running database, SMTP delivery, private objects, VM firewall or public TLS. `trial:health` checks existing application readiness endpoints. Never run destructive integration tests against trial/user data.

Keep `/etc/wolfari/.env` (infrastructure admin credentials) root-owned mode0600; operator preflight/migrate/storage/Compose run as root. App configs and marker use root:wolfari0640, directories0750. App startup validates only its own config/marker and never needs the infrastructure env. App processes still share one OS account, so cross-app secret access is not OS-isolated.

`trial-storage.mjs PROVISION_TRIAL_STORAGE` creates private buckets and applies scoped app users using an operator-installed `mc`. It may reapply the trial users' passwords from the config. Only run it intentionally on this dedicated trial instance. No password is printed, but the short-lived mc process arguments are visible to privileged local users.

## Dependency changes

- Nest platform Express patched within major11, body-parser2.4, Sharp0.35.5, Nodemailer10.5; no Nest major12 migration.
- Scoped query-string7 patch reads the ESM default of decode-uri-component0.5.1 on Node24. Retains MinIO8's query-string namespace API rather than replacing it with query-string9. A real MinIO client signature test and parsing regression exercise this adapter; network storage integration remains a separate gate.
- `stream-json`1.x comes from MinIO8; upstream patched3.x changes API/module packaging. Do not force-upgrade across majors just to hide audit warnings. Record remaining advisories and test actual exposure before broader public use.

## Recovery safety

Cold backup stops all writers and infrastructure, then encrypts all three volumes and config/keys directly into an age file. It deliberately leaves services stopped on failure. Plan a short maintenance window. Keep the age private key outside the server and store the encrypted backup off-host. The timer does not upload or automatically delete old backups: confirm off-host copies before retaining only seven local backups.

Restore is **fresh recovery VM only**, refuses existing trial config/containers/volumes, preserves numeric owners, rejects archive links/devices/path traversal and never starts apps. It retains private scratch for troubleshooting (contains secrets; securely remove the exact scratch after validation). Configure outbound SMTP blocked before recovery; do not restart email consumers until reviewing queued events and approving delivery. Restore the same pinned container images/source and verify before accepting traffic. Restore rootful Docker default data-root `/var/lib/docker` only; custom data-root is deliberately rejected.

The shell scripts, systemd and Caddy files are deployment candidates until Linux/runtime checks and restore rehearsal pass. Local unit/static tests do not imply those gates passed.
