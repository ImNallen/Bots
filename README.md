# Bots

A self-hosted agent platform. See the [architecture](docs/architecture.md) and the [roadmap](docs/roadmap.md).

This repository is partway through roadmap step 3, and step 1b has run on Proxmox. The steps below run Convex and `computerd` in Docker, and the orchestrator in dev mode and the web app on one Mac. A user chats with a bot, and the bot runs shell and file tools in the `computerd` container. To deploy over Tailscale, see [the control VM guide](infra/control-vm/README.md).

## Requirements

- Node 26 and pnpm 11
- Docker with Compose

## Run it

```sh
pnpm install
pnpm bootstrap
pnpm dev
```

Open http://localhost:5173, open Settings from the account row at the bottom of the sidebar, add a Mistral key, and create a bot. The Convex dashboard is at http://127.0.0.1:6791. To sign in to it, use the admin key in `packages/convex/.env.local`.

`pnpm bootstrap` generates the signing key, the master key, and the computer token, starts the containers, and deploys the Convex functions. It also builds and starts `computerd` behind its `netguard` sidecar, which limits what a bot can reach. It is safe to rerun, and it never replaces a key that still works.

Rerun `pnpm bootstrap` after Docker or the Mac restarts, or after `netguard` restarts. Until then `computerd` stays down or has no network, so a bot's tool calls end as `unavailable`.

To serve the built web app instead, use `pnpm build` and then `pnpm start`. It serves on http://127.0.0.1:8787. The orchestrator runs from source in both cases, so `pnpm build` only typechecks it.

The orchestrator reads these optional settings from `.env.local`:

| Variable | Default | Meaning |
|---|---|---|
| `LINK_HOST` | `127.0.0.1` | The address where `computerd` connects |
| `LINK_PORT` | `8788` | The port where `computerd` connects. `pnpm bootstrap` passes it to the container |
| `MISTRAL_BASE_URL` | `https://api.mistral.ai` | The Mistral API |
| `MISTRAL_MODEL` | `mistral-large-4` | The model every bot uses |
| `COMPUTER_WAIT_SECONDS` | `300` | How long a tool call waits for an absent computer before it records `unavailable` |

## Check it

