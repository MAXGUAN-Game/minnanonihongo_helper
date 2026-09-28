#!/usr/bin/env bash
# Run from the application directory after extracting the offline install bundle.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run: sudo bash deploy/import-offline-images.sh" >&2
  exit 1
fi
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo "This bundle contains Linux / amd64 images only. No images imported." >&2
  exit 1
fi

app_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
image_dir="$app_root/offline-images"
archives=(
  caddy-2.11.4-alpine-linux-amd64.tar
  debian-bookworm-slim-linux-amd64.tar
  node-24-bookworm-linux-amd64.tar
  node-24-bookworm-slim-linux-amd64.tar
)

docker info >/dev/null
# Verify every archive before importing any of them.
for archive in "${archives[@]}"; do
  if [ ! -f "$image_dir/$archive" ] || [ ! -f "$image_dir/$archive.sha256" ]; then
    echo "Missing offline image or checksum: $archive. Upload the complete bundle." >&2
    exit 1
  fi
  (cd "$image_dir" && sha256sum --check "$archive.sha256")
done
for archive in "${archives[@]}"; do
  docker image load --input "$image_dir/$archive"
done

for reference in caddy:2.11.4-alpine debian:bookworm-slim node:24-bookworm node:24-bookworm-slim; do
  platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$reference")"
  if [ "$platform" != linux/amd64 ]; then
    echo "Unexpected image platform for $reference: $platform" >&2
    exit 1
  fi
done
docker run --rm --pull=never caddy:2.11.4-alpine caddy version
echo "Images imported. Next: sudo node deploy/configure.mjs"
echo "Application build still needs access to APT, npm and the whisper.cpp source repository."
