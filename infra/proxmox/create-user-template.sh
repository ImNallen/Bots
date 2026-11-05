#!/bin/bash
# Run on the Proxmox host, after create-control-vm.sh and create-network.sh. Pass the Git ref to install.
# Builds VM 9000, the template that user VMs clone. An unfinished build starts over, and a finished one stays.
set -euo pipefail

VMID=9000
NAME=bots-user-template
TAG=bots-template
ADDRESS=10.77.0.2
IMAGE=/var/lib/vz/import/debian-13-genericcloud-amd64.qcow2
VENDOR_SNIPPET=bots-control-vendor.yaml
DISK=8G
BUILD_TIMEOUT_SECONDS=900

ref=${1:?usage: create-user-template.sh GIT_REF}
here=$(dirname "$(realpath "$0")")
firewall=/nodes/$(hostname)/qemu/$VMID/firewall

if qm config "$VMID" >/dev/null 2>&1; then
  if ! qm config "$VMID" | grep -qx "tags: $TAG"; then
    echo "VM $VMID exists without the tag $TAG, so this script will not touch it" >&2
    exit 1
  fi
  if qm config "$VMID" | grep -qx "template: 1"; then
    echo "VM $VMID is already a template. User VMs are full clones, so to rebuild it, run: qm destroy $VMID --purge 1" >&2
    exit 0
  fi
  qm stop "$VMID" --skiplock 1 >/dev/null 2>&1 || true
  qm destroy "$VMID" --purge 1 --skiplock 1 >/dev/null
fi

qm create "$VMID" --name "$NAME" --tags "$TAG" --ostype l26 --cpu host --cores 2 --memory 2048 \
  --balloon 0 --agent enabled=1 --serial0 socket --vga serial0 --scsihw virtio-scsi-single \
  --scsi0 "local-lvm:0,import-from=$IMAGE,discard=on,iothread=1,ssd=1" --ide2 local-lvm:cloudinit \
  --boot order=scsi0 --cicustom "vendor=local:snippets/$VENDOR_SNIPPET" --nameserver 1.1.1.1 \
  --net0 virtio,bridge=botsvms,firewall=1 --ipconfig0 "ip=$ADDRESS/24,gw=10.77.0.1" >/dev/null
qm disk resize "$VMID" scsi0 "$DISK" >/dev/null

pvesh create "$firewall/ipset" --name ipfilter-net0 >/dev/null
pvesh create "$firewall/ipset/ipfilter-net0" --cidr "$ADDRESS" >/dev/null
pvesh set "$firewall/options" --enable 1 --ipfilter 1 --macfilter 1 --policy_in DROP --policy_out ACCEPT \
  --dhcp 0 --ndp 0 --radv 0 >/dev/null

qm start "$VMID" >/dev/null
for _ in $(seq 1 80); do
  qm guest cmd "$VMID" ping >/dev/null 2>&1 && break
  sleep 3
done
qm guest cmd "$VMID" ping >/dev/null

run_in_vm() { # a script file, then its arguments
  local script=$1
  shift
  local result
  result=$(qm guest exec "$VMID" --pass-stdin 1 --timeout "$BUILD_TIMEOUT_SECONDS" -- bash -s -- "$@" < "$script")
  if [ "$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("exitcode"))' "$result")" != 0 ]; then
    echo "The build failed inside VM $VMID:" >&2
    python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(d.get("err-data","")); print(d.get("out-data",""))' "$result" >&2
    exit 1
  fi
  python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("out-data",""))' "$result"
}

run_in_vm "$here/user-vm-setup.sh" >/dev/null
commit=$(run_in_vm "$here/install-computerd.sh" "$ref" | grep -Ex '[0-9a-f]{40}')
# Each clone must get its own machine ID and SSH host keys, and cloud-init must run again to set its name and address.
run_in_vm /dev/stdin >/dev/null <<'GUEST'
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
apt-get clean
cloud-init clean --logs --machine-id
fstrim --all
GUEST

qm shutdown "$VMID" --timeout 120 >/dev/null
# The image now holds the guest agent. A clone must not spend its first boot on the snippet's package update.
qm set "$VMID" --delete cicustom,ipconfig0 --description "computerd $commit" >/dev/null
qm template "$VMID" >/dev/null
# Destroying the old template took it out of the pool, and the orchestrator's token can clone only what the pool holds.
if pvesh get /pools/bots --output-format json >/dev/null 2>&1; then
  pvesh set /pools/bots --vms "$VMID" >/dev/null
fi
echo "VM $VMID is a template with computerd at $commit"
