#!/bin/bash
# Run on the Proxmox host. Pass a user VM that runs this release and whose owner has no run. It drives one bot's desktop
# through its units, with no computerd in the way, and it uses slots 7 and 8. Exits 0 only if every check passes.
#
# Set NO_REBOOT=1 to skip the reboot at the end. A VM that a person is using should set it.
set -euo pipefail

vm=${1:?usage: verify-desktop.sh VMID}
here=$(dirname "$(realpath "$0")")
GUEST_TIMEOUT=600

field() {
  python3 -c 'import json, sys; print(json.load(sys.stdin).get(sys.argv[1], ""), end="")' "$1"
}

failed=0

guest() { # a script on stdin, then its arguments. Prints what it printed, and a failure counts against this run.
  local reply
  reply=$(qm guest exec "$vm" --timeout "$GUEST_TIMEOUT" --pass-stdin 1 -- bash -s -- "$@")
  field out-data <<<"$reply"
  field err-data <<<"$reply" >&2
  [ "$(field exitcode <<<"$reply")" = 0 ] || failed=1
}

probe=$(base64 --wrap=0 "$here/desktop-probe.mjs")

guest "$probe" <<'GUEST'
export HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SLOT=8
OTHER=7
BOT=verifydesktop
OTHER_BOT=verifyother
CDP=9308
VNC=5908
OTHER_CDP=9307
OTHER_VNC=5907
TARGET=computerd-desktop@$SLOT.target
DISPLAY_UNIT=computerd-xvfb@$SLOT.service
BROWSER_UNIT=computerd-chromium@$SLOT.service
STREAM_UNIT=computerd-vnc@$SLOT.service
SESSION_UNIT=computerd-xfce@$SLOT.service
PROFILE=/home/browser/profiles/$BOT
BASE=/home/browser/profile
SYSTEMCTL_TIMEOUT_SECONDS=75
PARTS="$BROWSER_UNIT $STREAM_UNIT $SESSION_UNIT $DISPLAY_UNIT $TARGET"
NODE=/opt/bots-computerd/current/.runtime/bin/node
PROBE=$(mktemp --suffix=.mjs)
base64 -d <<<"$1" >"$PROBE"
chmod 0644 "$PROBE"

failures=0
passes=0
result() {
  if [ "$1" = true ]; then
    passes=$((passes + 1))
    echo "ok    $2"
  else
    failures=$((failures + 1))
    echo "FAIL  $2${3:+ [$3]}"
  fi
}
check() {
  local label=$1
  shift
  if "$@" >/dev/null 2>&1; then result true "$label"; else result false "$label"; fi
}
same() { [ "$2" = "$3" ] && result true "$1" || result false "$1" "expected $3, got $2"; }
differ() { [ "$2" != "$3" ] && result true "$1" || result false "$1" "both $2"; }
measure() { echo "measure  $*"; }

