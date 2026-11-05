#!/bin/bash
# Run as root on the control VM after setup.sh and tailscale up. Pass the branch to deploy. Safe to rerun.
set -euo pipefail

BRANCH=${1:-main}
APP_DIR=/opt/bots
CONVEX_PORT=8443
LINK_HOST=10.78.0.2
SERVICE_USER=bots-orchestrator
UNIT=/etc/systemd/system/bots-orchestrator.service

dns_name=$(tailscale status --json | node -e '
  let raw = "";
  process.stdin.on("data", (part) => (raw += part)).on("end", () => {
    const { BackendState, Self } = JSON.parse(raw);
    if (BackendState === "Running") console.log(Self.DNSName.replace(/\.$/, ""));
  });
')
if [ -z "$dns_name" ]; then
  echo "This machine is not logged in to Tailscale. Run tailscale up first." >&2
  exit 1
fi

cd "$APP_DIR"
git fetch --quiet origin
git checkout --quiet "$BRANCH"
git reset --quiet --hard "origin/$BRANCH"

install -m 0644 infra/control-vm/20-bots-link.network /etc/systemd/network/20-bots-link.network
networkctl reload
for _ in $(seq 1 15); do
  ip -4 -o addr show | grep -q " $LINK_HOST/" && break
  sleep 1
done
if ! ip -4 -o addr show | grep -q " $LINK_HOST/"; then
  echo "This machine does not have the address $LINK_HOST. Run infra/proxmox/create-network.sh on the Proxmox host first." >&2
  exit 1
fi

grep -q '^AUTH_MODE=' .env.local 2>/dev/null || echo "AUTH_MODE='tailscale'" >> .env.local
grep -q '^LINK_HOST=' .env.local 2>/dev/null || echo "LINK_HOST='$LINK_HOST'" >> .env.local
grep -q '^VITE_CONVEX_URL=' apps/web/.env.local 2>/dev/null \
  || echo "VITE_CONVEX_URL='https://$dns_name:$CONVEX_PORT'" >> apps/web/.env.local
chmod 600 .env.local apps/web/.env.local

CI=true pnpm install --frozen-lockfile --silent
pnpm bootstrap
pnpm --filter @bots/web run build >/dev/null

# The SSH login has sudo, and a process can take over another process of its own user. So the service needs a user of its own.
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
chown "$SERVICE_USER:$SERVICE_USER" .env.local
install -m 0644 infra/control-vm/bots-orchestrator.service "$UNIT"
systemctl daemon-reload
systemctl enable --quiet bots-orchestrator
systemctl restart bots-orchestrator

tailscale serve --bg --https=443 http://127.0.0.1:8787 >/dev/null
tailscale serve --bg --https="$CONVEX_PORT" http://127.0.0.1:3210 >/dev/null

echo "deployed $(git rev-parse --short HEAD) at https://$dns_name"
