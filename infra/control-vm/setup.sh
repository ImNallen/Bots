#!/bin/bash
# Run as root on the control VM. Installs what the machine needs. Safe to rerun.
set -euo pipefail

NODE_VERSION=26.13.0
PNPM_VERSION=11.23.0
REPO_URL=https://github.com/ImNallen/Bots.git
APP_DIR=/opt/bots

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git gnupg xz-utils >/dev/null

install -m 0755 -d /etc/apt/keyrings

if ! command -v docker >/dev/null; then
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
fi

if ! command -v tailscale >/dev/null; then
  curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg -o /etc/apt/keyrings/tailscale.gpg
  echo "deb [signed-by=/etc/apt/keyrings/tailscale.gpg] https://pkgs.tailscale.com/stable/debian trixie main" \
    > /etc/apt/sources.list.d/tailscale.list
  apt-get update -qq
  apt-get install -y -qq tailscale >/dev/null
fi

if [ "$(node -v 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
  work=$(mktemp -d)
  tarball="node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL -o "$work/$tarball" "https://nodejs.org/dist/v$NODE_VERSION/$tarball"
  curl -fsSL -o "$work/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$work" && grep " $tarball\$" SHASUMS256.txt | sha256sum --check --status)
  tar -xJf "$work/$tarball" -C /usr/local --strip-components=1
  rm -rf "$work"
fi

if [ "$(pnpm -v 2>/dev/null || true)" != "$PNPM_VERSION" ]; then
  npm install --global --silent "pnpm@$PNPM_VERSION"
fi

if [ ! -d "$APP_DIR/.git" ]; then
  git clone --quiet "$REPO_URL" "$APP_DIR"
fi

echo "machine ready: node $(node -v), pnpm $(pnpm -v), $(docker --version), tailscale $(tailscale version | head -1)"