now_ms() { echo $(($(date +%s%N) / 1000000)); }
probe() { "$NODE" "$PROBE" "$@"; }
cdp_up() { curl -fsS --max-time 1 "http://127.0.0.1:${1:-$CDP}/json/version"; }
rfb_up() { [ "$(probe rfb-size "${1:-$VNC}" 2>/dev/null)" = 1280x800 ]; }
state() { systemctl show -p ActiveState --value "$1"; }
pid() { systemctl show -p MainPID --value "$1"; }
wait_for() { # seconds, then a command
  local deadline=$(($(date +%s) + $1))
  shift
  until "$@" >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 0.2
  done
}
holder() { # slot, bot, cdp, vnc
  install -d -m 0700 /run/computerd 2>/dev/null || true
  printf 'BOT_ID=%s\nCDP_PORT=%s\nVNC_PORT=%s\n' "$2" "$3" "$4" >"/run/computerd/desktop-$1.env"
}
all_down() {
  local unit
  for unit in $PARTS; do
    case $(state "$unit") in inactive | failed) ;; *) return 1 ;; esac
  done
}
unit_processes() {
  local group
  group=$(systemctl show -p ControlGroup --value "$1")
  if [ -n "$group" ] && [ -e "/sys/fs/cgroup$group/cgroup.procs" ]; then wc -l <"/sys/fs/cgroup$group/cgroup.procs"; else echo 0; fi
}
slot_processes() {
  local unit total=0
  for unit in $BROWSER_UNIT $STREAM_UNIT $SESSION_UNIT $DISPLAY_UNIT; do
    total=$((total + $(unit_processes "$unit")))
  done
  echo "$total"
}
base_hash() {
  [ -d "$BASE" ] || { echo none; return; }
  find "$BASE" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum
}
memory() { # the desktop's memory now, summed across its units. Page cache is counted apart, because the kernel can take it back.
  local unit group anon=0 file=0
  for unit in $BROWSER_UNIT $STREAM_UNIT $SESSION_UNIT $DISPLAY_UNIT; do
    group=/sys/fs/cgroup$(systemctl show -p ControlGroup --value "$unit")
    anon=$((anon + $(awk '$1 == "anon" { print $2 }' "$group/memory.stat")))
    file=$((file + $(awk '$1 == "file" { print $2 }' "$group/memory.stat")))
  done
  echo "$((anon / 1024 / 1024)) MB anonymous, $((file / 1024 / 1024)) MB page cache"
}
cleanup() {
  systemctl stop --quiet computerd-xvfb@$SLOT.service computerd-xvfb@$OTHER.service 2>/dev/null || true
  systemctl reset-failed 'computerd-*@'$SLOT'*' 'computerd-*@'$OTHER'*' 2>/dev/null || true
  rm -rf "$PROFILE" "$PROFILE.tmp" "/home/browser/profiles/$OTHER_BOT" /run/computerd/desktop-$SLOT.env /run/computerd/desktop-$OTHER.env "$PROBE"
}

for unit in computerd-xvfb@$SLOT.service computerd-xvfb@$OTHER.service; do
  if [ "$(state "$unit")" = active ]; then
    echo "$unit is running, so a bot may hold it, and this check will not touch it" >&2
    exit 2
  fi
done
trap cleanup EXIT
rm -rf "$PROFILE" "/home/browser/profiles/$OTHER_BOT"
base_before=$(base_hash)
holder "$SLOT" "$BOT" "$CDP" "$VNC"
holder "$OTHER" "$OTHER_BOT" "$OTHER_CDP" "$OTHER_VNC"

for name in computerd-desktop@.target computerd-xvfb@.service computerd-xfce@.service computerd-chromium@.service computerd-vnc@.service; do
  check "installed: $name" test -f "/etc/systemd/system/$name"
done
for old in computerd-display computerd-browser computerd-screen-0 computerd-screen-7; do
  [ ! -f "/etc/systemd/system/$old.service" ] && result true "migrated: $old has no unit file" || result false "migrated: $old has no unit file"
done
check "migrated: the base profile remains" test -d "$BASE"
listed=$(sudo -l -U computerd 2>/dev/null)
grep -qF '/usr/bin/systemctl start --quiet computerd-desktop@[1-8].target' <<<"$listed" && result true "sudoers: computerd may start a desktop" || result false "sudoers: computerd may start a desktop"
grep -qF '/usr/bin/systemctl stop --quiet computerd-xvfb@[1-8].service' <<<"$listed" && result true "sudoers: computerd may stop a desktop" || result false "sudoers: computerd may stop a desktop"
! sudo -n -u computerd sudo -n /usr/bin/systemctl stop --quiet computerd.service 2>/dev/null && result true "sudoers: computerd may not stop another unit" || result false "sudoers: computerd may not stop another unit"

