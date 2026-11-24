#!/usr/bin/env bash
# Prepared content-only rollout: keep production gateway/configuration bytes intact.
set -Eeuo pipefail
umask 077
runtime=/opt/nihongo
version=1.11.4
expected_old=sha256:9083a42dd4f5dfc880e6d7790fa0f5fde2ac7eaaa5b6c3950cf3052ebe23811f
[[ $(id -u) == 0 ]] || exit 1
cd "$runtime"
[[ -d server-data && ! -L server-data && ! -L .update.lock ]] || exit 1
exec 9>.update.lock
flock -n 9 || { echo 'Another update is running.' >&2; exit 1; }
compose() { docker compose --project-directory "$runtime" -f "$runtime/compose.yaml" "$@"; }
compose config --format json | node -e '
const fs=require("fs"),path=require("path"),c=JSON.parse(fs.readFileSync(0,"utf8")),m=c.services?.app?.volumes?.filter(v=>v.target==="/app/data")||[];
if(c.services?.app?.image!=="nihongo-web:local"||!c.services?.caddy||m.length!==1||m[0].type!=="bind"||path.resolve(m[0].source)!=="/opt/nihongo/server-data")process.exit(1);'
app_id=$(compose ps -q app)
caddy_id=$(compose ps -q caddy)
[[ -n "$app_id" && -n "$caddy_id" ]] || exit 1
old_image=$(docker inspect --format '{{.Image}}' "$app_id")
[[ "$old_image" == "$expected_old" ]] || { echo 'Running image changed; deployment stopped.' >&2; exit 1; }
docker inspect "$app_id" | node -e '
const fs=require("fs"),c=JSON.parse(fs.readFileSync(0,"utf8"))[0],m=c.Mounts.filter(v=>v.Destination==="/app/data");if(m.length!==1||m[0].Type!=="bind"||m[0].Source!=="/opt/nihongo/server-data")process.exit(1);'
new_image=$(docker image inspect --format '{{.Id}}' "nihongo-web:v$version")
[[ "$new_image" =~ ^sha256:[0-9a-f]{64}$ && "$new_image" != "$old_image" ]] || exit 1
[[ $(docker run --rm --network none --read-only --tmpfs /tmp --entrypoint node "$new_image" -p 'require("./package.json").version') == "$version" ]] || exit 1
# The full old image has already been exported and verified on the deployment host.
[[ ${OLD_IMAGE_ARCHIVED:-0} == 1 ]] || { echo 'Verified old-image archive required.' >&2; exit 1; }
docker tag "$old_image" nihongo-web:rollback-20261122-v1.11.4
available_kb=$(df -Pk "$runtime" | awk 'NR==2 {print $4}')
source_kb=$(du -sk server-data | awk '{print $1}')
(( available_kb > source_kb + 150000 )) || { echo 'Insufficient free space for complete data backup.' >&2; exit 1; }
backup=$(mktemp -d /opt/nihongo-backup-v1114-XXXXXXXX)
printf '%s\n' "$old_image" > "$backup/old-image.txt"
printf '%s\n' "$new_image" > "$backup/new-image.txt"
sha256sum .env compose.yaml deploy/Caddyfile > "$backup/config-before.sha256"
writers_stopped=false
failed() {
  code=$?; trap - EXIT
  if (( code != 0 )) && "$writers_stopped"; then
    compose stop caddy app || true
    printf 'UPDATE_FAILED: gateway closed; current learning data preserved. Backup: %s\n' "$backup" >&2
  fi
  exit "$code"
}
trap failed EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
printf 'UPDATE_START v%s\n' "$version"
writers_stopped=true
compose stop caddy app
# SQLite, WAL, credentials, configuration and recordings stay on this private host.
tar -czf "$backup/data-and-config.tar.gz" server-data .env compose.yaml deploy/Caddyfile
tar -tzf "$backup/data-and-config.tar.gz" >/dev/null
sha256sum "$backup/data-and-config.tar.gz" > "$backup/data-and-config.sha256"
audit() { docker run --rm --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,mode=1777 -e DATA_DIR=/app/data -v "$runtime/server-data:/app/data:ro" --entrypoint node "$new_image" scripts/check-progress-integrity.mjs; }
audit > "$backup/progress-before.json"
docker tag "$new_image" nihongo-web:local
compose up -d --no-build --pull never --no-deps --wait --wait-timeout 180 app
[[ $(docker inspect --format '{{.Image}}' "$(compose ps -q app)") == "$new_image" ]]
compose stop app
audit > "$backup/progress-after.json"
cmp "$backup/progress-before.json" "$backup/progress-after.json"
sha256sum -c "$backup/config-before.sha256" >/dev/null
compose up -d --no-build --pull never --no-deps --wait --wait-timeout 180 app
compose exec -T app node scripts/check-release-auth.mjs "$version"
[[ $(compose ps -aq caddy) == "$caddy_id" ]]
compose start caddy
writers_stopped=false
printf 'UPDATE_OK v%s\nHistorical data and configuration verified. Backup: %s\n' "$version" "$backup"
