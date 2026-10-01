#!/usr/bin/env bash
# Compatible UI releases only. Run as root through systemd-run so SSH can disconnect.
set -Eeuo pipefail
umask 077
fail() { printf 'UPDATE_FAILED: %s\n' "$*" >&2; exit 1; }
[[ $(id -u) == 0 ]] || fail 'Run this updater with sudo.'
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
runtime=$(cd -- "${1:-/opt/nihongo}" && pwd -P)
[[ $# -le 1 && "$runtime" != / && "$runtime" != "$source_dir" ]] || fail 'Expected a separate application runtime directory.'
for tool in docker node flock tar mktemp; do command -v "$tool" >/dev/null || fail "Missing command: $tool"; done
cd -- "$runtime"
[[ ! -L .update.lock ]] || fail 'The update lock must not be a symbolic link.'
exec 9>.update.lock
flock -n 9 || fail 'Another update is already running.'
[[ -d server-data && ! -L server-data ]] || fail 'Expected the existing server-data directory.'
for file in .env compose.yaml deploy/Caddyfile; do
  [[ -f "$file" && ! -L "$file" ]] || fail "Missing or linked runtime file: $file"
done
version=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).version' "$source_dir/package.json")
[[ "$version" == 1.1.2 ]] || fail 'This updater supports source release 1.1.2 only.'
printf 'UPDATE_START v%s %s\n' "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
compose() { docker compose -p nihongo-web -f compose.yaml "$@"; }
compose config --quiet
# Parse configuration privately: never print the expanded environment or credentials.
compose config --format json | node -e '
  const fs=require("node:fs"),p=require("node:path");
  let config;try{config=JSON.parse(fs.readFileSync(0,"utf8"));}catch{console.error("Could not read runtime configuration.");process.exit(1);}const app=config.services?.app;
  const mounts=app?.volumes?.filter(v=>v.target==="/app/data")||[];
  if(app?.image!=="nihongo-web:local"||mounts.length!==1||mounts[0].type!=="bind"||p.resolve(mounts[0].source)!==p.join(p.resolve(process.argv[1]),"server-data")||!config.services?.caddy) {
    console.error("Unexpected runtime image, data mount or gateway; no changes made.");process.exit(1);
  }' "$runtime"
app_id=$(compose ps -q app)
[[ -n "$app_id" && "$app_id" != *$'\n'* ]] || fail 'Expected exactly one running app container.'
[[ $(docker inspect --format '{{.Config.Image}}' "$app_id") == nihongo-web:local ]] || fail 'The running app uses an unexpected image name.'
docker inspect "$app_id" | node -e '
  const fs=require("node:fs"),p=require("node:path");let item;try{item=JSON.parse(fs.readFileSync(0,"utf8"))[0];}catch{console.error("Could not inspect the running app.");process.exit(1);}
  const mounts=item?.Mounts?.filter(v=>v.Destination==="/app/data")||[];
  if(mounts.length!==1||mounts[0].Type!=="bind"||p.resolve(mounts[0].Source)!==p.join(p.resolve(process.argv[1]),"server-data")) {
    console.error("The running app uses another data directory; no changes made.");process.exit(1);
  }' "$runtime"
[[ $(docker inspect --format '{{.State.Health.Status}}' "$app_id") == healthy ]] || fail 'The current app must be healthy before updating.'
old_version=$(compose exec -T app node -p 'require("./package.json").version')
case "$old_version" in 1.1.0|1.1.1|1.1.2) ;; *) fail 'Only installed versions 1.1.0–1.1.2 are compatible with this UI update.' ;; esac
old_image=$(docker inspect --format '{{.Image}}' "$app_id")
[[ "$old_image" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'Could not identify the running image.'
target="nihongo-web:v$version"
printf 'Building %s; the current website remains running.\n' "$target"
docker build --progress=plain --pull=false -t "$target" "$source_dir"
new_image=$(docker image inspect --format '{{.Id}}' "$target")
[[ "$new_image" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'The new image was not created.'
image_version=$(docker run --rm --network none --read-only --entrypoint node "$new_image" -p 'require("./package.json").version')
[[ "$image_version" == "$version" ]] || fail 'The built image version does not match this release.'

backup_dir=$(mktemp -d "${runtime%/*}/nihongo-backup-v112-XXXXXXXX")
rollback_tag="nihongo-web:rollback-$(date +%Y%m%d%H%M%S)-$$"
printf '%s\n' "$old_image" > "$backup_dir/old-image.txt"
printf '%s\n' "$old_version" > "$backup_dir/old-version.txt"
printf '%s\n' "$new_image" > "$backup_dir/new-image.txt"
printf '%s\n' "$rollback_tag" > "$backup_dir/rollback-tag.txt"
docker tag "$old_image" "$rollback_tag"
printf 'Backup directory: %s\n' "$backup_dir"
needs_recovery=false
verify_running() {
  local wanted_image=$1 wanted_version=$2 running
  running=$(compose ps -q app) || return 1
  [[ -n "$running" && "$running" != *$'\n'* ]] || return 1
  [[ $(docker inspect --format '{{.Image}}' "$running") == "$wanted_image" ]] || return 1
  [[ $(docker inspect --format '{{.State.Health.Status}}' "$running") == healthy ]] || return 1
  [[ $(compose exec -T app node -p 'require("./package.json").version') == "$wanted_version" ]]
}
recover_on_exit() {
  local status=$?
  trap - EXIT INT TERM HUP
  if "$needs_recovery"; then
    printf 'Update did not complete. Restoring the previous image; learning data is retained.\n' >&2
    if docker tag "$old_image" nihongo-web:local &&
       compose up -d --no-build --pull never --no-deps --wait --wait-timeout 180 app &&
       verify_running "$old_image" "$old_version"; then
      printf 'ROLLBACK_OK v%s\n' "$old_version" >&2
    else
      printf 'ROLLBACK_FAILED: inspect the app manually. Backup: %s\n' "$backup_dir" >&2
    fi
    [[ "$status" != 0 ]] || status=1
  fi
  exit "$status"
}
trap recover_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
needs_recovery=true
compose stop app
# Stopping the only writer makes the SQLite database and its WAL a consistent backup.
tar -czf "$backup_dir/data-and-config.tar.gz" server-data .env compose.yaml deploy/Caddyfile
tar -tzf "$backup_dir/data-and-config.tar.gz" >/dev/null
printf 'Backup verified. Switching only the app container.\n'
docker tag "$new_image" nihongo-web:local
compose up -d --no-build --pull never --no-deps --wait --wait-timeout 180 app
verify_running "$new_image" "$version" || fail 'New app image, health or version verification failed.'
needs_recovery=false
printf 'UPDATE_OK v%s\nBackup directory: %s\n' "$version" "$backup_dir"
