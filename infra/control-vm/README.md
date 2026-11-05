# How to deploy the control VM

These steps put the orchestrator, Convex, and the web app on one Proxmox VM, reachable only over Tailscale.

## Create the VM

1. Copy `infra/proxmox/create-control-vm.sh` and a file of SSH public keys to the Proxmox host.
2. Run the script on the host, with the path of the keys file. It prints the VM's LAN address.

	```sh
	bash create-control-vm.sh /root/bots-ssh-keys.pub
	```

The script creates VM 110, `bots-control`, from the Debian 13 cloud image. It refuses to touch a VM 110 with another name.

## Create the networks

Copy all of `infra/proxmox` to the Proxmox host, and run the network script there. It is safe to rerun, and it restarts no guest.

```sh
bash create-network.sh
```

The script creates the isolated networks for user VMs, loads the rules that hold them, and adds a second network interface to VM 110. The [architecture document](../../docs/architecture.md) explains the rules.

## Set up the machine

1. Copy `infra/control-vm/setup.sh` to the VM, and run it as root. It installs Docker, Node, pnpm, and Tailscale, and it clones this repository to `/opt/bots`.
2. Log the machine in to Tailscale.

	```sh
	sudo tailscale up --hostname=bots-control
	```

3. In the Tailscale admin console, on the **DNS** page, turn on **MagicDNS** and **HTTPS Certificates**.

## Deploy

Run the deploy script as root on the VM, with the branch to deploy. Rerun it for each update.

```sh
sudo bash /opt/bots/infra/control-vm/deploy.sh main
```

The script gives the VM its address on the control network, builds the app, deploys the Convex functions, restarts `bots-orchestrator`, and configures `tailscale serve`. Port 443 serves the web app, and port 8443 serves Convex. The service runs as its own user, `bots-orchestrator`, which has no `sudo` and no Docker access. To read the VM's address, run `sudo tailscale serve status`.

To read the orchestrator's logs, run `journalctl -u bots-orchestrator`. To open the Convex dashboard, forward ports 6791 and 3210, because the dashboard's page calls Convex directly: `ssh -L 6791:127.0.0.1:6791 -L 3210:127.0.0.1:3210 bots@<VM address>`. Then run `sudo cat /opt/bots/packages/convex/.env.local` on the VM to read the admin key.

If a change edits `deploy.sh` itself, fetch and check out the branch before you run the script. Otherwise the old script keeps running after it updates the checkout, and it skips your new steps.

## Add a user

In the Tailscale admin console, open the `bots-control` machine and select **Share**. Share only this machine. A friend's tailnet then reaches this one machine, and this machine cannot start connections to it.

## Create a user VM by hand

The reconcile loop does not exist yet, so these steps create a user's VM. Each user has one computer, so registering a new VM makes the link refuse that user's old VM.

1. On the Proxmox host, build the template from a Git ref. The template is VM 9000. User VMs are full clones, so you can rebuild it at any time.

	```sh
	bash create-user-template.sh main
	```

2. On the host, clone the template with a VM ID, an address on `10.77.0.0/24`, the CPU cores, the memory in MB, and the disk in GB. The script prints the hash of the link token. The VM makes the token itself, and the token stays in the VM.

	```sh
	bash clone-user-vm.sh 201 10.77.0.21 2 2048 16
	```

3. On the control VM, register the hash for the user. Use the value of `JWT_ISSUER` from `/opt/bots/.env.local` as the issuer. Pass the user's current email and display name, because this call overwrites them.

	```sh
	cd /opt/bots/packages/convex
	sudo pnpm exec convex run computers:register \
	  '{"ownerSubject":"tailscale:<login>","email":"<login>","displayName":"<login>","tokenHash":"<hash>"}' \
	  --identity '{"subject":"service:orchestrator","issuer":"<JWT_ISSUER>"}'
	```

4. From a device on the tailnet, signed in as that user, run the check with the VM's name. The account needs a Mistral key, and each run adds a bot named `verify-template-*` to the list.

	```sh
	pnpm verify:template https://bots-control.<tailnet>.ts.net bots-user-201
	```

## Check it

From a device on the tailnet, run the check with the VM's address and its LAN address:

```sh
pnpm verify:tailnet https://bots-control.<tailnet>.ts.net 192.168.1.161
```

Each run adds a bot named `verify-tailnet-*` to your list, because bots cannot be deleted yet.

To prove what a user VM can reach, run these commands on the Proxmox host. The check reads the addresses of VM 110 through its guest agent. It scans every TCP port on eight machine addresses and the peer VM, and it runs packet captures on the host. The last full run took about 23 minutes.

```sh
bash create-probe-vms.sh
bash verify-network.sh 901 902
bash create-probe-vms.sh --remove
```

Set `QUICK=1` to scan a sample of ports. A check that a friend's access depends on must scan them all.
