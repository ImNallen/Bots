#!/bin/bash
# Run on the Proxmox host. Pass a file of SSH public keys. Safe to rerun, and safe after being killed midway.
set -euo pipefail

VMID=110
NAME=bots-control
STORAGE=local-lvm
BRIDGE=vmbr0
MEMORY_MB=8192
CORES=4
DISK=100G
IMAGE_BASE=https://cloud.debian.org/images/cloud/trixie/latest
IMAGE=debian-13-genericcloud-amd64.qcow2
IMPORT_DIR=/var/lib/vz/import
VENDOR_SNIPPET=bots-control-vendor.yaml

keys_file=${1:?usage: create-control-vm.sh SSH_PUBLIC_KEYS_FILE}

if [ -f "/etc/pve/qemu-server/$VMID.conf" ]; then
  have=$(qm config "$VMID" | sed -n 's/^name: //p')
  if [ "$have" != "$NAME" ]; then
    echo "VM $VMID already exists and is named $have, so this script will not touch it" >&2
    exit 1
  fi
else
  mkdir -p "$IMPORT_DIR"
  cd "$IMPORT_DIR"
  curl -fsSL -o SHA512SUMS.tmp "$IMAGE_BASE/SHA512SUMS"
  if ! grep " $IMAGE\$" SHA512SUMS.tmp | sha512sum --check --status 2>/dev/null; then
    curl -fsSL -o "$IMAGE.tmp" "$IMAGE_BASE/$IMAGE"
    mv "$IMAGE.tmp" "$IMAGE"
    grep " $IMAGE\$" SHA512SUMS.tmp | sha512sum --check --status
  fi
  rm -f SHA512SUMS.tmp

  cat > "/var/lib/vz/snippets/$VENDOR_SNIPPET" <<'YAML'
#cloud-config
package_update: true
packages:
  - qemu-guest-agent
runcmd:
  - systemctl enable --now qemu-guest-agent
YAML

  qm create "$VMID" \
    --name "$NAME" \
    --tags bots \
    --ostype l26 \
    --cpu host \
    --cores "$CORES" \
    --memory "$MEMORY_MB" \
    --balloon 0 \
    --agent enabled=1 \
    --onboot 1 \
    --startup order=10,up=30,down=60 \
    --serial0 socket \
    --vga serial0 \
    --scsihw virtio-scsi-single \
    --scsi0 "$STORAGE:0,import-from=$IMPORT_DIR/$IMAGE,discard=on,iothread=1,ssd=1" \
    --ide2 "$STORAGE:cloudinit" \
    --boot order=scsi0 \
    --net0 "virtio,bridge=$BRIDGE" \
    --ipconfig0 ip=dhcp \
    --ciuser bots \
    --sshkeys "$keys_file" \
    --cicustom "vendor=local:snippets/$VENDOR_SNIPPET"
fi

if ! qm status "$VMID" | grep -q running; then
  qm disk resize "$VMID" scsi0 "$DISK"
  qm start "$VMID"
fi

for _ in $(seq 1 90); do
  address=$(qm guest cmd "$VMID" network-get-interfaces 2>/dev/null \
    | awk -F'"' '/"ip-address" :/ { print $4 }' \
    | grep -E '^192\.168\.|^10\.|^172\.' | grep -v '^172\.1[7-9]\.' | head -1 || true)
  if [ -n "$address" ]; then
    echo "$address"
    exit 0
  fi
  sleep 5
done
echo "VM $VMID did not report an address" >&2
exit 1
