# Roadmap

Each step ends in a check. Start the next step only after that check passes. The reasons behind these choices are in [the architecture document](architecture.md).

| Step | Status | Build | Done when |
|---|---|---|---|
| 1a | Done | Repository, Convex in Docker, dev mode, and the web shell, on a Mac | The web app shows a live Convex query, using a JWT from `/auth/token` |
| 1b | Done, with gaps listed below | Control VM, `tailscale serve`, and Tailscale mode, on Proxmox | A second Tailscale account and a phone browser see the same live query, each as its own user |
| 2 | Done | Agent loop and shell and file tools, with `computerd` in Docker | A user chats with a bot in the web UI, and killing the orchestrator mid-tool resumes the run with no duplicate side effects |
| 3 | Done, with gaps listed below | Proxmox template, reconcile loop, and network rules | Provisioning converges after being killed midway, and a script proves that a VM reaches only the internet and the orchestrator |
| 4 | **Next** | Screens, live view, take-over, and approvals | Two bots work at once while a user watches one and takes over the other from a phone |
| 5 | | Schedules, the memory UI, and the Activity view | The orchestrator rejects a write attempt from a scheduled run |
| 6 | | Friend invites | A friend goes from invite to working bot without help |
| 7 | | Tauri and Expo apps, and push | A user approves an action from a push notification |
| 8 | | OAuth connectors, the independent reviewer, and the Vault | Bots use saved logins without seeing the passwords, and bots no longer have passwordless `sudo` |

Step 3 isolates bots from the LAN. Friends join through the invites in step 6, and until then an operator declares each computer by hand.

Backups are deferred. Add off-server copies of Convex exports and the master key before anyone depends on this system.

## Where things run

- The Proxmox host is `192.168.1.32`. Log in as `root` over SSH.
- The control VM is VM 110, `bots-control`, at `192.168.1.161`. Log in as `bots` over SSH, which has passwordless `sudo`. The app is in `/opt/bots`.
- Run `sudo tailscale serve status` on the control VM to find its `https://bots-control.<tailnet>.ts.net` address.
- The service runs as `bots-orchestrator`, which has no `sudo`. Keep it separate from the `bots` login: a process can take over another process of its own user, and `bots` has `sudo`.
- The control VM deploys a branch until someone deploys another. It runs `main` now. To update it, run [the deploy script](../infra/control-vm/README.md).
- User VMs use the `botsvms` network, `10.77.0.0/24`, with the gateway at `10.77.0.1`. The control VM is `10.78.0.2` on `botsctl`, `10.78.0.0/30`. The link listens only on `10.78.0.2:8788`.
- VM 9000, `bots-user-template`, is the template for user VMs. Its description names the commit of its `computerd`. A clone updates itself to the current commit, so the template can lag behind.
- VM 201, `bots-user-201`, at `10.77.0.21`, is the owner's computer. The orchestrator's reconcile loop owns it, and it is in slot 1. Reach it with `qm guest exec` on the host, because it accepts no inbound connections and has no SSH keys.
- Your Mac has its own Convex data and its own Mistral key, separate from the control VM.

## Decisions for step 3

The user chose these:

- Each user gets one VM, and all of that user's bots share it.
- The owner's VM has 32 GB of RAM. Friends start at 8 GB and get more only if a measurement shows they need it.
- VMs use fixed memory, with no ballooning and no KSM.
- The server has 16 cores with 32 threads, a single 2 TB disk, and 91 GiB of usable RAM. Storage is `local-lvm`, which is LVM-thin.

These are proposals, so change them if you find a better answer:

- Give the owner's VM 12 vCPUs and 500 GB. Give each friend 6 vCPUs and 200 GB.
- Give the orchestrator a Proxmox API token that can only clone, configure, power, and snapshot VMs in one resource pool.
- Model each computer with desired and observed state, and converge them in a reconcile loop. Extend the `computers` table with those fields.
- Call `computers.register` from the provisioner, with a separate link token for each VM. Bind the link listener to the private network address through `LINK_HOST`. The public listener stays on `127.0.0.1`.
- Run `computerd` under systemd in the VM template, with the same `computerd` and `agent` users and sudoers rule as its Dockerfile, and with its own Node. `netguard` is for Docker on a Mac and does not apply to VMs.
- Keep the public listener away from VMs. In Tailscale mode, one header on that socket creates a token for any identity, so a VM that reaches it could act as any user. VMs reach only the link listener.

The user chose to update `computerd` in place, because bots and users install their own software on their VMs. [The architecture document](architecture.md) explains how.

### Progress on step 3

1. Done. The networks and their rules run on Proxmox, and `infra/proxmox/verify-network.sh` passes against the real control VM. That script still has to run from VMs that the template creates, because step 3's check is about those VMs.
2. Done. VM 9000 is the template, with `computerd` under systemd. A hand-cloned VM connects over the link, and `pnpm verify:template` runs a tool on it from a real chat.
3. Done. The orchestrator converges each computer from its desired state in Convex, using a Proxmox token scoped to one pool. `scripts/verify-reconcile.ts` kills it at each stage, and `pnpm test` kills it between every pair of calls against a fake Proxmox.
4. Done. The reconcile loop updates and repairs `computerd` in place, and `infra/proxmox/verify-network.sh` scanned every port from two template clones.

## After step 3: deploy from `main`

Add a systemd timer on the control VM. The server pulls, so GitHub holds no Tailscale key and no SSH key. The timer does these things:

1. Check `origin/main` every few minutes for a new commit.
2. Continue only if CI passed on that commit.
3. Run a Convex export.
4. Run `deploy.sh main`.