sudo -u browser mkdir -p "$PROFILE.tmp"
sudo -u browser touch "$PROFILE.tmp/left-by-a-kill"
sync
echo 3 >/proc/sys/vm/drop_caches
started=$(now_ms)
systemctl start --quiet "$TARGET"
start_rc=$?
elapsed=$(($(now_ms) - started))
measure "first start of a desktop, with no file in the page cache: $elapsed ms"
same "start: the target's start succeeds" "$start_rc" 0
check "start: CDP answers when the start returns" cdp_up
check "start: the stream gives 1280x800 when the start returns" rfb_up
same "start: Chromium is active" "$(state "$BROWSER_UNIT")" active
same "start: Xfce is active" "$(state "$SESSION_UNIT")" active
sleep 4
measure "idle desktop: $(memory)"

systemctl start --quiet computerd-desktop@$OTHER.target
check "start: a second desktop answers on its own port" cdp_up "$OTHER_CDP"
other_browser=$(pid computerd-chromium@$OTHER.service)
other_stream=$(pid computerd-vnc@$OTHER.service)
other_display=$(pid computerd-xvfb@$OTHER.service)

listeners=$(ss -ltnH)
! grep -E ":(9308|5908) " <<<"$listeners" | awk '{ print $4 }' | grep -vE '^(127\.0\.0\.1|\[::1\]):' >/dev/null && result true "isolation: CDP and the stream listen on loopback only" || result false "isolation: CDP and the stream listen on loopback only" "$listeners"
! grep -qE ':6008 ' <<<"$listeners" && result true "isolation: the display has no TCP listener" || result false "isolation: the display has no TCP listener"
commands=$(ps -u browser -o args= | tr '\n' ' ')
! grep -q 'no-sandbox' <<<"$commands" && result true "isolation: no browser process runs without its sandbox" || result false "isolation: no browser process runs without its sandbox"
grep -q 'user-data-dir='"$PROFILE" <<<"$commands" && result true "isolation: the browser uses this bot's profile" || result false "isolation: the browser uses this bot's profile"
grep -q 'x11vnc -display :8 -viewonly' <<<"$commands" && result true "isolation: the stream is view-only" || result false "isolation: the stream is view-only"
grep -q 'adequately sandboxed' <<<"$(probe sandbox "$CDP" 2>&1)" && result true "isolation: chrome://sandbox reports a working sandbox" || result false "isolation: chrome://sandbox reports a working sandbox"
same "isolation: keys sent through the stream change nothing" "$(probe rfb-type "$CDP" "$VNC" 2>&1)" "value="
sudo -u browser DISPLAY=:8 x11vnc -display :8 -localhost -rfbport 6908 -forever -shared -nopw -noxdamage -q -bg >/dev/null 2>&1
wait_for 5 probe rfb-size 6908
typed=$(probe rfb-type "$CDP" 6908 2>&1)
pkill -u browser -f 'rfbport 6908' || true
same "isolation: the same keys through a stream with input do reach the page, so the check above can fail" "$typed" "value=xyz"
same "isolation: a bot's window on this slot does not affect the other slot's stream size" "$(probe rfb-size "$OTHER_VNC" 2>&1)" 1280x800

windows=$(probe windows "$CDP" 2>&1 | head -1)
grep -q '"left":0,"top":27,"width":1280,"height":773,"windowState":"maximized"' <<<"$windows" && result true "desktop: the window fills the area below the panel, with no second title bar" || result false "desktop: the window fills the area below the panel, with no second title bar" "$windows"

[ ! -e "$PROFILE.tmp" ] && result true "copy: a .tmp left by a kill is gone" || result false "copy: a .tmp left by a kill is gone"
[ ! -e "$PROFILE/left-by-a-kill" ] && result true "copy: nothing from the .tmp reached the profile" || result false "copy: nothing from the .tmp reached the profile"
marker=$PROFILE/marker
sudo -u browser touch "$marker"

