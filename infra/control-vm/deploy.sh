#!/bin/bash
# Run as root on the control VM after setup.sh and tailscale up. Pass the branch to deploy. Safe to rerun.
set -euo pipefail

BRANCH=${1:-main}
APP_DIR=/opt/bots
CONVEX_PORT=8443
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

grep -q '^AUTH_MODE=' .env.local 2>/dev/null || echo "AUTH_MODE='tailscale'" >> .env.local
grep -q '^VITE_CONVEX_URL=' apps/web/.env.local 2>/dev/null \
  || echo "VITE_CONVEX_URL='https://$dns_name:$CONVEX_PORT'" >> apps/web/.env.local
chmod 600 .env.local apps/web/.env.local

CI=true pnpm install --frozen-lockfile --silent
pnpm bootstrap
pnpm --filter @bots/web run build >/dev/null

# Only the orchestrator's process needs to read its secrets. It cannot change its own code, and it is not in the docker group.
chown bots:bots .env.local
install -m 0644 infra/control-vm/bots-orchestrator.service "$UNIT"
systemctl daemon-reload
systemctl enable --quiet bots-orchestrator
systemctl restart bots-orchestrator

tailscale serve --bg --https=443 http://127.0.0.1:8787 >/dev/null
tailscale serve --bg --https="$CONVEX_PORT" http://127.0.0.1:3210 >/dev/null

echo "deployed $(git rev-parse --short HEAD) at https://$dns_name"
