#!/bin/bash
# desktop.sh N : start display :N with xfce pieces, a view-only stream, and an input stream. Runs as the browser user.
N=$1
export DISPLAY=:$N XDG_RUNTIME_DIR=/tmp/xdg-$N HOME=/home/browser
mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
nohup Xvfb :$N -screen 0 1280x800x24 -nolisten tcp -noreset >/tmp/xvfb$N.log 2>&1 &
sleep 0.5
eval "$(dbus-launch --sh-syntax)"
echo "$DBUS_SESSION_BUS_ADDRESS" > /tmp/dbus$N
nohup xfwm4 --compositor=off >/tmp/xfwm$N.log 2>&1 &
nohup xfdesktop >/tmp/xfdesktop$N.log 2>&1 &
nohup xfce4-panel >/tmp/panel$N.log 2>&1 &
sleep 1
nohup x11vnc -display :$N -viewonly -localhost -rfbport $((5900+N)) -forever -shared -nopw -noxdamage -skip_lockkeys -q >/tmp/vncv$N.log 2>&1 &
nohup x11vnc -display :$N -localhost -rfbport $((6900+N)) -forever -shared -nopw -noxdamage -skip_lockkeys -q >/tmp/vnci$N.log 2>&1 &
sleep 0.5
