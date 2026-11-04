#!/bin/bash
# Run on the Proxmox host. Creates or removes the two throwaway VMs that verify-network.sh needs.
set -euo pipefail

IMAGE=/var/lib/vz/import/debian-13-genericcloud-amd64.qcow2
VENDOR_SNIPPET=bots-control-vendor.yaml
PROBES=("901 10.77.0.11" "902 10.77.0.12")
node=$(hostname)

if [ "${1:-}" = --remove ]; then
  for probe in "${PROBES[@]}"; do
    vm=${probe% *}
    qm config "$vm" >/dev/null 2>&1 || continue
    qm stop "$vm" >/dev/null 2>&1 || true
    qm destroy "$vm" --purge 1 >/dev/null
    echo "removed VM $vm"
  done
  exit 0
fi

for probe in "${PROBES[@]}"; do
  vm=${probe% *}
  address=${probe#* }
  if ! qm config "$vm" >/dev/null 2>&1; then
    qm create "$vm" --name "net-probe-$vm" --tags bots-probe --ostype l26 --cpu host --cores 2 --memory 1536 \
      --balloon 0 --agent enabled=1 --serial0 socket --vga serial0 --scsihw virtio-scsi-single \
      --scsi0 "local-lvm:0,import-from=$IMAGE,discard=on,iothread=1,ssd=1" --ide2 local-lvm:cloudinit \
      --boot order=scsi0 --ciuser probe --cicustom "vendor=local:snippets/$VENDOR_SNIPPET" --nameserver 1.1.1.1 \
      --net0 virtio,bridge=botsvms,firewall=1 --ipconfig0 "ip=$address/24,gw=10.77.0.1" >/dev/null
    qm disk resize "$vm" scsi0 6G >/dev/null
  fi
  firewall=/nodes/$node/qemu/$vm/firewall
  pvesh get "$firewall/ipset/ipfilter-net0" --output-format json >/dev/null 2>&1 \
    || pvesh create "$firewall/ipset" --name ipfilter-net0 >/dev/null
  pvesh get "$firewall/ipset/ipfilter-net0/$address" --output-format json >/dev/null 2>&1 \
    || pvesh create "$firewall/ipset/ipfilter-net0" --cidr "$address" >/dev/null
  pvesh set "$firewall/options" --enable 1 --ipfilter 1 --macfilter 1 --policy_in DROP --policy_out ACCEPT \
    --dhcp 0 --ndp 0 --radv 0 >/dev/null
  qm status "$vm" | grep -q running || qm start "$vm" >/dev/null
  for _ in $(seq 1 80); do
    qm guest cmd "$vm" ping >/dev/null 2>&1 && break
    sleep 3
  done
  qm guest cmd "$vm" ping >/dev/null
  echo "VM $vm ready at $address"
done
