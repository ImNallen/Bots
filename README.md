# Bots

A self-hosted agent platform. See the [architecture](docs/architecture.md) and the [roadmap](docs/roadmap.md).

This repository is partway through roadmap step 3, and step 1b has run on Proxmox. The steps below run Convex, SearXNG, and `computerd` in Docker, and the orchestrator in dev mode and the web app on one Mac. A user chats with a bot, and the bot runs shell and file tools in the `computerd` container. To deploy over Tailscale, see [the control VM guide](infra/control-vm/README.md).

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

Use **Attach files** in chat, drop files onto the composer, or paste an image. A message accepts up to four PNG, JPEG, WebP, PDF, or UTF-8 text/code files. Images and PDFs can be up to 8 MiB each. Text/code files can be up to 256 KiB. Files can be sent without message text. Upload errors offer a retry, and each draft attachment can be removed before sending. Attachments supply context to the chat model and are not copied to the bot's computer.

Use the microphone button to dictate a message. The composer shows a live waveform and a timer. Press **Done** to finish recording and transcribe into the current draft. You can edit the text before pressing **Send**. **Cancel** discards voice input, and **Try again** retries a failed transcription without recording again. Recording stops after two minutes or when you leave the chat. Voice input needs microphone permission, HTTPS or localhost, a supported browser, and your Mistral key. Bots does not save the recording.

`pnpm bootstrap` generates the signing key, the master key, the computer token, and SearXNG's secret key, starts the containers, and deploys the Convex functions. It also builds and starts `computerd` behind its `netguard` sidecar, which limits what a bot can reach. It is safe to rerun, and it never replaces a key that still works.

Rerun `pnpm bootstrap` after Docker or the Mac restarts, or after `netguard` restarts. Until then `computerd` stays down or has no network, so a bot's tool calls end as `unavailable`.

To serve the built web app instead, use `pnpm build` and then `pnpm start`. It serves on http://127.0.0.1:8787. The orchestrator runs from source in both cases, so `pnpm build` only typechecks it.

The orchestrator reads these optional settings from `.env.local`:

| Variable | Default | Meaning |
|---|---|---|
| `LINK_HOST` | `127.0.0.1` | The address where `computerd` connects |
| `LINK_PORT` | `8788` | The port where `computerd` connects. `pnpm bootstrap` passes it to the container |
| `MISTRAL_BASE_URL` | `https://api.mistral.ai` | The Mistral API |
| `MISTRAL_MODEL` | `mistral-large-4` | The model every bot uses |
| `MISTRAL_TRANSCRIPTION_MODEL` | `voxtral-mini-transcribe-3-0` | The model used for voice dictation |
| `COMPUTER_WAIT_SECONDS` | `300` | How long a tool call waits for an absent computer before it records `unavailable` |
| `SEARXNG_URL` | `http://127.0.0.1:8789` | The SearXNG that `web_search` asks. `pnpm bootstrap` starts it on this port |

## Check it

