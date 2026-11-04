#!/bin/bash
# Run on the Proxmox host. Pass two running user VMs on the user network. The first probes, and the second is the
# machine it must not reach. Exits 0 only if every check passes.
#
# Set QUICK=1 to scan a sample of ports instead of all of them. A release check must not set it.
set -euo pipefail

probe_vm=${1:?usage: verify-network.sh PROBE_VMID PEER_VMID}
peer_vm=${2:?usage: verify-network.sh PROBE_VMID PEER_VMID}

here=$(dirname "$(realpath "$0")")
LINK=${LINK:-10.78.0.2:8788}
GATEWAY=${GATEWAY:-10.77.0.1}
CONTROL_GATEWAY=${CONTROL_GATEWAY:-10.78.0.1}
SPOOF=${SPOOF:-10.77.0.250}
HOST_LAN=${HOST_LAN:-192.168.1.32}
CONTROL_LAN=${CONTROL_LAN:-192.168.1.161}
ROUTER=${ROUTER:-192.168.1.1}
VM_NETWORK=${VM_NETWORK:-botsvms}
SPOOF_MAC=02:00:00:bb:07:01

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

guest_address() {
  qm config "$1" | sed -n 's/^ipconfig0: ip=\([0-9.]*\).*/\1/p'
}

guest_exec() {
  local vm=$1
  shift
  qm guest exec "$vm" --timeout 1500 -- "$@"
}

field() {
  python3 -c 'import json, sys; print(json.load(sys.stdin).get(sys.argv[1], ""), end="")' "$1"
}

peer=$(guest_address "$peer_vm")
probe=$(guest_address "$probe_vm")
[ -n "$peer" ] && [ -n "$probe" ] || { echo "Both VMs need a static ipconfig0" >&2; exit 2; }

if nft list table inet bots_guard >/dev/null 2>&1; then guard=true; else guard=false; fi
result "$guard" "host: the bots_guard table is loaded"
if systemctl is-enabled --quiet bots-guard.service; then enabled=true; else enabled=false; fi
result "$enabled" "host: bots-guard.service loads the table at boot"

for vm in "$probe_vm" "$peer_vm"; do
  net=$(qm config "$vm" | sed -n 's/^net0: //p')
  case "$net" in *"bridge=$VM_NETWORK"*) on_network=true ;; *) on_network=false ;; esac
  result "$on_network" "VM $vm: net0 is on $VM_NETWORK"
  case "$net" in *firewall=1*) flagged=true ;; *) flagged=false ;; esac
  result "$flagged" "VM $vm: net0 has firewall=1"
  options=$(pvesh get "/nodes/$(hostname)/qemu/$vm/firewall/options" --output-format json)
  [ "$(field enable <<<"$options")" = 1 ] && enabled=true || enabled=false
  result "$enabled" "VM $vm: the firewall is enabled"
  [ "$(field ipfilter <<<"$options")" = 1 ] && filtered=true || filtered=false
  result "$filtered" "VM $vm: the IP filter is on"
done

# The ARP claim only changes an entry that already exists, so the peer must speak first.
guest_exec "$peer_vm" python3 -c 'import socket; socket.create_connection(("1.1.1.1", 443), 5).close()' >/dev/null || true
neighbor() {
  ip -json neigh show to "$peer" dev "$VM_NETWORK" 2>/dev/null \
    | python3 -c 'import json, sys; rows = json.load(sys.stdin); print(rows[0].get("lladdr", "") if rows else "", end="")'
}
peer_mac_before=$(neighbor)

probe_guest_mac=$(qm config "$probe_vm" | sed -n 's/^net0: virtio=\([0-9A-Fa-f:]*\).*/\1/p' | tr 'A-F' 'a-f')

# A spoofed or one-way packet gets no reply, so the probe cannot tell whether it left. These captures can.
captures=$(mktemp -d)
capture_pids=()
capture() {
  local name=$1 interface=$2 filter=$3
  tcpdump -nn -l -i "$interface" "$filter" >"$captures/$name" 2>/dev/null &
  capture_pids+=($!)
}
stop_captures() {
  [ "${#capture_pids[@]}" -gt 0 ] && kill "${capture_pids[@]}" 2>/dev/null || true
  wait 2>/dev/null || true
  capture_pids=()
}
trap 'stop_captures; rm -rf "$captures"' EXIT
capture peer "tap${peer_vm}i0" "ether src $probe_guest_mac or src host $probe"
capture source "$VM_NETWORK" "ip and ether src $probe_guest_mac and not src host $probe"
capture mac "$VM_NETWORK" "ether src $SPOOF_MAC"
capture arp "$VM_NETWORK" "arp and ether src $probe_guest_mac and arp[14:4] != 0x$(printf '%02x' ${probe//./ })"
sleep 1

quick=()
[ "${QUICK:-}" = 1 ] && quick=(--quick)
output=$(qm guest exec "$probe_vm" --timeout 1500 --pass-stdin 1 -- python3 - \
  --link "$LINK" --peer "$peer" --spoof "$SPOOF" --gateway "$GATEWAY" --control-gateway "$CONTROL_GATEWAY" \
  --host-lan "$HOST_LAN" --control-lan "$CONTROL_LAN" --router "$ROUTER" \
  --control-tailnet "${CONTROL_TAILNET:-}" --control-tailnet6 "${CONTROL_TAILNET6:-}" \
  "${quick[@]}" <"$here/network-probe.py")

exit_code=$(field exitcode <<<"$output")
rows=$(field out-data <<<"$output")
while IFS= read -r row; do
  [ -n "$row" ] || continue
  ok=$(python3 -c 'import json, sys; print(str(json.loads(sys.argv[1])["ok"]).lower(), end="")' "$row")
  check=$(python3 -c 'import json, sys; print(json.loads(sys.argv[1])["check"], end="")' "$row")
  detail=$(python3 -c 'import json, sys; print(json.loads(sys.argv[1])["detail"], end="")' "$row")
  result "$ok" "$check" "$detail"
done <<<"$rows"

[ "$exit_code" = 0 ] && finished=true || finished=false
result "$finished" "probe: finished without an error" "$(field err-data <<<"$output" | tail -3 | tr '\n' ' ')"

sleep 1
stop_captures
witness() {
  local count
  count=$(grep -c . "$captures/$1" || true)
  [ "$count" -eq 0 ] && result true "$2" || result false "$2" "$count packets, first: $(head -1 "$captures/$1")"
}
witness peer "witness: nothing from the probe reached the peer's port"
witness source "witness: no packet with a source address other than the probe's reached the bridge"
witness mac "witness: no frame from a changed MAC address reached the bridge"
witness arp "witness: no ARP claim for another address reached the bridge"

peer_mac_after=$(neighbor)
[ -n "$peer_mac_before" ] && had_entry=true || had_entry=false
result "$had_entry" "host: an entry for $peer existed, so the ARP claim had something to change"
[ "$peer_mac_after" != "$probe_guest_mac" ] && held=true || held=false
result "$held" "host: the ARP claim did not move $peer to the probe's MAC" "before $peer_mac_before, after $peer_mac_after, probe $probe_guest_mac"

echo "---"
echo "passed $passes, failed $failures, probe VM $probe_vm at $probe, peer VM $peer_vm at $peer"
[ "$failures" -eq 0 ]
