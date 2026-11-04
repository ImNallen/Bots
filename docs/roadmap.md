# Roadmap

Each step ends in a check. Start the next step only after that check passes. The reasons behind these choices are in [the architecture document](architecture.md).

| Step | Status | Build | Done when |
|---|---|---|---|
| 1a | Done | Repository, Convex in Docker, dev mode, and the web shell, on a Mac | The web app shows a live Convex query, using a JWT from `/auth/token` |
| 1b | Done | Control VM, `tailscale serve`, and Tailscale mode, on Proxmox | A second Tailscale account and a phone browser see the same live query, each as its own user |
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
- Run `tailscale status` on the control VM to find its `https://bots-control.<tailnet>.ts.net` address.
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
- Write a network check like scenario O in `scripts/verify-agent.ts`, and run it from inside a real VM.

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
- A pending call older than 7 days could run again after the journal prunes it.
- The runner does not cap the model name in a response. Scenario P in `scripts/verify-agent.ts` uses this as its trigger, so update that scenario if you add a cap.
- Bots cannot be deleted, so `pnpm verify:tailnet` leaves `verify-tailnet-*` bots in the user's list.
- Step 1b did not test a live update on a phone, or a bot created by a second real account. `pnpm verify:agent` covers isolation between users on a Mac.
- `pnpm verify:agent` relies on Docker Desktop's `host.docker.internal`, so it does not run on Linux or in CI as written.
- CI is not a required check on `main`. That is a repository setting.
- Step 4 must test what the screen tests did not cover. The architecture document lists these.