| Command | What it proves |
|---|---|
| `pnpm typecheck` | Every package typechecks |
| `pnpm test` | Identity, config, run decisions, message mapping, stream parsing, encryption, the journal, the output cap, a bot's activity, the screen view's states, a bot's look, a bot's profile rules, a note's rules and what counts as a secret, when a tool runs, asks, or is rejected, a read-only run's limits and final call, a routine's words and its next time across clock changes, when a tick fires, waits, misses, or pauses a routine, which of its runs it keeps, what each model call reads and may call, what a model call keeps of its thread's earlier requests and of a run that stored no reply, that each request of a run starts with the request before it, the cache key a request sends and the cached count it reads back, which calls browse logged out, which marks a look lists on captures from a real desktop, how a desktop input is aimed, worded on its card, refused when its target moved, and sent, how a look's picture reaches the model and stays out of the journal, which addresses `web_fetch` may open and how a page reads as text, how a SearXNG answer reads as results and how a search fails, what a browser does when a logged-out window freezes or ends, how reports mix with a chat in a message list that a model accepts, which runs the timeline shows, the system prompt's sections, how it words the date and time in the owner's time zone, a conversation's display items, what the composer offers during a routine, which runs Activity lists and what each of its rows says, and the safety rules for a bot's markdown behave as specified |
| `pnpm verify:reset` | Checks reset ownership, idempotency, generation fencing, admission, stopped runs and approvals, preserved chat and notes, successful completion, bounded cleanup, and completion-time routine advancement against a local backend. Completion uses simulated connection evidence. It creates disposable test accounts and never contacts Proxmox |
| `pnpm verify:reset-ui` | Checks Settings confirmation, Cancel and Escape, pending Escape refusal, focus return, errors, durable retry progress, and disabled actions in desktop and phone Chromium, light and dark. Start the local app first. Screenshots go to `/tmp/bots-reset-ui` |
| `pnpm verify:auth` | Tokens, live queries, user isolation, the dev guard, the link listener's boundary, and file serving work against the real Convex backend and the real orchestrator |
| `pnpm verify:floating-computer` | Chromium checks the real noVNC client against a desktop-stream fixture and local backend: dragging, resizing, keyboard access, stored placement, chat access, stream continuity, takeover release, retry, phone controls and full-screen fallback |
| `pnpm verify:design` | Chromium checks docked details, tablet sizing with a wide sidebar, phone navigation, hidden description preservation, bot colours, drafts, themes, Settings, routine results, Computer's disconnected state, and bot creation and deletion against the local app |
| `pnpm verify:routines` | Chromium checks the Routines panel against the local app in light and dark, on a computer and a touch phone: titles, an older routine with no title, the details with steps, limits, and recent runs and no raw instruction, the context menu by right-click, Escape, and Shift+F10, the swipe to Delete and a vertical drag that opens nothing, Undo, and the delete that lands when the undo window ends |
| `pnpm verify:highlights` | Chromium checks mouse, touch, and keyboard dragging, zero to four saved highlights, centering, reordering, border resizing, width persistence, responsive grids, the compact rail, account isolation, and deletion against the local backend |
| `pnpm verify:attachments` | Builds the app and checks real uploads, previews, downloads, image/text/PDF model inputs, file-only sending, retries, removal, drag-and-drop, paste, mobile layout, ownership, limits, expiration, and storage cleanup through a separate local account and a fake model endpoint |
| `pnpm verify:voice` | Builds the app and checks browser recording, editable transcripts, explicit sending, attachment preservation, retry, cancel, microphone cleanup, permissions, navigation, duration limits, WAV conversion, request bounds, and ownership with synthetic audio and a fake transcription endpoint |
| `pnpm verify:agent` | Key handling, tools, crash recovery with no duplicate side effects, fencing, cancel, timeouts, link security, isolation, secret placement, the network rules, the limit on attempts with no progress, a bot's memory, with a kill on each side of its one mutation, and a read-only run, which rejects what it may not do, never asks, ends at its limits with a report, posts that report in the chat, and sends each browser call logged out, and a routine, which a bot creates, changes, and deletes when its owner asks, with a card only at Everything or after untrusted text, which the real cron fires once, which no bot can reach for another bot, whose delete the owner can undo for 8 seconds, and which leaves nothing behind when it goes, and Activity, which shows each fire once to its owner alone and loads at its read limits, and a run's screen, which keeps only its newest look and goes with the run, and desktop calls, which the real `computerd` takes and which need a look first, and a search, which goes to a fake SearXNG and never to `computerd`, and after which a save asks, work against the real Convex backend, a real orchestrator process, and a real `computerd` container, with a scripted fake Mistral |
| `pnpm verify:tailnet <address> <LAN address>` | Identity, a forged header, live queries through `tailscale serve`, and closed LAN ports work on a real deployment. Run it from a device on the tailnet |
| `pnpm verify:template <address> <VM name>` | A real chat, with a real model, runs a shell tool on the named user VM. Run it from a device on the tailnet, as [the control VM guide](infra/control-vm/README.md) describes |
| `node --env-file=.env.local scripts/verify-reconcile.ts` | The real orchestrator converges a test VM after a kill at each provisioning stage, the VM has its firewall filters, removal leaves nothing behind, and the Proxmox token cannot touch the control VM. It then resets one test VM once for each stage of a reset, with a kill at that stage. Each reset must come back as the next generation, on a new disk, with a new token, the old token revoked, and the same slot and filters. No other VM in the pool may change. Run it as root on the control VM, from `/opt/bots` |
| `pnpm verify:browser <address>` | Two bots use real websites at once, each on its own screen, with a real model. Run it from a device on the tailnet |
| `pnpm verify:desktop-tools <address>` | A real model looks at a real bot's desktop, clicks Chromium's own menu, and names its items, and at the default level a click shows a card with its words and the screen, and a denial clicks nothing. Run it from a device on the tailnet, after a deploy of the desktop tools |
| `pnpm verify:web [<container>] [<address>]` | Through the orchestrator's search module and the SearXNG that `pnpm bootstrap` started, three queries in a row each get at least 5 results, and at least 80% of them share a word with the query. Inside a real `computerd`, `web_fetch` reads a Wikipedia article in parts, refuses loopback, the link's address, and a public name for loopback before it connects, and checks a certificate against the name. With an address, a real model asked what a page says, and asked for two sources, uses the text tools and nothing on its screen. The container defaults to `bots-computer-computerd-1`, which `pnpm bootstrap` builds from this checkout. On the control VM, run `node scripts/verify-web.ts --search` from `/opt/bots` for the search checks alone. On a user VM, run `node scripts/verify-web.ts --inside` from `computerd`'s release root for the `web_fetch` checks alone |
| `pnpm verify:screen <address>` | The owner gets a real stream through `tailscale serve` and the link, and a page from another site, a client with no origin, and a bot of another owner get nothing. Run it from a device on the tailnet |
| `pnpm verify:takeover <address>` | During a take-over, a person's mouse and keys reach one bot's real desktop over RFB, including Ctrl+L and a dropdown, that bot waits while another keeps working, a password never reaches the model, and after the give-back the other bot has the login. Run it from a device on the tailnet |
| `infra/proxmox/verify-desktop.sh <VM>` | A bot's desktop starts, stays on loopback with its sandbox on, and recovers from a kill of each part, including its session bus, its helper reads Chromium, the panel, a file chooser, and a terminal through accessibility, and a look, a click, typing, a key, and a scroll act only on what a look showed, with Chromium's memory printed with accessibility on and off, its input stream exists only during a take-over, `computerd`'s own code runs two bots at once on it, a login typed in a take-over reaches bots that are running, stopped, and new, a read-only run's browser holds none of the owner's logins and moves none, and a deleted bot's files and desktop go. Run it on the Proxmox host, on a VM whose owner has no run and with no desktop running, because a push reaches every browser. It needs no link. Set `NO_REBOOT=1` on a VM that a person is using |
| `node scripts/verify-logged-out.ts <CDP port>` | A real Chromium keeps a read-only run logged out: no login reaches its requests, what it sets never reaches the jar and ends with its window, downloads are denied, a frozen page never lands on the bot's own page, and the browser survives each way a window ends. Run it as root on a machine with Chromium running, on a browser that nobody is using. `infra/proxmox/verify-desktop.sh` runs it |
| `infra/proxmox/verify-network.sh <VM> <VM>` | A user VM reaches only the internet and the link port, and cannot claim another VM's addresses. Run it on the Proxmox host, as [the control VM guide](infra/control-vm/README.md) describes |