probe rfb-hold "$VNC" 15 >/tmp/hold-$$.out 2>&1 &
holding=$!
sleep 1
browser_pid=$(pid "$BROWSER_UNIT")
stream_pid=$(pid "$STREAM_UNIT")
session_pid=$(pid "$SESSION_UNIT")
display_pid=$(pid "$DISPLAY_UNIT")
kill -9 "$browser_pid"
wait_for 2 sh -c "[ \"\$(systemctl show -p SubState --value $BROWSER_UNIT)\" = auto-restart ]"
same "Chromium killed: no process stays in its cgroup during the restart's wait" "$(unit_processes "$BROWSER_UNIT")" 0
started=$(now_ms)
systemctl start --quiet "$TARGET"
measure "start during a browser's restart wait: $(($(now_ms) - started)) ms"
check "Chromium killed: a start during the wait returns only once CDP answers" cdp_up
differ "Chromium killed: a new browser runs" "$(pid "$BROWSER_UNIT")" "$browser_pid"
same "Chromium killed: the stream's process stays" "$(pid "$STREAM_UNIT")" "$stream_pid"
same "Chromium killed: the session's process stays" "$(pid "$SESSION_UNIT")" "$session_pid"
same "Chromium killed: the display's process stays" "$(pid "$DISPLAY_UNIT")" "$display_pid"
same "Chromium killed: the target stays active" "$(state "$TARGET")" active
wait "$holding" || true
grep -qx open /tmp/hold-$$.out && result true "Chromium killed: a viewer's session stays open" || result false "Chromium killed: a viewer's session stays open" "$(cat /tmp/hold-$$.out)"
rm -f /tmp/hold-$$.out
same "Chromium killed: the other slot's browser stays" "$(pid computerd-chromium@$OTHER.service)" "$other_browser"

systemctl stop --quiet "$BROWSER_UNIT" "$STREAM_UNIT"
same "a part stopped: the target stays active" "$(state "$TARGET")" active
systemctl start --quiet "$TARGET"
check "a part stopped: a start on the active target returns only once CDP answers" cdp_up
check "a part stopped: a start on the active target brings the stream back" rfb_up

browser_pid=$(pid "$BROWSER_UNIT")
kill -9 "$browser_pid"
started=$(now_ms)
wait_for 15 cdp_up && result true "Chromium killed: with no start, it answers again within 15 s" || result false "Chromium killed: with no start, it answers again within 15 s"
measure "browser back after a kill, with no start: $(($(now_ms) - started)) ms"
check "Chromium killed: a restarted browser keeps the profile" test -f "$marker"

browser_pid=$(pid "$BROWSER_UNIT")
kill -9 "$(pid "$STREAM_UNIT")"
wait_for 10 rfb_up && result true "x11vnc killed: the stream comes back" || result false "x11vnc killed: the stream comes back"
same "x11vnc killed: Chromium's process stays" "$(pid "$BROWSER_UNIT")" "$browser_pid"

session_pid=$(pid "$SESSION_UNIT")
pkill -9 -u browser -f '^xfce4-panel' || true
wait_for 10 sh -c "[ \"\$(systemctl show -p MainPID --value $SESSION_UNIT)\" != $session_pid ] && [ \"\$(systemctl show -p ActiveState --value $SESSION_UNIT)\" = active ]" \
  && result true "Xfce killed: the session restarts" || result false "Xfce killed: the session restarts" "$(state "$SESSION_UNIT")"
same "Xfce killed: Chromium's process stays" "$(pid "$BROWSER_UNIT")" "$browser_pid"
check "Xfce killed: CDP still answers" cdp_up

kill -9 "$(pid "$DISPLAY_UNIT")"
wait_for 15 all_down && result true "Xvfb killed: every part of the slot goes down" || result false "Xvfb killed: every part of the slot goes down" "$(for unit in $PARTS; do printf '%s=%s ' "$unit" "$(state "$unit")"; done)"
sleep 5
all_down && result true "Xvfb killed: nothing comes back by itself" || result false "Xvfb killed: nothing comes back by itself"
same "Xvfb killed: no process remains" "$(slot_processes)" 0
same "Xvfb killed: the other slot's display stays" "$(pid computerd-xvfb@$OTHER.service)" "$other_display"
same "Xvfb killed: the other slot's stream stays" "$(pid computerd-vnc@$OTHER.service)" "$other_stream"
started=$(now_ms)
systemctl start --quiet "$TARGET"
measure "start after the display died, with a profile: $(($(now_ms) - started)) ms"
check "Xvfb killed: a start brings CDP back" cdp_up
check "Xvfb killed: a start brings the stream back" rfb_up
check "Xvfb killed: the same profile returns" test -f "$marker"

