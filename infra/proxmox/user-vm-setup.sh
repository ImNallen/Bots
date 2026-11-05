#!/bin/bash
# create-user-template.sh runs this as root inside the template VM. Pass the Git ref to install.
# It gives the VM the same users, sudoers rule, and tools as apps/computerd/Dockerfile.
set -euo pipefail

NODE_VERSION=26.13.0
PNPM_VERSION=11.23.0
REPO_URL=https://github.com/ImNallen/Bots.git
APP_DIR=/opt/computerd

ref=${1:?usage: user-vm-setup.sh GIT_REF}

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

useradd --system --create-home --shell /usr/sbin/nologin computerd
useradd --create-home --shell /bin/bash agent
install --directory --owner computerd --group computerd --mode 0700 /var/lib/computerd
install --directory --owner agent --group agent --mode 0755 /workspace

git init --quiet "$APP_DIR"
git -C "$APP_DIR" fetch --quiet --depth 1 "$REPO_URL" "$ref"
git -C "$APP_DIR" checkout --quiet --detach FETCH_HEAD
(cd "$APP_DIR" && pnpm install --silent --frozen-lockfile --prod --filter @bots/computerd...)

install --mode 0440 "$APP_DIR/apps/computerd/sudoers" /etc/sudoers.d/computerd
visudo --check --quiet
install --mode 0644 "$APP_DIR/apps/computerd/computerd.service" /etc/systemd/system/computerd.service
systemctl enable --quiet computerd

git -C "$APP_DIR" rev-parse HEAD

# Each clone must get its own machine ID and SSH host keys, and cloud-init must run again to set its name and address.
apt-get clean
cloud-init clean --logs --machine-id
fstrim --all
