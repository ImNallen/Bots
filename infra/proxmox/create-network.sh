#!/bin/bash
# Run on the Proxmox host. Creates the isolated networks for user VMs. Safe to rerun.
set -euo pipefail

ZONE=bots
VM_NETWORK=botsvms
VM_SUBNET=10.77.0.0/24
VM_GATEWAY=10.77.0.1
CONTROL_NETWORK=botsctl
CONTROL_SUBNET=10.78.0.0/30
CONTROL_GATEWAY=10.78.0.1
CONTROL_VMID=110

here=$(dirname "$(realpath "$0")")

exists() {
  pvesh get "$1" --output-format json >/dev/null 2>&1
}

# The rules go in first, so these networks never exist without them.
install -D -m 0644 "$here/bots-guard.nft" /etc/bots/bots-guard.nft
install -m 0644 "$here/bots-guard.service" /etc/systemd/system/bots-guard.service
systemctl daemon-reload
systemctl enable --quiet bots-guard.service
systemctl restart bots-guard.service

exists "/cluster/sdn/zones/$ZONE" \
  || pvesh create /cluster/sdn/zones --zone "$ZONE" --type simple --ipam pve

# Port isolation stops one VM's frames from reaching another VM on this bridge.
exists "/cluster/sdn/vnets/$VM_NETWORK" \
  || pvesh create /cluster/sdn/vnets --vnet "$VM_NETWORK" --zone "$ZONE" --isolate-ports 1
exists "/cluster/sdn/vnets/$CONTROL_NETWORK" \
  || pvesh create /cluster/sdn/vnets --vnet "$CONTROL_NETWORK" --zone "$ZONE"

exists "/cluster/sdn/vnets/$VM_NETWORK/subnets/$ZONE-${VM_SUBNET/\//-}" \
  || pvesh create "/cluster/sdn/vnets/$VM_NETWORK/subnets" \
    --subnet "$VM_SUBNET" --type subnet --gateway "$VM_GATEWAY" --snat 1
exists "/cluster/sdn/vnets/$CONTROL_NETWORK/subnets/$ZONE-${CONTROL_SUBNET/\//-}" \
  || pvesh create "/cluster/sdn/vnets/$CONTROL_NETWORK/subnets" \
    --subnet "$CONTROL_SUBNET" --type subnet --gateway "$CONTROL_GATEWAY"

pvesh set /cluster/sdn >/dev/null

for _ in $(seq 1 30); do
  if ip -4 addr show "$VM_NETWORK" 2>/dev/null | grep -q "$VM_GATEWAY" \
    && ip -4 addr show "$CONTROL_NETWORK" 2>/dev/null | grep -q "$CONTROL_GATEWAY"; then
    nft list table inet bots_guard >/dev/null
    if ! qm config "$CONTROL_VMID" | grep -q '^net1:'; then
      qm set "$CONTROL_VMID" --net1 "virtio,bridge=$CONTROL_NETWORK" >/dev/null
    fi
    echo "networks ready: $VM_NETWORK $VM_SUBNET, $CONTROL_NETWORK $CONTROL_SUBNET, VM $CONTROL_VMID attached"
    exit 0
  fi
  sleep 2
done
echo "The networks did not come up. Check the SDN apply task on this host." >&2
exit 1