| Command | What it proves |
|---|---|
| `pnpm typecheck` | Every package typechecks |
| `pnpm test` | Identity, config, run decisions, message mapping, stream parsing, encryption, the journal, the output cap, a bot's activity, the screen view's states, a bot's look, a bot's profile rules, a note's rules and what counts as a secret, when a tool runs, asks, or is rejected, a read-only run's limits and final call, a routine's words and its next time across clock changes, when a tick fires, waits, misses, or pauses a routine, which of its runs it keeps, what each model call reads and may call, which calls browse logged out, what a browser does when a logged-out window freezes or ends, how reports mix with a chat in a message list that a model accepts, which runs the timeline shows, the system prompt's sections, a conversation's display items, what the composer offers during a routine, which runs Activity lists and what each of its rows says, and the safety rules for a bot's markdown behave as specified |
| `pnpm verify:auth` | Tokens, live queries, user isolation, the dev guard, the link listener's boundary, and file serving work against the real Convex backend and the real orchestrator |
| `pnpm verify:agent` | Key handling, tools, crash recovery with no duplicate side effects, fencing, cancel, timeouts, link security, isolation, secret placement, the network rules, the limit on attempts with no progress, a bot's memory, with a kill on each side of its one mutation, and a read-only run, which rejects what it may not do, never asks, ends at its limits with a report, posts that report in the chat, and sends each browser call logged out, and a routine, which only an approved card creates, which the real cron fires once, and which leaves nothing behind when it goes, and Activity, which shows each fire once to its owner alone and loads at its read limits, work against the real Convex backend, a real orchestrator process, and a real `computerd` container, with a scripted fake Mistral |
| `pnpm verify:tailnet <address> <LAN address>` | Identity, a forged header, live queries through `tailscale serve`, and closed LAN ports work on a real deployment. Run it from a device on the tailnet |
| `pnpm verify:template <address> <VM name>` | A real chat, with a real model, runs a shell tool on the named user VM. Run it from a device on the tailnet, as [the control VM guide](infra/control-vm/README.md) describes |
| `node --env-file=.env.local scripts/verify-reconcile.ts` | The real orchestrator converges a test VM after a kill at each provisioning stage, the VM has its firewall filters, removal leaves nothing behind, and the Proxmox token cannot touch the control VM. Run it as root on the control VM, from `/opt/bots` |
| `pnpm verify:browser <address>` | Two bots use real websites at once, each on its own screen, with a real model. Run it from a device on the tailnet |
| `pnpm verify:screen <address>` | The owner gets a real stream through `tailscale serve` and the link, and a page from another site, a client with no origin, and a bot of another owner get nothing. Run it from a device on the tailnet |
| `pnpm verify:takeover <address>` | During a take-over, a person's mouse and keys reach one bot's real desktop over RFB, including Ctrl+L and a dropdown, that bot waits while another keeps working, a password never reaches the model, and after the give-back the other bot has the login. Run it from a device on the tailnet |
| `infra/proxmox/verify-desktop.sh <VM>` | A bot's desktop starts, stays on loopback with its sandbox on, and recovers from a kill of each part, its input stream exists only during a take-over, `computerd`'s own code runs two bots at once on it, a login typed in a take-over reaches bots that are running, stopped, and new, a read-only run's browser holds none of the owner's logins and moves none, and a deleted bot's files and desktop go. Run it on the Proxmox host, on a VM whose owner has no run and with no desktop running, because a push reaches every browser. It needs no link. Set `NO_REBOOT=1` on a VM that a person is using |
| `node scripts/verify-logged-out.ts <CDP port>` | A real Chromium keeps a read-only run logged out: no login reaches its requests, what it sets never reaches the jar and ends with its window, downloads are denied, a frozen page never lands on the bot's own page, and the browser survives each way a window ends. Run it as root on a machine with Chromium running, on a browser that nobody is using. `infra/proxmox/verify-desktop.sh` runs it |
| `infra/proxmox/verify-network.sh <VM> <VM>` | A user VM reaches only the internet and the link port, and cannot claim another VM's addresses. Run it on the Proxmox host, as [the control VM guide](infra/control-vm/README.md) describes |

`verify:auth` and `verify:agent` use the Convex functions from your last `pnpm bootstrap`, so run it first after you change anything in `packages/convex`. Otherwise they test the old functions, and they can still pass.

CI runs `pnpm typecheck`, `pnpm test`, and `pnpm build` on every pull request and on pushes to `main`. Run the verify commands yourself before you merge a change to runs, the link, `computerd`, or auth.

`pnpm verify:auth` and `pnpm verify:agent` need the containers from `pnpm bootstrap`. Each starts its own orchestrator on free ports under its own test login, so it can run alongside `pnpm dev`. A dev orchestrator claims only its own login's runs, so neither touches the other's work. `pnpm verify:agent` also starts its own `computerd` containers under the Compose projects `bots-verify-agent` and `bots-verify-agent-direct`, and it removes them and their volumes when it ends. It takes about fifteen minutes. To run some scenarios, set `VERIFY_SCENARIOS`, as in `VERIFY_SCENARIOS=A,P pnpm verify:agent`. Each run leaves a few rows under test identities in Convex. They never appear for `dev@localhost`. A Convex cron fires due routines for every owner, so the `schedule` scenario deletes every routine it makes, also when a check fails. It waits for that cron, which takes up to 3 minutes.

## Stop it

```sh
docker compose --env-file .env.local --file apps/computerd/compose.yaml down
docker compose --file infra/control-vm/compose.yaml down
```

Add `--volumes` to delete the workspace and journal, or the Convex data, as well.
