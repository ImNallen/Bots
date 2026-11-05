#!/bin/bash
# Runs as root inside a user VM, through the guest agent. create-user-template.sh runs it once, and the orchestrator
# runs it to update or repair a VM. Pass a Git ref and a mode, and it prints the commit.
#   all       build, then activate. The default.
#   build     make a whole release and restart nothing. This is the slow part, and tools keep running.
#   activate  swap to the built release and restart computerd. This is the part that interrupts a tool.
#   force     build a fresh copy of everything, then activate. This is the repair for a VM that may be damaged.
#
# A bot has root here and can install anything, so this touches only its own directory, a sudoers file, and its unit files.
# Node lives in the release, so a bot that changes the system's Node cannot break computerd. Everything new gets a new
# directory, and one symlink selects a release, so a kill or a failed download never damages the selected release.
set -euo pipefail

NODE_VERSION=26.13.0
PNPM_VERSION=11.23.0
REPO_URL=https://github.com/ImNallen/Bots.git
ROOT=/opt/bots-computerd
OLD_ROOT=/opt/computerd
UNIT_DIR=/etc/systemd/system
UNIT=$UNIT_DIR/computerd.service
TOOLS="sudo procps ca-certificates curl git xz-utils"
BROWSER_PACKAGES="chromium xvfb x11vnc x11-utils dbus xfwm4 xfdesktop4 xfce4-panel xfce4-settings xfce4-terminal xfconf thunar fonts-liberation fonts-noto-color-emoji"

ref=${1:?usage: install-computerd.sh GIT_REF [all|build|activate|force]}
mode=${2:-all}
case $mode in
  all | build | activate | force) ;;
  *) echo "unknown mode $mode" >&2; exit 2 ;;
esac

# The guest agent starts commands with almost no environment.
export HOME=/root
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export DEBIAN_FRONTEND=noninteractive
export CI=true
umask 022

# Two runs must not build at once, because a killed orchestrator can leave one running when the next starts.
mkdir -p "$ROOT/releases" "$ROOT/runtimes"
exec 9>"$ROOT/lock"
flock 9

release_is_whole() {
  [ -f "$1/.complete" ] && "$1/.runtime/bin/node" --version >/dev/null 2>&1 && [ -x "$1/.runtime/bin/pnpm" ]
}

# A kill during an install leaves packages half set up, and a later apt-get then refuses to run until dpkg finishes them.
browser_packages_are_whole() {
  local states
  # shellcheck disable=SC2086
  states=$(dpkg-query --show --showformat='${db:Status-Status}\n' $BROWSER_PACKAGES 2>/dev/null) || return 1
  [ "$(sort -u <<<"$states")" = installed ] && [ -z "$(dpkg --audit)" ]
}