probe open "$CDP" "https://en.wikipedia.org/wiki/Linux" >/dev/null 2>&1 && result true "memory: a real page opens" || result false "memory: a real page opens"
sleep 5
measure "desktop with a real page: $(memory)"

started=$(now_ms)
systemctl stop --quiet "$DISPLAY_UNIT"
measure "stop of a desktop: $(($(now_ms) - started)) ms"
same "stop: no process remains when the stop returns" "$(slot_processes)" 0
! cdp_up >/dev/null 2>&1 && result true "stop: CDP's port is closed" || result false "stop: CDP's port is closed"
! ss -ltnH | grep -q ':5908 ' && result true "stop: the stream's port is closed" || result false "stop: the stream's port is closed"
same "stop: the target is inactive" "$(state "$TARGET")" inactive
check "stop: the holder file stays, because the next claim replaces it" test -f /run/computerd/desktop-$SLOT.env
same "stop: a normal stop records no failed part" "$(systemctl list-units --state=failed --plain --no-legend "computerd-*@$SLOT*" | wc -l)" 0
same "stop: the other slot's browser stays" "$(pid computerd-chromium@$OTHER.service)" "$other_browser"

dropin=/run/systemd/system/$BROWSER_UNIT.d
mkdir -p "$dropin"
cat >"$dropin/ignores-sigterm.conf" <<'CONF'
[Service]
ExecStart=
ExecStart=/bin/sh -c 'trap "" TERM; exec sleep 600'
ExecStartPost=
CONF
systemctl daemon-reload
systemctl start --quiet "$TARGET"
started=$(now_ms)
systemctl stop --quiet "$DISPLAY_UNIT"
elapsed=$(($(now_ms) - started))
measure "stop with a browser that ignores SIGTERM: $elapsed ms"
[ "$elapsed" -ge 9000 ] && result true "stop: the display's stop waits for a part that is slow to end" || result false "stop: the display's stop waits for a part that is slow to end" "$elapsed ms"
[ "$elapsed" -le 13000 ] && result true "stop: a browser that ignores SIGTERM ends within its limit" || result false "stop: a browser that ignores SIGTERM ends within its limit" "$elapsed ms"
same "stop: that stop leaves no process" "$(slot_processes)" 0
rm -rf "$dropin"
systemctl daemon-reload
systemctl reset-failed "$BROWSER_UNIT" 2>/dev/null || true

systemctl start --quiet "$TARGET"
sudo -u browser touch "$PROFILE/second-start"
systemctl stop --quiet "$DISPLAY_UNIT"
check "copy: a later start does not replace the profile" test -f "$PROFILE/second-start"
systemctl start --quiet "$TARGET"
check "copy: the same is true after a later start" test -f "$PROFILE/second-start"
systemctl stop --quiet "$DISPLAY_UNIT"

systemctl start --quiet "$TARGET" &
client=$!
sleep 0.1
kill -9 "$client" 2>/dev/null || true
wait "$client" 2>/dev/null || true
wait_for 15 cdp_up && result true "client killed: a start still finishes" || result false "client killed: a start still finishes"
wait_for 15 sh -c "[ \"\$(systemctl show -p ActiveState --value $TARGET)\" = active ]" && result true "client killed: the target ends active" || result false "client killed: the target ends active"
systemctl stop --quiet "$DISPLAY_UNIT" &
client=$!
sleep 0.05
kill -9 "$client" 2>/dev/null || true
wait "$client" 2>/dev/null || true
wait_for 15 all_down && result true "client killed: a stop still finishes" || result false "client killed: a stop still finishes"
same "client killed: that stop leaves no process" "$(slot_processes)" 0

