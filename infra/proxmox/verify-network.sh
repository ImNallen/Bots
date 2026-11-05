#!/bin/bash
# Run on the Proxmox host. Pass two running user VMs on the user network. The first probes, and the second is the
# machine it must not reach. Exits 0 only if every check passes.
#
# Set QUICK=1 to scan a sample of ports instead of all of them. A check that a friend's access depends on must not set it.
set -euo pipefail

probe_vm=${1:?usage: verify-network.sh PROBE_VMID PEER_VMID}
peer_vm=${2:?usage: verify-network.sh PROBE_VMID PEER_VMID}

here=$(dirname "$(realpath "$0")")
LINK=10.78.0.2:8788
GATEWAY=10.77.0.1
CONTROL_GATEWAY=10.78.0.1
CONTROL_VMID=110
SPOOF=10.77.0.250
SPOOF_MAC=02:00:00:bb:07:01
VM_NETWORK=botsvms
PROBE_TIMEOUT=2400

failures=0
passes=0

result() {
  if [ "$1" = true ]; then
    passes=$((passes + 1))
    echo "ok    $2"
  else
    failures=$((failures + 1))
    echo "FAIL  $2${3:+ [$3]}"
  fi
}

check() {
  local label=$1
  shift
  if "$@" >/dev/null 2>&1; then result true "$label"; else result false "$label"; fi
}

field() {
  python3 -c 'import json, sys; print(json.load(sys.stdin).get(sys.argv[1], ""), end="")' "$1"
}

guest_output() {
  local vm=$1
  shift
  qm guest exec "$vm" --timeout 60 -- "$@" | field out-data
}

require() {
  if [ -z "$2" ]; then
    echo "Could not read $1, so this check cannot run" >&2
    exit 2
  fi
}

static_address() {
  qm config "$1" | sed -n 's/^ipconfig0: ip=\([0-9.]*\).*/\1/p'
}

guest_mac() {
  qm config "$1" | sed -n 's/^net0: virtio=\([0-9A-Fa-f:]*\).*/\1/p' | tr 'A-F' 'a-f'
}

probe=$(static_address "$probe_vm")
peer=$(static_address "$peer_vm")
probe_mac=$(guest_mac "$probe_vm")
peer_mac=$(guest_mac "$peer_vm")
host_lan=$(ip -4 -o addr show dev vmbr0 | awk '{ print $4 }' | cut -d/ -f1)
router=$(ip -4 route show default | awk '{ print $3 }')
control_lan=$(guest_output "$CONTROL_VMID" ip -4 -o addr show dev eth0 | awk '{ print $4 }' | cut -d/ -f1)
control_tailnet=$(guest_output "$CONTROL_VMID" tailscale ip -4 | tr -d '[:space:]')
control_tailnet6=$(guest_output "$CONTROL_VMID" tailscale ip -6 | tr -d '[:space:]')

require "the probe's address" "$probe"
require "the peer's address" "$peer"
require "the probe's MAC address" "$probe_mac"
require "the peer's MAC address" "$peer_mac"
require "this host's LAN address" "$host_lan"
require "the router's address" "$router"
require "the control VM's LAN address" "$control_lan"
require "the control VM's tailnet IPv4 address" "$control_tailnet"
require "the control VM's tailnet IPv6 address" "$control_tailnet6"

check "host: the bots_guard table is loaded" nft list table inet bots_guard
check "host: bots-guard.service loads the table at boot" systemctl is-enabled bots-guard.service
[ -z "$(systemctl show -p RequiredBy --value bots-guard.service)" ] && free=true || free=false
result "$free" "host: restarting bots-guard.service cannot stop guests, because nothing requires it"
systemctl cat pve-guests.service | grep -q '^ExecStartPre=.*home_public' && gated=true || gated=false
result "$gated" "host: guests do not autostart without the home public address in the table"
nft list set inet bots_guard home_public | grep -q elements && loaded=true || loaded=false
result "$loaded" "host: the table holds the home public address"
check "host: a timer keeps the home public address current" systemctl is-active bots-guard-public-ip.timer
isolate=$(pvesh get "/cluster/sdn/vnets/$VM_NETWORK" --output-format json | field isolate-ports)
[ "$isolate" = 1 ] && isolated=true || isolated=false
result "$isolated" "host: $VM_NETWORK has isolate-ports set"

for vm in "$probe_vm" "$peer_vm"; do
  net=$(qm config "$vm" | sed -n 's/^net0: //p')
  case "$net" in *"bridge=$VM_NETWORK"*) on_network=true ;; *) on_network=false ;; esac
  result "$on_network" "VM $vm: net0 is on $VM_NETWORK"
  case "$net" in *firewall=1*) flagged=true ;; *) flagged=false ;; esac
  result "$flagged" "VM $vm: net0 has firewall=1"
  options=$(pvesh get "/nodes/$(hostname)/qemu/$vm/firewall/options" --output-format json)
  for option in enable ipfilter macfilter; do
    [ "$(field "$option" <<<"$options")" = 1 ] && set_on=true || set_on=false
    result "$set_on" "VM $vm: the firewall option $option is on"
  done
  bridge -d link show dev "fwpr${vm}p0" 2>/dev/null | grep -q 'isolated on' && port=true || port=false
  result "$port" "VM $vm: its bridge port is isolated"
