#!/bin/bash
# From a VM, the home network's public address reaches the router's own services through hairpin NAT, and it looks like
# any other public address. So the guard needs to know it.
set -euo pipefail

CACHE=/var/lib/bots/public-ip

if [ "${1:-}" = --cached ]; then
  address=$(cat "$CACHE" 2>/dev/null || true)
  [ -n "$address" ] || exit 0
else
  address=$(curl -fsS --max-time 10 https://api.ipify.org)
fi
if ! [[ "$address" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  echo "Not an IPv4 address: $address" >&2
  exit 1
fi

nft -f - <<NFT
flush set inet bots_guard home_public
add element inet bots_guard home_public { $address }
NFT

install -d /var/lib/bots
printf '%s\n' "$address" >"$CACHE.tmp"
mv "$CACHE.tmp" "$CACHE"