mv "$PROFILE" "$PROFILE.moved"
install -d -o root -g root -m 0700 "$PROFILE"
started=$(now_ms)
systemctl start --quiet "$TARGET"
start_rc=$?
elapsed=$(($(now_ms) - started))
measure "start with a profile that a browser cannot open: $elapsed ms, exit $start_rc"
[ "$elapsed" -le $((SYSTEMCTL_TIMEOUT_SECONDS * 1000)) ] && result true "a broken part: the start returns within computerd's limit" || result false "a broken part: the start returns within computerd's limit" "$elapsed ms"
! cdp_up >/dev/null 2>&1 && result true "a broken part: CDP does not answer" || result false "a broken part: CDP does not answer"
check "a broken part: the stream still answers" rfb_up
systemctl stop --quiet "$DISPLAY_UNIT"
sleep 3
all_down && result true "a broken part: a stop ends the retries" || result false "a broken part: a stop ends the retries"
same "a broken part: no process remains" "$(slot_processes)" 0
rm -rf "$PROFILE"
mv "$PROFILE.moved" "$PROFILE"
systemctl reset-failed "$BROWSER_UNIT" 2>/dev/null || true

systemctl start --quiet "$TARGET"
browser_pid=$(pid "$BROWSER_UNIT")
display_pid=$(pid "$DISPLAY_UNIT")
systemctl restart computerd 2>/dev/null || true
sleep 3
same "computerd restarted: the browser's process stays" "$(pid "$BROWSER_UNIT")" "$browser_pid"
same "computerd restarted: the display's process stays" "$(pid "$DISPLAY_UNIT")" "$display_pid"
check "computerd restarted: the holder file stays" test -f /run/computerd/desktop-$SLOT.env

same "base: nothing changed the base profile" "$(base_hash)" "$base_before"

systemctl stop --quiet computerd-xvfb@$SLOT.service computerd-xvfb@$OTHER.service
if sudo -u computerd --chdir /opt/bots-computerd/current "$NODE" scripts/verify-desktops.ts; then
  result true "computerd's own code runs two bots at once, as the computerd user"
else
  result false "computerd's own code runs two bots at once, as the computerd user"
fi
rm -rf /home/browser/profiles/verifydesktopsa /home/browser/profiles/verifydesktopsb
same "base: nothing changed the base profile after that" "$(base_hash)" "$base_before"

# The reboot below looks for this profile, so it stays until the last step.
trap - EXIT
systemctl reset-failed 'computerd-*@'$SLOT'*' 'computerd-*@'$OTHER'*' 2>/dev/null || true
rm -f "$PROBE"
echo "---"
echo "passed $passes, failed $failures"
[ "$failures" -eq 0 ]
GUEST

if [ -z "${NO_REBOOT:-}" ]; then
  qm reboot "$vm" >/dev/null
  for _ in $(seq 1 80); do
    sleep 3
    qm guest cmd "$vm" ping >/dev/null 2>&1 && break
  done
  guest <<'GUEST'
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
status=0
report() {
  if [ "$1" = 0 ]; then echo "ok    reboot: $2"; else echo "FAIL  reboot: $2"; status=1; fi
}
live=$(systemctl list-units --plain --no-legend 'computerd-xvfb@*' 'computerd-chromium@*' 'computerd-desktop@*' | wc -l)
[ "$live" = 0 ]; report $? "no desktop starts by itself"
! ls /run/computerd/desktop-*.env >/dev/null 2>&1; report $? "no holder file survives"
[ -d /home/browser/profiles/verifydesktop ]; report $? "the profile remains"
exit $status
GUEST
fi

guest <<'GUEST'
rm -rf /home/browser/profiles/verifydesktop /home/browser/profiles/verifyother
rm -f /run/computerd/desktop-7.env /run/computerd/desktop-8.env
GUEST

[ "$failed" = 0 ]