build() {
  local missing="" tool candidate runtime="" work tarball
  # A bot can remove these, and computerd needs them, so put back any that are missing.
  for tool in sudo ps curl git xz; do
    command -v "$tool" >/dev/null || missing=yes
  done
  if [ -n "$missing" ]; then
    apt-get update -qq
    # shellcheck disable=SC2086
    apt-get install -y -qq --no-install-recommends $TOOLS >/dev/null
  fi

  if ! browser_packages_are_whole; then
    dpkg --configure -a
    apt-get update -qq
    # Tools keep running during a build, so this must not replace the Chromium that a bot is using.
    # shellcheck disable=SC2086
    apt-get install -y -qq --no-install-recommends --no-upgrade $BROWSER_PACKAGES >/dev/null
  fi

  id computerd >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin computerd
  id agent >/dev/null 2>&1 || useradd --create-home --shell /bin/bash agent
  install --directory --owner computerd --group computerd --mode 0700 /var/lib/computerd
  [ -d /workspace ] || install --directory --owner agent --group agent --mode 0755 /workspace
  id browser >/dev/null 2>&1 || useradd --create-home browser
  # A terminal on the desktop opens this shell. The user has no sudo.
  usermod --shell /bin/bash browser >/dev/null

  # Anything a killed run left is unfinished, and the selected release is never in this list.
  for candidate in "$ROOT"/build.* "$ROOT"/runtimes/*.tmp; do
    rm -rf "$candidate"
  done

  fetched=$(mktemp -d "$ROOT/build.XXXXXX")
  git -C "$fetched" init --quiet
  git -C "$fetched" fetch --quiet --depth 1 "$REPO_URL" "$ref"
  commit=$(git -C "$fetched" rev-parse FETCH_HEAD)

  if [ "$mode" != force ]; then
    for candidate in "$ROOT/releases/$commit"*; do
      if [ -d "$candidate" ] && release_is_whole "$candidate"; then
        rm -rf "$fetched"
        ln -sfn "$candidate" "$ROOT/next"
        return
      fi
    done
    for candidate in "$ROOT/runtimes/node-$NODE_VERSION-pnpm-$PNPM_VERSION"*; do
      if [ -x "$candidate/bin/pnpm" ] && "$candidate/bin/node" --version >/dev/null 2>&1; then
        runtime=$candidate
        break
      fi
    done
  fi

  local suffix=${fetched##*.}
  if [ -z "$runtime" ]; then
    work=$(mktemp -d)
    tarball="node-v$NODE_VERSION-linux-x64.tar.xz"
    curl -fsSL -o "$work/$tarball" "https://nodejs.org/dist/v$NODE_VERSION/$tarball"
    curl -fsSL -o "$work/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
    (cd "$work" && grep " $tarball\$" SHASUMS256.txt | sha256sum --check --status)
    local building="$ROOT/runtimes/node-$NODE_VERSION-pnpm-$PNPM_VERSION.$suffix.tmp"
    mkdir -p "$building"
    tar -xJf "$work/$tarball" -C "$building" --strip-components=1
    rm -rf "$work"
    PATH="$building/bin:$PATH" "$building/bin/npm" install --global --silent --prefix "$building" "pnpm@$PNPM_VERSION"
    runtime=${building%.tmp}
    mv "$building" "$runtime"
  fi

  git -C "$fetched" checkout --quiet --detach FETCH_HEAD
  rm -rf "$fetched/.git"
  # mktemp makes a directory that only root can read, and computerd runs as its own user.
  chmod 0755 "$fetched"
  local release="$ROOT/releases/$commit.$suffix"
  mv "$fetched" "$release"
  # A release counts only once .complete exists, and activate selects only a whole one.
  (cd "$release" && PATH="$runtime/bin:$PATH" pnpm install --silent --frozen-lockfile --prod --filter @bots/computerd...)
  ln -sfn "$runtime" "$release/.runtime"
  touch "$release/.complete"
  ln -sfn "$release" "$ROOT/next"
}

activate() {
  local release candidate keep_runtime file unit screen
  release=$(readlink -f "$ROOT/next" 2>/dev/null || true)
  if [ -z "$release" ] || ! release_is_whole "$release"; then
    echo "there is no whole release to activate" >&2
    exit 1
  fi
  commit=$(basename "$release")
  commit=${commit%%.*}
  # activate takes the commit that build printed, so a stale release cannot go live in its place.
  if [ "$mode" = activate ] && [ "$commit" != "$ref" ]; then
    echo "the built release is $commit, not $ref" >&2
    exit 1
  fi

  install --mode 0440 "$release/apps/computerd/sudoers" /etc/sudoers.d/computerd
  visudo --check --quiet

  # mv replaces whatever is at the path, so this also undoes a mask or an edit by a bot.
  for file in "$release"/apps/computerd/desktop/computerd-*; do
    unit=$(basename "$file")
    install --mode 0644 "$file" "$UNIT_DIR/$unit.tmp"
    mv "$UNIT_DIR/$unit.tmp" "$UNIT_DIR/$unit"
  done

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
# Who holds each desktop. This outlives computerd, because the desktops do, and it ends at a reboot, because they do.
RuntimeDirectory=computerd
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=yes
ExecStart=$ROOT/current/.runtime/bin/node apps/computerd/src/main.ts
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
  mv "$UNIT.tmp" "$UNIT"
  systemctl daemon-reload

  # The new computerd.service no longer wants these, so a computerd that crashes here cannot bring them back. The old browser
  # stops before the symlink moves, so no new computerd can copy a base that a browser still has open. The file goes only
  # after its stop returns, so a kill between the two repeats the stop on the next run, and a clean VM skips all of it.
  local old_units="computerd-display.service computerd-browser.service"
  for screen in 0 1 2 3 4 5 6 7; do
    old_units="$old_units computerd-screen-$screen.service"
  done
  for unit in $old_units; do
    if [ -f "$UNIT_DIR/$unit" ]; then
      systemctl stop --quiet "$unit"
      rm -f "$UNIT_DIR/$unit"
    fi
  done
  rm -f /var/lib/computerd/screens.json /var/lib/computerd/screens.json.tmp

  ln -sfn "$release" "$ROOT/current.tmp"
  mv -T "$ROOT/current.tmp" "$ROOT/current"

  systemctl daemon-reload
  systemctl enable --quiet computerd
  systemctl reset-failed computerd 2>/dev/null || true
  # A dead computerd is why a repair runs, and try-restart leaves a dead unit dead.
  if [ "$mode" = force ] && [ -f /etc/computerd/env ]; then
    systemctl restart computerd
  else
    systemctl try-restart computerd
  fi

  keep_runtime=$(readlink -f "$release/.runtime")
  for candidate in "$ROOT"/releases/*; do
    [ "$candidate" = "$release" ] || rm -rf "$candidate"
  done
  for candidate in "$ROOT"/runtimes/*; do
    [ "$candidate" = "$keep_runtime" ] || rm -rf "$candidate"
  done
  rm -rf "$OLD_ROOT" "$ROOT"/build.*
  rm -f "$ROOT/next"
}

if [ "$mode" != activate ]; then
  build
fi
if [ "$mode" != build ]; then
  activate
fi

echo "$commit"
