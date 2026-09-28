#!/usr/bin/env bash
# For a NEW Ubuntu 24.04 server. Based on Docker's official Ubuntu instructions:
# https://docs.docker.com/engine/install/ubuntu/
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run: sudo bash deploy/install-docker-ubuntu.sh" >&2
  exit 1
fi
. /etc/os-release
if [ "${ID:-}" != ubuntu ] || [ "${VERSION_ID:-}" != 24.04 ]; then
  echo "This helper is for Ubuntu 24.04 only. No changes made." >&2
  exit 1
fi

if command -v docker >/dev/null 2>&1; then
  docker compose version
  apt-get update
  apt-get install -y --no-install-recommends nodejs
  echo "Docker is already installed. Kept the existing Docker configuration."
  exit 0
fi

# Stop if another container stack exists; do not automatically uninstall it.
for package in docker.io docker-compose docker-compose-v2 podman-docker containerd runc; do
  if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
    echo "Existing package $package found. Follow Docker's official migration instructions first." >&2
    exit 1
  fi
done

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl nodejs
install -m 0755 -d /etc/apt/keyrings
curl --fail --show-error --silent --location --connect-timeout 20 --max-time 120 \
  https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker compose version
node --version
echo "Ready. Next: sudo node deploy/configure.mjs"
