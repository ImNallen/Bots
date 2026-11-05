#!/bin/bash
# Runs as root inside a user VM, through the guest agent. create-user-template.sh runs it once, and the orchestrator
# runs it to update or repair a VM. Pass a Git ref, and "force" to rebuild a release that may be damaged. Prints the commit.
#
# A bot has root here and can install anything, so this touches only its own directory, a sudoers file, and a unit file.
# Node lives in the release, so a bot that changes the system's Node cannot break computerd. The last step before the
# restart swaps one symlink, so a kill at any point leaves a whole old release or a whole new one.
set -euo pipefail

NODE_VERSION=26.13.0
PNPM_VERSION=11.23.0
REPO_URL=https://github.com/ImNallen/Bots.git
ROOT=/opt/bots-computerd
OLD_ROOT=/opt/computerd
UNIT=/etc/systemd/system/computerd.service
TOOLS="sudo procps ca-certificates curl git xz-utils"

ref=${1:?usage: install-computerd.sh GIT_REF [force]}
force=${2:-}

# The guest agent starts commands with almost no environment.
export HOME=/root
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export DEBIAN_FRONTEND=noninteractive
export CI=true
umask 022

# Two runs must not build at once, because a killed orchestrator can leave one running when the next starts.
mkdir -p "$ROOT"
exec 9>"$ROOT/lock"
flock 9

# A bot can remove these, and computerd needs them, so put back any that are missing.
missing=""
for tool in sudo ps curl git xz; do
  command -v "$tool" >/dev/null || missing=yes
done
if [ -n "$missing" ]; then
  apt-get update -qq
  # shellcheck disable=SC2086
  apt-get install -y -qq --no-install-recommends $TOOLS >/dev/null
fi

id computerd >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin computerd
id agent >/dev/null 2>&1 || useradd --create-home --shell /bin/bash agent
install --directory --owner computerd --group computerd --mode 0700 /var/lib/computerd
[ -d /workspace ] || install --directory --owner agent --group agent --mode 0755 /workspace

runtime=$ROOT/runtimes/node-$NODE_VERSION-pnpm-$PNPM_VERSION
if [ "$force" = force ] || [ ! -x "$runtime/bin/pnpm" ] || ! "$runtime/bin/node" --version >/dev/null 2>&1; then
  work=$(mktemp -d)
  tarball="node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL -o "$work/$tarball" "https://nodejs.org/dist/v$NODE_VERSION/$tarball"
  curl -fsSL -o "$work/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$work" && grep " $tarball\$" SHASUMS256.txt | sha256sum --check --status)
  rm -rf "$runtime.tmp"
  mkdir -p "$runtime.tmp"
  tar -xJf "$work/$tarball" -C "$runtime.tmp" --strip-components=1
  rm -rf "$work"
  PATH="$runtime.tmp/bin:$PATH" "$runtime.tmp/bin/npm" install --global --silent --prefix "$runtime.tmp" "pnpm@$PNPM_VERSION"
  rm -rf "$runtime"
  mv "$runtime.tmp" "$runtime"
fi

build=$(mktemp -d "$ROOT/build.XXXXXX")
git -C "$build" init --quiet
git -C "$build" fetch --quiet --depth 1 "$REPO_URL" "$ref"
commit=$(git -C "$build" rev-parse FETCH_HEAD)
release=$ROOT/releases/$commit

if [ "$force" = force ] || [ ! -f "$release/.complete" ] || [ ! -x "$release/.runtime/bin/node" ]; then
  git -C "$build" checkout --quiet --detach FETCH_HEAD
  rm -rf "$build/.git"
  # mktemp makes a directory that only root can read, and computerd runs as its own user.
  chmod 0755 "$build"
  # A release counts only once .complete exists, so the next run rebuilds one that a kill left partway.
  rm -rf "$release"
  mkdir -p "$ROOT/releases"
  mv "$build" "$release"
  (cd "$release" && PATH="$runtime/bin:$PATH" pnpm install --silent --frozen-lockfile --prod --filter @bots/computerd...)
  ln -sfn "$runtime" "$release/.runtime"
  touch "$release/.complete"
else
  rm -rf "$build"
fi

install --mode 0440 "$release/apps/computerd/sudoers" /etc/sudoers.d/computerd
visudo --check --quiet

cat > "$UNIT.tmp" <<EOF
[Unit]
Description=Bots computerd
After=network-online.target
Wants=network-online.target
# The template has no token. A clone starts this unit after it writes one.
ConditionPathExists=/etc/computerd/env

[Service]
User=computerd
WorkingDirectory=$ROOT/current
EnvironmentFile=/etc/computerd/env
ExecStart=$ROOT/current/.runtime/bin/node apps/computerd/src/main.ts
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
mv "$UNIT.tmp" "$UNIT"

ln -sfn "$release" "$ROOT/current.tmp"
mv -T "$ROOT/current.tmp" "$ROOT/current"

systemctl daemon-reload
systemctl enable --quiet computerd
systemctl reset-failed computerd 2>/dev/null || true
systemctl try-restart computerd
# A dead computerd is why a repair runs, and try-restart leaves a dead unit dead.
if [ "$force" = force ] && [ -f /etc/computerd/env ]; then
  systemctl restart computerd
fi

for old in "$ROOT"/releases/*; do
  [ "$old" = "$release" ] || rm -rf "$old"
done
for old in "$ROOT"/runtimes/*; do
  [ "$old" = "$runtime" ] || rm -rf "$old"
done
rm -rf "$OLD_ROOT" "$ROOT"/build.*

echo "$commit"
