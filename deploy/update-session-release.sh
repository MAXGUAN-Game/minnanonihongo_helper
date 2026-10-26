#!/usr/bin/env bash
# v1.4+ rollout. Gateway stays stopped until data and authentication are verified.
set -Eeuo pipefail
umask 077
fail() { printf 'UPDATE_FAILED: %s\n' "$*" >&2; exit 1; }
[[ $(id -u) == 0 ]] || fail 'Run with sudo.'
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
runtime=$(cd -- "${1:-/opt/nihongo}" && pwd -P)
[[ $# -le 1 && "$runtime" != / && "$runtime" != "$source_dir" ]] || fail 'Use a separate runtime directory.'
cd -- "$runtime"
[[ ! -L .update.lock && -d server-data && ! -L server-data ]] || fail 'Unexpected runtime paths.'
exec 9>.update.lock
flock -n 9 || fail 'Another update is running.'
compose() { docker compose --project-directory "$runtime" -f "$runtime/compose.yaml" "$@"; }
compose config --format json | node -e '
const fs=require("fs"),p=require("path"),c=JSON.parse(fs.readFileSync(0,"utf8")),m=c.services?.app?.volumes?.filter(v=>v.target==="/app/data")||[];
if(c.services?.app?.image!=="nihongo-web:local"||m.length!==1||m[0].type!=="bind"||p.resolve(m[0].source)!==p.join(process.argv[1],"server-data"))process.exit(1);' "$runtime"
app_id=$(compose ps -q app)
[[ -n "$app_id" && "$app_id" != *$'\n'* ]] || fail 'Expected one app container.'
docker inspect "$app_id" | node -e '
const fs=require("fs"),p=require("path"),c=JSON.parse(fs.readFileSync(0,"utf8"))[0],m=c.Mounts.filter(v=>v.Destination==="/app/data");
if(m.length!==1||m[0].Type!=="bind"||p.resolve(m[0].Source)!==p.join(process.argv[1],"server-data"))process.exit(1);' "$runtime"
old_image=$(docker inspect --format '{{.Image}}' "$app_id")
[[ "$old_image" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'Cannot identify current image.'
version=$(node -p 'require(process.argv[1]).version' "$source_dir/package.json")
printf 'UPDATE_START v%s\n' "$version"
docker build --pull=false -t "nihongo-web:v$version" "$source_dir"
new_image=$(docker image inspect --format '{{.Id}}' "nihongo-web:v$version")
[[ "$new_image" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'Cannot identify new image.'
backup=$(mktemp -d "${runtime%/*}/nihongo-session-backup-XXXXXXXX")
node "$source_dir/deploy/migrate-session-auth.mjs" "$runtime" "$backup/staging"
docker tag "$old_image" "nihongo-web:rollback-$(date +%Y%m%d%H%M%S)"
printf '%s\n' "$old_image" > "$backup/old-image.txt"
snapshot=false
recover() {
  status=$?; trap - EXIT
  if [[ $status != 0 ]] && "$snapshot"; then
    compose stop caddy app || true
    cp -- "$backup/compose.yaml" "$runtime/compose.yaml"
    cp -- "$backup/Caddyfile" "$runtime/deploy/Caddyfile"
    # The new release only adds tables/content. Preserve the current database;
    # never overwrite it from the pre-upgrade archive during automated recovery.
    docker tag "$old_image" nihongo-web:local
    if compose up -d --no-build --pull never --wait app && compose up -d --no-build --pull never caddy; then
      printf 'Previous application/config restored; current learning data preserved.\n' >&2
    else printf 'Recovery requires inspection. Gateway must remain unavailable. Backup: %s\n' "$backup" >&2; compose stop caddy || true; fi
  fi
  exit "$status"
}
trap recover EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
cp -- compose.yaml "$backup/compose.yaml"
cp -- deploy/Caddyfile "$backup/Caddyfile"
snapshot=true
compose stop caddy app
tar -czf "$backup/data-and-config.tar.gz" server-data .env compose.yaml deploy/Caddyfile
tar -tzf "$backup/data-and-config.tar.gz" >/dev/null
audit() { docker run --rm --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,mode=1777 -e DATA_DIR=/app/data -v "$runtime/server-data:/app/data:ro" --entrypoint node "$new_image" scripts/check-progress-integrity.mjs; }
audit > "$backup/progress-before.json"
cp -- "$backup/staging/compose.yaml" compose.yaml
cp -- "$backup/staging/deploy/Caddyfile" deploy/Caddyfile
compose config --quiet
compose run --rm --no-deps --pull never -T --entrypoint caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker tag "$new_image" nihongo-web:local
compose up -d --no-build --pull never --no-deps --wait --wait-timeout 180 app
[[ $(compose exec -T app node -p 'require("./package.json").version') == "$version" ]] || fail 'Version mismatch.'
[[ $(docker inspect --format '{{.Image}}' "$(compose ps -q app)") == "$new_image" ]] || fail 'Running image mismatch.'
# Stop all writers before copying SQLite/WAL for the second audit too.
compose stop app
audit > "$backup/progress-after.json"
cmp "$backup/progress-before.json" "$backup/progress-after.json" || fail 'Historical learning data changed; gateway remains closed.'
compose up -d --no-build --pull never --no-deps --wait --wait-timeout 180 app
compose exec -T app node scripts/check-release-auth.mjs "$version"
compose up -d --no-build --pull never --no-deps caddy
snapshot=false
printf 'UPDATE_OK v%s\nHistorical data verified. Backup: %s\n' "$version" "$backup"
