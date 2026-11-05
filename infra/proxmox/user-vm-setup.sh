#!/bin/bash
# create-user-template.sh runs this as root inside the template VM, before install-computerd.sh.
# This Node is for bots, and a bot may replace it. computerd has its own.
set -euo pipefail

NODE_VERSION=26.13.0
PNPM_VERSION=11.23.0

# The guest agent starts commands with almost no environment.
export HOME=/root
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export DEBIAN_FRONTEND=noninteractive

# cloud-init installs the guest agent and can still hold the apt lock when the agent answers.
cloud-init status --wait >/dev/null || true

apt-get update -qq
apt-get install -y -qq --no-install-recommends sudo procps ca-certificates curl git xz-utils >/dev/null

work=$(mktemp -d)
tarball="node-v$NODE_VERSION-linux-x64.tar.xz"
curl -fsSL -o "$work/$tarball" "https://nodejs.org/dist/v$NODE_VERSION/$tarball"
curl -fsSL -o "$work/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
(cd "$work" && grep " $tarball\$" SHASUMS256.txt | sha256sum --check --status)
tar -xJf "$work/$tarball" -C /usr/local --strip-components=1
rm -rf "$work"
npm install --global --silent "pnpm@$PNPM_VERSION"