`verify:auth` and `verify:agent` use the Convex functions from your last `pnpm bootstrap`, so run it first after you change anything in `packages/convex`. Otherwise they test the old functions, and they can still pass.

CI runs `pnpm typecheck`, `pnpm test`, and `pnpm build` on every pull request and on pushes to `main`. Run the verify commands yourself before you merge a change to runs, the link, `computerd`, or auth.

`pnpm verify:design` needs `pnpm bootstrap`, `pnpm dev`, and Chromium from `pnpm exec playwright install chromium`. It uses `http://localhost:5173`, creates and removes its own test bots, and saves screenshots under `/tmp/bots-design-review`. Set `DESIGN_SCREENSHOTS` to change the output directory.

`pnpm verify:routines` needs the same running app. It reads the Convex address from `packages/convex/.env.local`, creates and removes its own bot, seeds routines through the internal check functions, and saves screenshots under `/tmp/bots-routines-review` unless `DESIGN_SCREENSHOTS` selects another directory. Its swipe is Chromium's touch emulation, not a physical phone. It takes about a minute, because it waits out an undo window in each theme.

`pnpm verify:floating-computer` uses the same running local app and Convex backend as the design check, and accepts an optional app URL. It creates and deletes its own bot. The desktop stream is a local RFB fixture; noVNC and the backend takeover mutations are real. Screenshots go to `/tmp/bots-floating-computer-review` unless `DESIGN_SCREENSHOTS` selects another directory. It does not verify a real VM or desktop.

