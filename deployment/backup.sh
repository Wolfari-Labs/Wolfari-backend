#!/usr/bin/env bash
# Cold, encrypted snapshot of all volumes + keys. Never run this against another project.
set -euo pipefail
umask 077
if [[ ${EUID} -ne 0 || $# -ne 2 ]]; then
  echo 'Usage: sudo bash deployment/backup.sh /absolute/output.age age1PUBLIC_RECIPIENT' >&2; exit 2
fi
output=$1
recipient=$2
[[ "$output" = /* && "$output" = *.age && ! -e "$output" && ! -e "$output.partial" && "$recipient" = age1* ]] || exit 2
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd -- "$repo"
command -v age >/dev/null
exec 9>/run/lock/wolfari-trial-backup.lock
flock -n 9 || { echo 'Another backup is running.' >&2; exit 3; }
node "$repo/scripts/trial.mjs" check
compose=(docker compose --project-name wolfari-trial --env-file /etc/wolfari/.env -f "$repo/infrastructure/docker-compose.yml" -f "$repo/deployment/compose.trial.yml")
volumes=(wolfari-trial_postgres_data wolfari-trial_rabbitmq_data wolfari-trial_minio_data)
for volume in "${volumes[@]}"; do
  [[ $(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$volume") = wolfari-trial ]] || exit 3
done
image=$("${compose[@]}" images -q postgres)
[[ -n "$image" ]] || exit 3
# Persist image/source manifest inside encrypted config snapshot, never log env values.
mapfile -t containers < <("${compose[@]}" ps -q postgres rabbitmq minio)
[[ ${#containers[@]} -eq 3 && -f "$repo/../release-manifest.json" ]] || { echo 'Missing release manifest or infrastructure containers.' >&2; exit 3; }
node -e 'const fs=require("fs");const cp=require("child_process");const images=cp.execFileSync("docker",["inspect","--format","{{.Name}} {{.Image}}",...process.argv.slice(1)],{encoding:"utf8"}).trim();const release=JSON.parse(fs.readFileSync("../release-manifest.json","utf8"));fs.writeFileSync("/etc/wolfari/backup-manifest.json",JSON.stringify({at:new Date().toISOString(),images,release},null,2),{mode:0o600});' "${containers[@]}"
systemctl stop wolfari.target
if systemctl is-active --quiet 'wolfari@api-gateway' || pgrep -u wolfari -f 'dist/main.js' >/dev/null; then
  echo 'Application writers remain; aborting backup.' >&2; exit 4
fi
"${compose[@]}" stop postgres rabbitmq minio
for service in postgres rabbitmq minio; do
  [[ -z $("${compose[@]}" ps --status running -q "$service") ]] || exit 4
done
# On failure services deliberately stay stopped; investigate before restarting.
docker run --rm --network none --read-only --user 0 \
  -v wolfari-trial_postgres_data:/snapshot/postgres:ro \
  -v wolfari-trial_rabbitmq_data:/snapshot/rabbitmq:ro \
  -v wolfari-trial_minio_data:/snapshot/minio:ro \
  -v /etc/wolfari:/snapshot/config:ro \
  --entrypoint tar "$image" -C /snapshot -cpf - postgres rabbitmq minio config \
  | age -r "$recipient" -o "$output.partial"
mv -- "$output.partial" "$output"
sha256sum -- "$output"
"${compose[@]}" start postgres rabbitmq minio
systemctl start wolfari.target
echo 'Encrypted backup complete; upload off-host and perform an isolated restore drill.'
