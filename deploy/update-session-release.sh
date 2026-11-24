#!/usr/bin/env bash
# Git-only rollout; production configuration and user data are never checked out.
set -Eeuo pipefail
umask 077
fail() { printf 'UPDATE_FAILED: %s\n' "$*" >&2; exit 1; }
[[ $(id -u) == 0 ]] || fail 'Run with sudo.'
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
runtime=$(cd -- "${1:-/opt/nihongo}" && pwd -P)
commit=${RELEASE_COMMIT:-}
[[ $# -le 1 && "$source_dir" == /opt/nihongo-git && "$runtime" == /opt/nihongo ]] || fail 'Unexpected Git/runtime paths.'
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] || fail 'A pushed RELEASE_COMMIT is required.'
[[ $(git -C "$source_dir" rev-parse HEAD) == "$commit" ]] || fail 'Git commit mismatch.'
[[ -z $(git -C "$source_dir" status --porcelain --untracked-files=normal) ]] || fail 'Dirty server source checkout.'
[[ $(git -C "$source_dir" rev-parse refs/remotes/origin/main) == "$commit" ]] || fail 'Release is not the pulled main commit.'
cd "$runtime"
[[ -d server-data && ! -L server-data && ! -L .update.lock ]] || fail 'Unexpected data/lock path.'
exec 9>.update.lock
flock -n 9 || fail 'Another update is running.'
compose() { docker compose --project-directory "$runtime" -f "$runtime/compose.yaml" "$@"; }
compose config --format json | node -e '
const fs=require("fs"),p=require("path"),c=JSON.parse(fs.readFileSync(0,"utf8")),m=c.services?.app?.volumes?.filter(v=>v.target==="/app/data")||[];
if(c.services?.app?.image!=="nihongo-web:local"||!c.services?.caddy||m.length!==1||m[0].type!=="bind"||p.resolve(m[0].source)!=="/opt/nihongo/server-data")process.exit(1);'
app_id=$(compose ps -q app)
caddy_id=$(compose ps -q caddy)
[[ -n "$app_id" && -n "$caddy_id" ]] || fail 'Expected running app and gateway.'
old_image=$(docker inspect --format '{{.Image}}' "$app_id")
[[ "$old_image" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'Unknown current image.'
docker inspect "$app_id" | node -e '
const fs=require("fs"),c=JSON.parse(fs.readFileSync(0,"utf8"))[0],m=c.Mounts.filter(v=>v.Destination==="/app/data");
if(m.length!==1||m[0].Type!=="bind"||m[0].Source!=="/opt/nihongo/server-data")process.exit(1);'
version=$(node -p 'require(process.argv[1]).version' "$source_dir/package.json")
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Use a validated stable release version.'
old_dependencies=$(docker run --rm --network none --read-only --entrypoint node "$old_image" -p 'JSON.stringify([require("./package.json").dependencies,require("./package.json").devDependencies])')
new_dependencies=$(node -p 'JSON.stringify([require(process.argv[1]).dependencies,require(process.argv[1]).devDependencies])' "$source_dir/package.json")
if [[ "$old_dependencies" == "$new_dependencies" ]]; then
  docker build --pull=false --build-arg "BASE_IMAGE=$old_image" -f "$source_dir/Dockerfile.reuse" --label "org.opencontainers.image.revision=$commit" --label "org.opencontainers.image.version=$version" -t "nihongo-web:v$version" "$source_dir"
else
  docker build --pull=false --label "org.opencontainers.image.revision=$commit" --label "org.opencontainers.image.version=$version" -t "nihongo-web:v$version" "$source_dir"
fi
new_image=$(docker image inspect --format '{{.Id}}' "nihongo-web:v$version")
[[ $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$new_image") == "$commit" ]] || fail 'Built image commit mismatch.'
available_kb=$(df -Pk "$runtime" | awk 'NR==2 {print $4}')
source_kb=$(du -sk server-data | awk '{print $1}')
(( available_kb > source_kb + 150000 )) || fail 'Insufficient space for a complete backup.'
backup=$(mktemp -d /opt/nihongo-git-backup-XXXXXXXX)
printf '%s\n' "$commit" > "$backup/git-commit.txt"
printf '%s\n' "$old_image" > "$backup/old-image.txt"
printf '%s\n' "$new_image" > "$backup/new-image.txt"
docker tag "$old_image" "nihongo-web:rollback-$(date +%Y%m%d%H%M%S)-${commit:0:8}"
sha256sum .env compose.yaml deploy/Caddyfile > "$backup/config-before.sha256"
writers_stopped=false
failed() {
  code=$?; trap - EXIT
  if (( code != 0 )) && "$writers_stopped"; then
    compose stop caddy app || true
    printf 'Gateway closed; current data retained. Backup: %s\n' "$backup" >&2
  fi
  exit "$code"
}
trap failed EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
printf 'UPDATE_START v%s GIT_COMMIT=%s\n' "$version" "$commit"
writers_stopped=true
compose stop caddy app
tar -czf "$backup/data-and-config.tar.gz" server-data .env compose.yaml deploy/Caddyfile
tar -tzf "$backup/data-and-config.tar.gz" >/dev/null
sha256sum "$backup/data-and-config.tar.gz" > "$backup/data-and-config.sha256"
if test -f server-data/weekly-schedule.json; then sha256sum server-data/weekly-schedule.json > "$backup/schedule-before.sha256"; fi
audit() { docker run --rm --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,mode=1777 -e DATA_DIR=/app/data -v "$runtime/server-data:/app/data:ro" --entrypoint node "$new_image" scripts/check-progress-integrity.mjs; }
audit > "$backup/progress-before.json"
docker tag "$new_image" nihongo-web:local
compose up -d --no-build --pull never --no-deps --wait --wait-timeout 180 app
[[ $(docker inspect --format '{{.Image}}' "$(compose ps -q app)") == "$new_image" ]] || fail 'Running image mismatch.'
compose stop app
audit > "$backup/progress-after.json"
cmp "$backup/progress-before.json" "$backup/progress-after.json" || fail 'Historical learning data changed.'
sha256sum -c "$backup/config-before.sha256" >/dev/null
if test -f "$backup/schedule-before.sha256"; then sha256sum -c "$backup/schedule-before.sha256" >/dev/null; fi
compose up -d --no-build --pull never --no-deps --wait --wait-timeout 180 app
compose exec -T app node scripts/check-release-auth.mjs "$version" </dev/null
[[ $(compose ps -aq caddy) == "$caddy_id" ]] || fail 'Gateway container changed.'
compose start caddy
writers_stopped=false
printf 'UPDATE_OK v%s GIT_COMMIT=%s\nHistorical data and configuration verified. Backup: %s\n' "$version" "$commit" "$backup"
