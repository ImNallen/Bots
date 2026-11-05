#!/bin/bash
# Run on the Proxmox host. Clones the template into a running user VM, then prints the hash of the VM's link token.
# The VM makes its own token, so the token never leaves it. Safe to rerun, and a rerun keeps the token.
set -euo pipefail

TEMPLATE=9000
TAG=bots-user
LINK_URL=ws://10.78.0.2:8788

usage="usage: clone-user-vm.sh VMID ADDRESS CORES MEMORY_MB DISK_GB"
vmid=${1:?$usage}
address=${2:?$usage}
cores=${3:?$usage}
memory_mb=${4:?$usage}
disk_gb=${5:?$usage}
firewall=/nodes/$(hostname)/qemu/$vmid/firewall

if [[ ! $address =~ ^10\.77\.0\.[0-9]+$ ]]; then
  echo "$address is not on the user network, 10.77.0.0/24" >&2
  exit 1
fi

if qm config "$vmid" >/dev/null 2>&1; then
  if ! qm config "$vmid" | grep -qx "tags: $TAG"; then
    echo "VM $vmid exists without the tag $TAG, so this script will not touch it" >&2
    exit 1
  fi
else
  qm clone "$TEMPLATE" "$vmid" --name "bots-user-$vmid" --full 1 >/dev/null
fi

qm set "$vmid" --tags "$TAG" --cores "$cores" --memory "$memory_mb" --balloon 0 --onboot 1 --startup order=20 \
  --ipconfig0 "ip=$address/24,gw=10.77.0.1" >/dev/null
qm disk resize "$vmid" scsi0 "${disk_gb}G" >/dev/null

# A clone inherits the template's address filter, so replace that entry with this VM's address.
pvesh get "$firewall/ipset/ipfilter-net0" --output-format json >/dev/null 2>&1 \
  || pvesh create "$firewall/ipset" --name ipfilter-net0 >/dev/null
for cidr in $(pvesh get "$firewall/ipset/ipfilter-net0" --output-format json \
  | python3 -c 'import json,sys; print(" ".join(entry["cidr"] for entry in json.load(sys.stdin)))'); do
  [ "$cidr" = "$address" ] || pvesh delete "$firewall/ipset/ipfilter-net0/$cidr" >/dev/null
done
pvesh get "$firewall/ipset/ipfilter-net0/$address" --output-format json >/dev/null 2>&1 \
  || pvesh create "$firewall/ipset/ipfilter-net0" --cidr "$address" >/dev/null
pvesh set "$firewall/options" --enable 1 --ipfilter 1 --macfilter 1 --policy_in DROP --policy_out ACCEPT \
  --dhcp 0 --ndp 0 --radv 0 >/dev/null

qm status "$vmid" | grep -q running || qm start "$vmid" >/dev/null
for _ in $(seq 1 80); do
  qm guest cmd "$vmid" ping >/dev/null 2>&1 && break
  sleep 3
done
qm guest cmd "$vmid" ping >/dev/null

result=$(qm guest exec "$vmid" --pass-stdin 1 --timeout 60 -- bash -s -- "$LINK_URL" <<'GUEST'
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
env_file=/etc/computerd/env
if [ ! -f "$env_file" ]; then
  umask 077
  mkdir -p /etc/computerd
  token=$(head -c 32 /dev/urandom | base64 --wrap=0 | tr '+/' '-_' | tr -d '=')
  printf 'COMPUTER_LINK_URL=%s\nCOMPUTER_TOKEN=%s\n' "$1" "$token" > "$env_file.tmp"
  mv "$env_file.tmp" "$env_file"
fi
systemctl start computerd
sed -n 's/^COMPUTER_TOKEN=//p' "$env_file" | tr -d '\n' | sha256sum | cut -d' ' -f1
GUEST
)
report() { python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2], ""))' "$result" "$1"; }
if [ "$(report exitcode)" != 0 ]; then
  echo "VM $vmid could not set up its token:" >&2
  report err-data >&2
  exit 1
fi
echo "VM $vmid ready at $address"
echo "token hash: $(report out-data)"
