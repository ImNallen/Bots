#!/bin/bash
# Run on the Proxmox host, after create-user-template.sh. Gives the orchestrator on VM 110 a token that can act only
# on the VMs in one pool. A host-crashed clone outside the pool still needs operator repair.
# The token goes straight to VM 110, and this script never prints it. Safe to rerun.
set -euo pipefail

POOL=bots
ROLE=BotsProvisioner
USER=bots-provisioner@pve
TOKEN_NAME=reconcile
TEMPLATE=9000
CONTROL_VMID=110
CONTROL_ENV=/opt/bots/.env.local
CONTROL_CA=/etc/bots/proxmox-ca.pem
PRIVS="Datastore.AllocateSpace Datastore.Audit Pool.Audit SDN.Audit SDN.Use VM.Allocate VM.Audit VM.Clone \
VM.Config.CPU VM.Config.Cloudinit VM.Config.Disk VM.Config.Memory VM.Config.Network VM.Config.Options \
VM.GuestAgent.Audit VM.GuestAgent.Unrestricted VM.PowerMgmt"

node=$(hostname)

on_control() { # command, with stdin passed through
  local result
  result=$(qm guest exec "$CONTROL_VMID" --pass-stdin 1 --timeout 30 -- bash -c "$1")
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); sys.stdout.write(d.get("out-data","")); sys.exit(d.get("exitcode",1))' "$result"
}

pvesh get "/pools/$POOL" --output-format json >/dev/null 2>&1 || pvesh create /pools --poolid "$POOL" >/dev/null

if ! pveum role list --output-format json | python3 -c 'import json,sys; sys.exit(0 if any(r["roleid"]==sys.argv[1] for r in json.load(sys.stdin)) else 1)' "$ROLE"; then
  pveum role add "$ROLE" --privs "$PRIVS"
else
  pveum role modify "$ROLE" --privs "$PRIVS"
fi

pveum user list --output-format json | python3 -c 'import json,sys; sys.exit(0 if any(u["userid"]==sys.argv[1] for u in json.load(sys.stdin)) else 1)' "$USER" \
  || pveum user add "$USER" --comment "The orchestrator's reconcile loop. It has no password."

for path in "/pool/$POOL" /storage/local-lvm /sdn/zones/bots/botsvms; do
  pveum acl modify "$path" --users "$USER" --roles "$ROLE"
done

# Add the template, and any hand-made clones the loop is to adopt. Proxmox refuses a VM that is already a member.
members=$(pvesh get "/pools/$POOL" --output-format json | python3 -c 'import json,sys; print(" ".join(str(m["vmid"]) for m in json.load(sys.stdin)["members"]))')
wanted=$TEMPLATE
for vm in $(qm list | awk 'NR > 1 { print $1 }'); do
  if qm config "$vm" | grep -qx "tags: bots-user"; then
    wanted="$wanted $vm"
  fi
done
for vm in $wanted; do
  if ! grep -qw "$vm" <<<"$members"; then
    pvesh set "/pools/$POOL" --vms "$vm" >/dev/null
  fi
done

# The certificate goes first, because the orchestrator refuses to start with a token and no certificate.
on_control "mkdir -p /etc/bots; cat > $CONTROL_CA; chmod 0644 $CONTROL_CA" < /etc/pve/pve-root-ca.pem >/dev/null

if ! on_control "grep -q '^PROXMOX_TOKEN=' $CONTROL_ENV" </dev/null >/dev/null 2>&1; then
  # Proxmox shows a token's secret once, so a token with no copy on VM 110 has to be replaced.
  pveum user token remove "$USER" "$TOKEN_NAME" >/dev/null 2>&1 || true
  secret=$(pveum user token add "$USER" "$TOKEN_NAME" --privsep 0 --output-format json \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')
  address=$(ip -4 -o addr show vmbr0 | awk '{ sub(/\/.*/, "", $4); print $4; exit }')
  printf 'PROXMOX_URL=https://%s:8006\nPROXMOX_NODE=%s\nPROXMOX_CA_FILE=%s\nPROXMOX_TOKEN=%s!%s=%s\n' \
    "$address" "$node" "$CONTROL_CA" "$USER" "$TOKEN_NAME" "$secret" \
    | on_control "sed -i '/^PROXMOX_/d' $CONTROL_ENV; [ -z \"\$(tail -c1 $CONTROL_ENV)\" ] || echo >> $CONTROL_ENV; cat >> $CONTROL_ENV" >/dev/null
fi

echo "pool $POOL holds VMs $wanted, and VM $CONTROL_VMID has the token. Restart bots-orchestrator to load it."
