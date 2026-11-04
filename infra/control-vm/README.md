# How to deploy the control VM

These steps put the orchestrator, Convex, and the web app on one Proxmox VM, reachable only over Tailscale.

## Create the VM

1. Copy `infra/proxmox/create-control-vm.sh` and a file of SSH public keys to the Proxmox host.
2. Run the script on the host, with the path of the keys file. It prints the VM's LAN address.

	```sh
	bash create-control-vm.sh /root/bots-ssh-keys.pub
	```

The script creates VM 110, `bots-control`, from the Debian 13 cloud image. It refuses to touch a VM 110 with another name.

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

The script builds the app, deploys the Convex functions, restarts `bots-orchestrator`, and configures `tailscale serve`. Port 443 serves the web app, and port 8443 serves Convex. The service runs as its own user, `bots-orchestrator`, which has no `sudo` and no Docker access. To read the VM's address, run `sudo tailscale serve status`.

To read the orchestrator's logs, run `journalctl -u bots-orchestrator`. To open the Convex dashboard, forward ports 6791 and 3210, because the dashboard's page calls Convex directly: `ssh -L 6791:127.0.0.1:6791 -L 3210:127.0.0.1:3210 bots@<VM address>`. Then run `sudo cat /opt/bots/packages/convex/.env.local` on the VM to read the admin key.

## Add a user

In the Tailscale admin console, open the `bots-control` machine and select **Share**. Share only this machine. A friend's tailnet then reaches this one machine, and this machine cannot start connections to it.

## Check it

From a device on the tailnet, run the check with the VM's address and its LAN address:

```sh
pnpm verify:tailnet https://bots-control.<tailnet>.ts.net 192.168.1.161
```

Each run adds a bot named `verify-tailnet-*` to your list, because bots cannot be deleted yet.