`pnpm verify:highlights` uses the same local setup. It signs in as a separate test account and removes its test bots when it finishes. It does not change your account's highlights.

`pnpm verify:attachments` needs the local Convex backend and generated environment files. It starts its own orchestrator, uses a separate test account and a fake Mistral endpoint, and removes its test bots and files. It does not need `computerd` or call the real Mistral API. Screenshots go to `/tmp/bots-attachment-review` unless `DESIGN_SCREENSHOTS` selects another directory.

`pnpm verify:voice` uses the same local backend and a separate test account. Chromium records from a synthetic microphone, including quiet audio and silence. To run the same checks in Firefox with autoplay restrictions, install it with `pnpm exec playwright install firefox`, then run `VOICE_BROWSER=firefox pnpm verify:voice`. Permission failures are injected at the browser API, and the upstream transcript is a fixture. The checks do not use your microphone or call Mistral. Screenshots go to `/tmp/bots-voice-review` unless `DESIGN_SCREENSHOTS` selects another directory.

`pnpm verify:auth` and `pnpm verify:agent` need the containers from `pnpm bootstrap`. Each starts its own orchestrator on free ports under its own test login, so it can run alongside `pnpm dev`. A dev orchestrator claims only its own login's runs, so neither touches the other's work. `pnpm verify:agent` also starts its own `computerd` containers under the Compose projects `bots-verify-agent` and `bots-verify-agent-direct`, and it removes them and their volumes when it ends. It takes about fifteen minutes. To run some scenarios, set `VERIFY_SCENARIOS`, as in `VERIFY_SCENARIOS=A,P pnpm verify:agent`. Each run leaves a few rows under test identities in Convex. They never appear for `dev@localhost`. A Convex cron fires due routines for every owner, so the `schedule` scenario deletes every routine it makes, also when a check fails. It waits for that cron, which takes up to 3 minutes.

## Stop it

```sh
docker compose --env-file .env.local --file apps/computerd/compose.yaml down
docker compose --env-file .env.local --file infra/control-vm/compose.yaml down
```

Add `--volumes` to delete the workspace and journal, or the Convex data, as well.

`scripts/verify-reconcile.ts` is the check of reset on a real Proxmox host. It resets a test VM that it creates and removes, and never a user's VM. Its reset part has not run yet, so reset still needs a passing run before rollout. Run `node --env-file=.env.local scripts/verify-reconcile.ts` as root on the control VM, from `/opt/bots`. A host crash that leaves a locked clone outside the pool requires operator repair, as it did before this feature. See [the recovery limit](docs/architecture.md#proxmox-permissions-and-host-crash-recovery) and [issue 54](https://github.com/ImNallen/Bots/issues/54). Local fake API checks do not verify real-host reset.
