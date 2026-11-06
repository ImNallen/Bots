#!/bin/bash
# Removes what deleted bots left on a VM. Pass their ids. It prints each id it finished, and the reconcile loop keeps the others
# for its next pass. The loop runs this as root through the guest agent, and a rerun is safe, so a kill at any point only repeats it.
set -u
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# An id becomes a path, so a bad one must stop everything before the first removal.
for bot in "$@"; do
  case "$bot" in
    '' | *[!A-Za-z0-9]*)
      echo "not a bot id" >&2
      exit 2
      ;;
  esac
done

forget() {
  local holder slot
  for holder in /run/computerd/desktop-*.env; do
    if [ -f "$holder" ] && grep -qx "BOT_ID=$1" "$holder"; then
      slot=${holder##*desktop-}
      # A stop returns after Chromium has exited, so nothing can write to the profile below.
      systemctl stop --quiet "computerd-xvfb@${slot%.env}.service" || return 1
    fi
  done
  rm -rf --one-file-system -- "/home/browser/profiles/$1" "/home/browser/profiles/$1.tmp" "/workspace/$1" \
    "/var/lib/computerd/takeovers/$1.json" "/var/lib/computerd/takeovers/$1.json.tmp"
}

# A bot has root here, so one bot's files can refuse to go. That must not hold back the others.
status=0
for bot in "$@"; do
  if forget "$bot"; then
    echo "$bot"
  else
    status=1
  fi
done
exit "$status"
