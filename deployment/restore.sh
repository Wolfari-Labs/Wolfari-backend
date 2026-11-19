#!/usr/bin/env bash
# Only on a NEW isolated recovery VM with outbound SMTP blocked and apps not installed/enabled.
set -euo pipefail
umask 077
if [[ ${EUID} -ne 0 || $# -ne 3 || "$3" != RESTORE_EMPTY_TRIAL ]]; then
  echo 'Usage: sudo bash deployment/restore.sh /absolute/backup.age /absolute/age-key.txt RESTORE_EMPTY_TRIAL' >&2; exit 2
fi
[[ "$1" = /* && "$2" = /* && -f "$1" && -f "$2" ]] || exit 2
[[ ! -e /etc/wolfari && ! -e /etc/wolfari-restored ]] || { echo 'Config exists; refusing overwrite.' >&2; exit 3; }
[[ -z $(docker ps -aq --filter label=com.docker.compose.project=wolfari-trial) ]] || { echo 'Trial containers exist; use a fresh recovery VM.' >&2; exit 3; }
for volume in wolfari-trial_postgres_data wolfari-trial_rabbitmq_data wolfari-trial_minio_data; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then echo 'Trial volume exists; refusing overwrite.' >&2; exit 3; fi
done
command -v age >/dev/null
# Scratch is private; failed restore retains evidence and does not start any services.
scratch=$(mktemp -d /var/tmp/wolfari-restore.XXXXXXXX)
age -d -i "$2" -o "$scratch/backup.tar" "$1"
python3 - "$scratch" <<'PY'
import pathlib, sys, tarfile
scratch = pathlib.Path(sys.argv[1])
with tarfile.open(scratch / 'backup.tar') as archive:
    members = archive.getmembers()
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] not in {'postgres','rabbitmq','minio','config'}:
            raise SystemExit('Unsafe archive path')
        if member.issym() or member.islnk() or member.isdev():
            raise SystemExit('Links/devices are not supported in this trial backup')
    def safe_owned(member, destination):
        checked = tarfile.data_filter(member, destination)
        return checked.replace(uid=member.uid, gid=member.gid, uname=None, gname=None)
    archive.extractall(scratch / 'data', members=members, filter=safe_owned)
PY
for name in postgres rabbitmq minio; do
  [[ -d "$scratch/data/$name" ]] || exit 4
  docker volume create --label com.docker.compose.project=wolfari-trial --label "com.docker.compose.volume=${name}_data" "wolfari-trial_${name}_data" >/dev/null
  destination=$(docker volume inspect --format '{{.Mountpoint}}' "wolfari-trial_${name}_data")
  [[ "$destination" = /var/lib/docker/volumes/wolfari-trial_*_data/_data ]] || exit 4
  cp -a -- "$scratch/data/$name/." "$destination/"
done
[[ -f "$scratch/data/config/trial-instance.json" ]] || exit 4
cp -a -- "$scratch/data/config" /etc/wolfari-restored
echo "RESTORED OFFLINE. Private scratch retained at $scratch; remove only after validation."
echo 'Review manifest/pinned images and owner UIDs. Do not start apps or SMTP. Config is /etc/wolfari-restored, not active.'
echo 'Validate recovery, install config with restricted permissions, then explicitly approve writers/email delivery.'
