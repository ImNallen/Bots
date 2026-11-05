#!/bin/bash
# chrome.sh N PROFILE [BINARY] : start a browser on display :N with its own profile and CDP port 9300+N. Runs as the browser user.
N=$1; P=$2; B=${3:-/usr/bin/chromium}
export DISPLAY=:$N XDG_RUNTIME_DIR=/tmp/xdg-$N HOME=/home/browser DBUS_SESSION_BUS_ADDRESS=$(cat /tmp/dbus$N)
nohup "$B" --user-data-dir="$P" --password-store=basic --remote-debugging-address=127.0.0.1 --remote-debugging-port=$((9300+N)) --no-first-run --no-default-browser-check --disable-gpu --hide-crash-restore-bubble --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --window-size=1280,760 --window-position=0,0 about:blank >/tmp/chrome$N.log 2>&1 &
