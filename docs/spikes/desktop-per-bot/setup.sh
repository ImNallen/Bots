set -euo pipefail
export HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive
cloud-init status --wait >/dev/null || true
apt-get update -qq
before=$(df --output=used -m / | tail -1)
apt-get install -y -qq --no-install-recommends chromium xvfb x11vnc x11-utils xdotool dbus-x11 xfwm4 xfce4-panel xfdesktop4 xfce4-terminal xfconf xfce4-settings thunar fonts-liberation fonts-noto-color-emoji sqlite3 >/dev/null 2>&1
after=$(df --output=used -m / | tail -1)
echo "chromium and xfce packages MB: $((after-before))"
curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && apt-get install -y -qq --no-install-recommends /tmp/chrome.deb >/dev/null 2>&1 && echo "chrome installed: $(google-chrome --version 2>/dev/null)" || echo "chrome did not install"
rm -f /tmp/chrome.deb
id browser >/dev/null 2>&1 || useradd --create-home --shell /bin/bash browser
chromium --version --no-sandbox 2>/dev/null | head -1; dpkg -l | awk '/xfwm4 /{print "xfwm4", $3}'