## Known gaps

These are open on purpose. Fix each one when the work reaches it.

- The web UI shows raw markdown.
- Long threads have no compaction, so a very long thread will eventually exceed what the model accepts.
- A bot can reach the public internet with no approval step until step 4, so a prompt-injected bot could send out anything in its workspace.
- A tool that calls `setsid` can survive a cancel or a timeout.
- A bot with `sudo` can delete the journal, and the wiped call then runs again. Deleting the `computerd` journal volume has the same effect. Step 8 removes passwordless `sudo`.
- A `sudo` child and a `setsid` child both outlive a cancel or a timeout, because `computerd` kills the process group as `agent`.
- A bot can read its VM's link token through `sudo`, and it can then forge results for its own owner's runs. It cannot reach another owner's runs.
- One unreadable journal entry, such as a broken symlink, stops `computerd` at startup until someone removes it. `prune` also has no guard for a file that vanishes mid-scan.
- Meta files in the journal never expire, so the journal grows slowly. Pruning 200,000 of them took 158 ms.
- An error body cut at 300 characters can split an emoji. Convex then rejects the failure reason, so the run makes 5 model calls before it stops.
- Redaction matches only the whole, exact key. An upstream that echoes part of a key could put that part in a failure reason.
- `.run-failure` in `apps/web/src/styles.css` has no `overflow-wrap`, so a long unbroken error widens the page.
- The orchestrator's dev guard checks four forwarding headers and the host name. Binding to loopback is the real boundary.
- Vite's default CORS lets any page on a localhost port read a dev token from `/auth/token`. Setting `server.cors` to `false` closes this.
- The orchestrator sends no CSP, `X-Frame-Options`, or `nosniff` header.
- `scripts/bootstrap.ts` appends to an env file without checking for a trailing newline. The orchestrator then refuses to start, so this fails closed.
- `parsePrivateJwk` in `scripts/lib.ts` can echo part of a malformed key to the local terminal.
- The Docker tags `bots-computerd:dev` and `bots-netguard:dev` are shared, so `pnpm bootstrap` and `pnpm verify:agent` replace a developer's local images.
- The runner does not cap the model name in a response. Scenario P in `scripts/verify-agent.ts` uses this as its trigger, so update that scenario if you add a cap.
- A kill during the disk import of `infra/proxmox/create-control-vm.sh` leaves a locked stub VM. A rerun explains the fix instead of converging.
- `pnpm verify:tailnet` does not check that `systemd-resolved` on port 5355 and SSH on port 22 stay private, and both answer on the VM's LAN address today. User VMs cannot reach them, which `infra/proxmox/verify-network.sh` proves.
- A host reboot loaded `bots-guard.service` before the guests and the rules held afterward. No reboot has tested the failure cases, which are an empty `home_public` set stopping autostart and a boot with no internet using the cached address.
- A bot can reach the router's admin console after the home public address changes, until the next successful refresh. The refresh runs every minute but depends on `api.ipify.org`, so an outage of that site extends the gap. The owner accepted this risk and chose not to add a router rule. A rule would have to keep DNS open, because the Proxmox host uses the router for DNS.
- A bot has root, so it can stop or change its own `computerd` and fake the commit that a VM reports. That reaches only its owner's runs. The loop repairs a VM that stays disconnected, not one that stays connected with changed code.
- An update waits for the owner's runs to end, so a bot that never stops running never updates.
- The loop handles one computer at a time, so a slow install delays every other computer by up to 10 minutes.
- A repair reinstalls `computerd` every 2 minutes for as long as a VM stays disconnected, which downloads Node each time. A long link outage causes this on every VM.
- If an update breaks `computerd`, the loop does not roll it back, and it rolls out to every VM. A deploy of a fixed commit repairs them, because the update path needs only the guest agent. No test has deployed a commit that breaks `computerd`.
- A host crash during a clone leaves a locked VM outside the pool. The loop reports `failed` on every pass, because only `root` can clear the lock. Killing the orchestrator does not cause this, because the clone runs on the host.
- Removing a computer while its first clone is still running leaves a VM that no computer owns. The next computer in that slot would adopt that VM and its disk.
- `computers:declareVm` and `computers:removeVm` have no UI yet, and a removed test user stays in the `users` table. Step 6 needs the UI.
- The Proxmox token can destroy any VM in its pool, including the template, and it can run commands as root in user VMs. The orchestrator holds it, so a compromised orchestrator can do these things. It cannot touch VM 110 or the host.
- A disk that grows on a running VM reaches the guest's filesystem at the VM's next boot. A size change that also changes memory or cores restarts the VM, and a change to the disk alone does not.
- VM 110 has no firewall of its own, and SSH and LLMNR listen on its `10.78.0.2` address. Only `bots_guard` stops a user VM from reaching them. `verify-network.sh` fails if that table is missing, and guests do not autostart without it.
- The rules limit where a bot connects, not how much it sends. A bot can flood the link port, and it can connect to port 25 on any public address from the home IP address.
- Bots cannot be deleted, so `pnpm verify:tailnet` leaves `verify-tailnet-*` bots in the user's list.
- Step 1b did not test a live update on a phone, or a bot created by a second real account. `pnpm verify:agent` covers isolation between users on a Mac.
- `pnpm verify:agent` relies on Docker Desktop's `host.docker.internal`, so it does not run on Linux or in CI as written.
- CI is not a required check on `main`. That is a repository setting.
- Step 4 must test what the screen tests did not cover. The architecture document lists these.