done

guest_output "$peer_vm" python3 -c 'import socket; socket.create_connection(("1.1.1.1", 443), 5).close()' >/dev/null || true
neighbor() {
  ip -json neigh show to "$peer" dev "$VM_NETWORK" 2>/dev/null \
    | python3 -c 'import json, sys; rows = json.load(sys.stdin); print(rows[0].get("lladdr", "") if rows else "", end="")'
}
peer_mac_before=$(neighbor)

# A spoofed or one-way packet gets no reply, so the probe cannot tell whether it left. These captures can.
# The peer's capture sits on its bridge port, ahead of the peer's own firewall, so that firewall cannot hide a packet.
captures=$(mktemp -d)
declare -A capture_pid
capture() {
  local name=$1 interface=$2 filter=$3
  tcpdump -nn -l -i "$interface" "$filter" >"$captures/$name" 2>"$captures/$name.err" &
  capture_pid[$name]=$!
}
stop_captures() {
  [ "${#capture_pid[@]}" -gt 0 ] && kill "${capture_pid[@]}" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap 'stop_captures; rm -rf "$captures"' EXIT

peer_port="fwpr${peer_vm}p0"
capture peer "$peer_port" "ether src $probe_mac or src host $probe"
capture source "$VM_NETWORK" "ip and ether src $probe_mac and not src host $probe"
capture mac "$VM_NETWORK" "ether src $SPOOF_MAC"
capture arp "$VM_NETWORK" "arp and ether src $probe_mac and arp[14:4] != 0x$(printf '%02x' ${probe//./ })"
capture probe_traffic "$VM_NETWORK" "ip and ether src $probe_mac and src host $probe"
capture peer_traffic "$peer_port" "ether src $peer_mac"
sleep 2

for name in "${!capture_pid[@]}"; do
  grep -q 'listening on' "$captures/$name.err" && started=true || started=false
  result "$started" "capture $name: tcpdump started" "$(head -1 "$captures/$name.err")"
done

quick=()
[ "${QUICK:-}" = 1 ] && quick=(--quick)
output=$(qm guest exec "$probe_vm" --timeout "$PROBE_TIMEOUT" --pass-stdin 1 -- python3 - \
  --link "$LINK" --peer "$peer" --spoof "$SPOOF" --gateway "$GATEWAY" --control-gateway "$CONTROL_GATEWAY" \
  --host-lan "$host_lan" --control-lan "$control_lan" --router "$router" \
  --control-tailnet "$control_tailnet" --control-tailnet6 "$control_tailnet6" \
  "${quick[@]}" <"$here/network-probe.py")

exit_code=$(field exitcode <<<"$output")
rows=$(field out-data <<<"$output")
while IFS= read -r row; do
  [ -n "$row" ] || continue
  ok=$(python3 -c 'import json, sys; print(str(json.loads(sys.argv[1])["ok"]).lower(), end="")' "$row")
  label=$(python3 -c 'import json, sys; print(json.loads(sys.argv[1])["check"], end="")' "$row")
  detail=$(python3 -c 'import json, sys; print(json.loads(sys.argv[1])["detail"], end="")' "$row")
  result "$ok" "$label" "$detail"
done <<<"$rows"

[ "$exit_code" = 0 ] && finished=true || finished=false
result "$finished" "probe: finished without an error" "$(field err-data <<<"$output" | tail -3 | tr '\n' ' ')"

guest_output "$peer_vm" python3 -c 'import socket; socket.create_connection(("1.1.1.1", 443), 5).close()' >/dev/null || true
sleep 1

for name in "${!capture_pid[@]}"; do
  kill -0 "${capture_pid[$name]}" 2>/dev/null && alive=true || alive=false
  result "$alive" "capture $name: tcpdump was still running at the end"
done
stop_captures

saw() {
  grep -c . "$captures/$1" || true
}
witness() {
  local count
  count=$(saw "$1")
  [ "$count" -eq 0 ] && result true "$2" || result false "$2" "$count packets, first: $(head -1 "$captures/$1")"
}
control() {
  local count
  count=$(saw "$1")
  [ "$count" -gt 0 ] && result true "$2 ($count packets)" || result false "$2"
}
control probe_traffic "control: the capture on the bridge saw the probe's real traffic"
control peer_traffic "control: the capture on the peer's port saw the peer's real traffic"
witness peer "witness: nothing from the probe reached the peer's port"
witness source "witness: no packet with a source address other than the probe's reached the bridge"
witness mac "witness: no frame from a changed MAC address reached the bridge"
witness arp "witness: no ARP claim for another address reached the bridge"

peer_mac_after=$(neighbor)
[ -n "$peer_mac_before" ] && had_entry=true || had_entry=false
result "$had_entry" "host: an entry for $peer existed, so the ARP claim had something to change"
[ "$peer_mac_after" != "$probe_mac" ] && held=true || held=false
result "$held" "host: the ARP claim did not move $peer to the probe's MAC" "before $peer_mac_before, after $peer_mac_after, probe $probe_mac"

echo "---"
echo "passed $passes, failed $failures, probe VM $probe_vm at $probe, peer VM $peer_vm at $peer"
[ "$failures" -eq 0 ]
