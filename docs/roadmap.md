# Roadmap

Each step ends in a check. Start the next step only after that check passes. The reasons behind these choices are in [the architecture document](architecture.md).

| Step | Status | Build | Done when |
|---|---|---|---|
| 1a | Done | Repository, Convex in Docker, dev mode, and the web shell, on a Mac | The web app shows a live Convex query, using a JWT from `/auth/token` |
| 1b | Done, with gaps listed below | Control VM, `tailscale serve`, and Tailscale mode, on Proxmox | A second Tailscale account and a phone browser see the same live query, each as its own user |
| 2 | Done | Agent loop and shell and file tools, with `computerd` in Docker | A user chats with a bot in the web UI, and killing the orchestrator mid-tool resumes the run with no duplicate side effects |
| 3 | **Next** | Proxmox template, reconcile loop, and network rules | Provisioning converges after being killed midway, and a script proves that a VM reaches only the internet and the orchestrator |
| 4 | | Screens, live view, take-over, and approvals | Two bots work at once while a user watches one and takes over the other from a phone |
| 5 | | Schedules, the memory UI, and the Activity view | The orchestrator rejects a write attempt from a scheduled run |
| 6 | | Friend invites | A friend goes from invite to working bot without help |
| 7 | | Tauri and Expo apps, and push | A user approves an action from a push notification |
| 8 | | OAuth connectors, the independent reviewer, and the Vault | Bots use saved logins without seeing the passwords, and bots no longer have passwordless `sudo` |

Friends cannot join before step 3 passes, because bots are not isolated from the LAN until then.

Backups are deferred. Add off-server copies of Convex exports and the master key before anyone depends on this system.

## Where things run

- The Proxmox host is `192.168.1.32`. Log in as `root` over SSH.
- The control VM is VM 110, `bots-control`, at `192.168.1.161`. Log in as `bots` over SSH, which has passwordless `sudo`. The app is in `/opt/bots`.
- Run `sudo tailscale serve status` on the control VM to find its `https://bots-control.<tailnet>.ts.net` address.
- The service runs as `bots-orchestrator`, which has no `sudo`. Keep it separate from the `bots` login: a process can take over another process of its own user, and `bots` has `sudo`.
- The control VM deploys a branch until someone deploys another. After the first merge to `main`, run [the deploy script](../infra/control-vm/README.md) with `main`.
- Your Mac has its own Convex data and its own Mistral key, separate from the control VM.

## Decisions for step 3

The user chose these:

- Each user gets one VM, and all of that user's bots share it.
- The owner's VM has 32 GB of RAM. Friends start at 8 GB and get more only if a measurement shows they need it.
- VMs use fixed memory, with no ballooning and no KSM.
- The server has 16 cores with 32 threads, a single 2 TB disk, and 91 GiB of usable RAM. Storage is `local-lvm`, which is LVM-thin.

These are proposals, so change them if you find a better answer:

- Give the owner's VM 12 vCPUs and 500 GB. Give each friend 6 vCPUs and 200 GB.
- Put user VMs on a new isolated network, off the tailnet. Allow the internet and the orchestrator's link port. Block the LAN, the Proxmox UI, other users' VMs, and the tailnet. Add a second network interface to the control VM for this network.
- Test the Proxmox VNet firewall first. It needs the nftables firewall, which Proxmox marks as a tech preview. Per-VM firewall rules are the fallback.
- Give the orchestrator a Proxmox API token that can only clone, configure, power, and snapshot VMs in one resource pool.
- Model each computer with desired and observed state, and converge them in a reconcile loop. Extend the `computers` table with those fields.
- Call `computers.register` from the provisioner, with a separate link token for each VM. Bind the link listener to the private network address through `LINK_HOST`. The public listener stays on `127.0.0.1`.
- Run `computerd` under systemd in the VM template, with the same `computerd` and `agent` users and sudoers rule as its Dockerfile. `netguard` is for Docker on a Mac and does not apply to VMs.
- Write a network check like scenario O in `scripts/verify-agent.ts`, and run it from inside a real VM. Also test `192.0.0.0/24`, `198.18.0.0/15`, and `240.0.0.0/4`, which `netguard` does not block.
- Keep the public listener away from VMs. In Tailscale mode, one header on that socket creates a token for any identity, so a VM that reaches it could act as any user. VMs reach only the link listener.

Step 3 also has to decide how an update reaches `computerd` on existing VMs. Nothing does that yet.

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
- `pnpm verify:tailnet` does not check that `systemd-resolved` on port 5355 and SSH on port 22 stay private, and both answer on the VM's LAN address today.
- Bots cannot be deleted, so `pnpm verify:tailnet` leaves `verify-tailnet-*` bots in the user's list.
- Step 1b did not test a live update on a phone, or a bot created by a second real account. `pnpm verify:agent` covers isolation between users on a Mac.
- `pnpm verify:agent` relies on Docker Desktop's `host.docker.internal`, so it does not run on Linux or in CI as written.
- CI is not a required check on `main`. That is a repository setting.
- Step 4 must test what the screen tests did not cover. The architecture document lists these.
