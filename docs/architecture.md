# Architecture

Bots is a self-hosted agent platform for one person or a small group. Each user brings a Mistral API key and gets one VM, which all of that user's bots share. Bots keep working when every client is off, because they run on a Proxmox server.

```text
Web, Tauri, and Expo clients
	|  Tailscale: HTTPS and WebSocket
	v
Control VM, the only machine on the tailnet
	tailscale serve    TLS and user identity
	Convex             users, threads, runs, events, approvals
	Orchestrator       tokens, secrets, policy, agent loop, Proxmox control, web files
	^
	|  computerd connects outbound over an isolated network
User VMs, one per user
	computerd          shell, files, browser, screens
	/workspace/<botId>
```

## Why the agent loop runs on the orchestrator

A VM runs tools. It does not run the agent loop, and it never holds an API key, an approval rule, or the conversation history.

A bot can then have broad control of its own VM, because the most it can damage is that VM. Restoring a VM snapshot does not rewind the conversation. A prompt-injected bot cannot edit its own loop or approve its own actions.

The cost is that one process serves every user, so a crash affects everyone until the process restarts. Runs checkpoint to Convex after each step, so a restart resumes them. Long waits on Mistral and on tools make the loop light on memory, although we have not measured that yet.

Convex actions are not an option for the loop. They stop after 30 minutes, or 10 minutes on the Node runtime, and every user would share the one self-hosted backend.

## How a run recovers from a crash

The ordered `runEvents` rows are the truth about a run. A pure function reads them and returns the next action, so the runner keeps no state that a restart could lose. A tool call is pending when an assistant turn lists it and no tool result has its id.

Three mechanisms make this safe:

- A lease gives one runner a run. A runner renews its 15 second lease every 5 seconds, and it stops work on that run as soon as it loses the lease. A restarted runner claims the run after the lease expires.
- Fencing rejects a stale runner. Every runner write carries the lease token, and each append also carries the expected sequence number. Convex rejects a write that fails either check.
- A journal in `computerd` makes tool execution at most once. `computerd` writes a meta file with fsync before it starts a tool, and it writes the result to a temp file and renames it. The journal survives restarts of both processes. Results expire after 7 days, but meta files stay, so a call does not run twice however long the orchestrator was away. This holds only while the journal exists. A bot with `sudo` can delete the journal, which is one reason bots lose passwordless `sudo` at step 8. A call whose result expired answers `interrupted`.

The runner persists an assistant turn before it sends any of the turn's tool calls. After a crash it sends each pending call again with the same call id, and `computerd` answers from what it finds:

| Journal state | Answer |
|---|---|
| A result exists | The stored result, with no execution |
| The call is running in this process | The running execution's result |
| Only meta exists | `interrupted`, recorded and never rerun, because `computerd` died during the call or the result expired |
| Nothing exists | A new execution |

A tool keeps running when the link or the orchestrator dies. A model call has no side effects, so a crash during streaming only repeats the call.

An `interrupted` or `unavailable` outcome tells the model that a side effect may have partly happened. The system never reruns such a call, and the model decides what to do next.

Any unexpected error in the runner ends that attempt and leaves the lease to expire. Recovery from a transient failure therefore takes the same path as recovery from a crash, at the cost of waiting for the lease.

`runs.claim` ends a run after 5 attempts in a row that stored no event, because each attempt can pay for a model call on the user's key with nobody watching. The same mutation records an `unavailable` result for any tool call the run never answered. Every later model request replays the thread's history, and a call with no result would make that history malformed.

## Why identity comes from Tailscale

Tailscale already knows who each user is, so friends see no login form. The flow has three steps:

1. `tailscale serve` adds the `Tailscale-User-Login` header to each request. It also removes that header if a client sends it.
2. The orchestrator reads the header at `GET /auth/token` and returns a short-lived ES256 JWT.
3. Convex trusts JWTs from that issuer, and it loads the public key from an inline data URI.

The orchestrator's public listener binds only to `127.0.0.1`, so nothing can reach it around `tailscale serve` and forge the header. `computerd` reaches a second listener that serves only the link WebSocket and never `/auth` or web files.

We can add Better Auth later without a large rewrite. Four rules keep that change small:

- Tables reference a `users` row and never a Tailscale login. The provider's ID sits in `users.authSubject`.
- Convex trusts only the orchestrator's issuer, so a new login method changes one endpoint.
- Clients get tokens through one `getToken()` function.
- `users.email` holds the Tailscale login, which is how existing users would map to new accounts. A login is usually an email address, but not always the user's real one. GitHub logins look like `user@github`, and a login through Apple's private relay ends in `@privaterelay.appleid.com`. Those users would need a manual match.

### Local development uses dev mode

`AUTH_MODE=dev` returns a token for one fixed login without Tailscale. A dev-mode server would be an open door if it were ever exposed, because bots have a shell. The orchestrator rejects a dev-mode request if it has a forwarding header or a host name other than loopback. That check also covers a dev-mode server placed behind `tailscale serve` by mistake.

A dev-mode orchestrator registers its own login's computer at startup, and it claims only that login's runs. Test orchestrators therefore share one Convex backend with a developer's own without touching each other's runs.

## Why only the control VM joins the tailnet

Friends receive a share of the control VM. Tailscale's sharing gives them that one machine, and that machine cannot start connections to them. User VMs stay off the tailnet, so a compromised bot has no route to anyone's devices.

User VMs sit on an isolated network. They can reach the internet and the orchestrator. They cannot reach the home LAN, the Proxmox UI, or other users' VMs. A script proves this in step 3 of the [roadmap](roadmap.md), and no friend gets access before that script passes.

## What a bot can reach on a Mac

This is a development safeguard for Docker on a Mac. Step 3 still needs its own network rules on Proxmox, and this sidecar does not replace them.

Docker Desktop forwards `host.docker.internal` to services bound to the Mac's loopback address. Without a guard, a command in the `computerd` container reached Convex and got the dev login's token by sending `Host: localhost` to the public listener.

`computerd` therefore runs in the network namespace of a `netguard` sidecar, defined in `apps/computerd/netguard`. `netguard` has `NET_ADMIN`, applies the outbound rules, and stays alive to hold the namespace. Compose starts `computerd` only after the health check of `netguard` finds the rules. `computerd` has neither `NET_ADMIN` nor `NET_RAW`, so a bot with root through `sudo` cannot change the rules or send packets around them.

The IPv4 and IPv6 rules allow loopback, replies, TCP to the host on the link port only, and the public internet. They reject private, link-local, carrier-grade NAT, multicast, and v4-mapped addresses, so a blocked connection fails at once. IPv6 also allows neighbor discovery, because no IPv6 packet leaves without it.

The namespace belongs to `netguard`, so its lifetime decides what happens to `computerd`:

| Event | Result |
|---|---|
| `netguard` restarts | Docker gives `netguard` a new namespace. A running `computerd` stays in the old one, which has only loopback, until `computerd` restarts. `pnpm bootstrap` restarts it |
| `netguard` stops, then `computerd` restarts | Docker refuses to start `computerd` |
| `computerd` restarts | `computerd` joins the current namespace of `netguard`, with its rules |
| Docker or the Mac restarts | `netguard` stays stopped, because its restart policy is `no`. `computerd` then cannot start until you rerun `pnpm bootstrap` |

The restart policy is `no` because a new namespace has no rules for its first 20 ms or so, and Compose waits for health only when Compose starts the containers. A restart policy on `netguard` would also recover nothing, since `computerd` would stay in the old namespace.

One gap remains. If someone restarts `netguard` by hand and `computerd` crashes in that same 20 ms, `computerd` can join before the rules finish. The rules then apply to it as well, and no tool can run that early, because `computerd` must first start Node and connect the link.

A bot can still reach anything on the public internet, and it can read and change its own files. The link port stays open, and `sudo` lets a bot read the link token, so a bot can open its own connection on that port.

## What a bot can reach on Proxmox

A bot has root in its VM, so no rule inside the VM counts. Every rule runs on the Proxmox host, in three layers:

- Two networks keep machines apart. User VMs share `botsvms`, and port isolation stops their frames from reaching each other. The control VM sits alone on `botsctl`. A VM therefore shares no layer 2 network with anything except the host, and every packet it sends to another machine goes through the host's routing.
- A host nftables table, `bots_guard`, decides what the host routes. It allows the internet and TCP to the link port on `10.78.0.2`, and it rejects everything else, including IPv6. The table depends on no per-VM flag, so a VM created with its firewall off still gets these rules.
- Per-VM firewall filters stop a VM from using another address. The MAC filter and `ipfilter-net0` drop any frame or ARP claim that does not match the VM's own addresses. This layer matters because the link is plain `ws://`. If a VM could claim another VM's address, the host would send that VM's link traffic to the wrong machine. These filters do depend on a per-VM flag, so the provisioner must set `firewall=1`.

We did not use the VNet firewall, which the first plan proposed. It needs the tech-preview nftables engine across the whole host, and its documentation says every running VM must then restart. It filters only forwarded traffic and has no per-VM view of addresses, so it could have replaced only the second layer. `bots_guard` does that job with no change of engine.

Three details are easy to break:

- A packet from a VM to any address of the host arrives at the host's input hook, not its forward hook. That includes the host's LAN address, so `bots_guard` needs a rule in both places.
- The home network's public address looks like any other public address, but from a VM it reaches the router's own services through hairpin NAT. A test reached the router's admin console this way. A timer on the host keeps that address in `bots_guard`, so if the address changes, a VM can reach the router until the next successful refresh.
- `bots-guard.service` must never be required by `pve-guests.service`. Restarting a required unit restarts the unit that requires it, and stopping `pve-guests` shuts down every guest. This rebooted the control VM twice during step 3. A precheck on `pve-guests` blocks autostart when the table is missing, without that link.

`infra/proxmox/verify-network.sh` proves all of this from inside a real VM. A spoofed or one-way packet gets no reply that a probe could observe, so the script also runs packet captures on the host, and each capture must stay empty.

## How `computerd` updates on a VM

Bots and users install their own software on their VMs, so an update must not touch that software, and that software must not break `computerd`. Replacing the VM would lose both, so the reconcile loop updates `computerd` in place through the guest agent. A broken `computerd` cannot update itself, and the guest agent does not depend on it.

`infra/proxmox/install-computerd.sh` builds, updates, and repairs with the same steps:

- Each release has its own directory under `/opt/bots-computerd` and its own Node, so a bot that changes the system's Node does not affect `computerd`.
- Everything new gets a new directory, and one symlink selects a release, so a kill or a failed download leaves the selected release whole, even during a repair. A second run waits on a lock.
- The script changes nothing outside that directory, except the sudoers file, its unit files, and any package that `computerd` or a desktop needs and a bot removed. It installs `apps/computerd/desktop` as the desktop units. No step stops a running desktop, so a repair does not cost a bot its page, and a desktop takes new unit text at its next start.

The deploy script records the last commit that changed `computerd`, and VMs follow that commit. So the orchestrator and `computerd` stay compatible, and a deploy that leaves `computerd` alone restarts nothing on a VM. An update restarts `computerd`, which reports a running tool as interrupted, so an update has two parts. The build is slow and restarts nothing. Then the loop sets a fence in Convex, and `computers.fenceForUpdate` succeeds only if the owner has no queued or running run. While the fence holds, `runs.claim` refuses that owner's runs, and only a claimed run can call a tool. Convex runs both mutations atomically, so a run and a restart cannot overlap. A new message waits a few seconds. Memory could not do this, because a deploy restarts the orchestrator. The fence expires after a minute, so a crash cannot strand a run.

A user has no SSH, and a bot cannot help once `computerd` is down. So if a VM stays disconnected for 2 minutes, the loop reinstalls `computerd`.

## How each bot's desktop runs

Each active bot on a VM has a real Linux desktop: its own X display, Xfce, its own Chromium, and a view-only stream. `computerd` starts a desktop when a bot or a viewer first needs it, and stops it after an hour with no use.

The first design put every bot in one wide display with one shared browser, because Chromium locks a profile to one process, and that process stays on one display. A copy of a profile for each bot removes that limit. A test on a real VM then showed that a browser per bot works, so `computerd` no longer moves popups between regions, keeps a page list on disk, or streams a cropped part of a screen. [The roadmap](roadmap.md) has that test's results.

### systemd owns every process

A desktop is six files in `apps/computerd/desktop`, and a slot number from 1 to 8 is the unit's instance. `computerd` starts one name, `computerd-desktop@N.target`, and stops one name, `computerd-xvfb@N.service`. It also restarts `computerd-input@N.service` for a take-over. Everything binds to the display, so a stop returns only after Chromium has exited and its profile and ports are free. A test with a browser that ignored SIGTERM saw that stop take 10 seconds, which is `TimeoutStopSec`.

A desktop's processes sit in their own cgroups, outside `computerd.service`, so an update that restarts `computerd` does not touch them. `computerd` needs root for three exact commands, which the sudoers file names, and `desktop-files.test.ts` fails the build if those drift from the code.

`computerd` runs `systemctl start` on every browser tool call. Starting is safe on a running desktop, and it brings back a part that is down, so `computerd` has no other health check. It takes about 10 ms on a real VM. A person's input runs no `sudo`, because each event goes straight to `x11vnc`.

| What dies | What systemd does | What a bot and a viewer see |
|---|---|---|
| `computerd` | Leaves the desktops alone, and restarts `computerd` after 2 seconds | The same screen. A viewer's relay ended, so "Try again" reconnects to it. An input stream ended with its relay, so the take-over ended too, and what the owner typed still moves to the other bots |
| Chromium | Kills the rest of its cgroup, and restarts it after 2 seconds | A running step fails. The next step gets the stale ref error, and the snapshot says `about:blank`. A viewer stays connected |
| `x11vnc` | Restarts it after 2 seconds | The viewer's stream ends, and "Try again" works. The bot notices nothing |
| The input stream's `x11vnc` | Restarts nothing | The take-over ends and the viewer goes back to watching. The next take-over starts a new one |
| Xfce | Restarts it after 2 seconds | The panel blinks. CDP is untouched |
| Xvfb | Stops the whole desktop, and restarts nothing | A running step fails, and the page is gone. The next use starts the whole desktop on the same profile |
| The VM reboots | Starts no desktop, because the units have no `[Install]` | The next use starts a desktop on the bot's profile, on a blank page |

`infra/proxmox/verify-desktop.sh` proves each row on a real VM, and it needs no link.

### Who holds a slot

Each desktop's ports derive from its slot: `9300 + slot` for CDP, `5900 + slot` for the watch stream, and `6900 + slot` for the input stream. Two records say the rest. systemd says which slots are live. `/run/computerd/desktop-N.env` says which bot holds a slot, and units read it at each start. It lives in `/run`, so a reboot clears it along with the processes it describes.

`computerd` writes that file only while the slot is dead: stop, write, start. Each step is safe to repeat and safe to die after, so a crash at any point leaves one of three states, and a new `computerd` reads them all the same way. A live slot with a holder is that bot's. A live slot with no holder, or with a holder that another slot already claimed, gets stopped. A dead slot is free. A test kills `computerd` before and after every call to systemd, and no bot ever gets another bot's browser.

### When a desktop stops

A hold means a desktop is in use. Every tool call holds its bot's desktop, including a shell command, so a long build cannot lose the page the bot left open. A viewer's stream holds its desktop for as long as it runs, so a screen never stops under a person. A hold blocks both ways to stop a desktop:

- After an hour with no hold, a timer stops the desktop to save memory. A desktop takes about 250 MB of anonymous memory when idle, and about 330 MB with a Wikipedia page open.
- When a ninth bot needs a slot, the bot that has gone longest without a hold gives up its slot. If all 8 are held, the ninth bot gets an error.

A bot that comes back gets any free slot, the same profile, and a blank page. A click from before then gets the stale ref error, so it can never land on the wrong page.

### Which page a bot acts on

Each browser belongs to one bot, so every page in it is that bot's. `computerd` keeps one CDP socket per bot and asks Chromium for its targets on every look. The newest page is the current one, so a popup is current until it closes. This needs no events, no window moves, and no state file. After a `computerd` restart, the list rebuilds with pages that have an opener last, so a popup stays current.

### Where a profile comes from

A bot's profile is `/home/browser/profiles/<botId>`, and it starts as a copy of `/home/browser/profile`, the base. Nothing opens or writes the base, so nothing can damage a login in it. VM 201's logins became the base without moving. A real cookie written by the old shared browser reads back from a copied profile, with `--password-store=basic`. The copy goes to `<botId>.tmp` and is renamed when whole, so a kill midway leaves nothing that a later start could use by mistake. The update stops the old browser before anything can copy the base.

A new bot is that copy plus a replay of the logins that have moved since. So the base never needs a write, which would take a throwaway Chromium for each change and make a second record of the same logins.

### Deleting a bot

The bot page deletes a bot, and it refuses during a run or a take-over, because either would lose its desktop midway.

| Where | What goes | When |
|---|---|---|
| Convex | The bot's row | At once, in the mutation, so nothing new can start on it |
| Convex | Its thread, runs, events, streams, and approvals | In batches, because one thread can hold more than a mutation may read. The thread goes last |
| The VM | Its desktop, profile, workspace, and any take-over baseline | Within about 15 seconds, by the reconcile loop |
| The VM | Its tool results in the `computerd` journal | At the journal's own limit of 7 days |

`bots.remove` adds a `removedBots` row in the same mutation, and the loop deletes that row only after `infra/proxmox/forget-bots.sh` has succeeded. So a VM that is off, or a kill at any point, repeats the removal, which is safe. The script runs as root through the guest agent, as an update does. So it needs no new sudo rule or link message, and it works on a VM whose `computerd` is older than the orchestrator. `computerd` can keep an idle claim on the slot that the script stopped, and its sweep ends that claim within an hour. The script prints each bot it finished, so a bot whose files refuse to go holds back only itself, and the loop tries it again on each pass.

A login that a bot passed on stays with the other bots and in the jar, because it is the owner's login and not the bot's.

### How a login moves

The owner logs in once during a take-over, and every bot on that computer can use the login, whether it is running, stopped, or not created yet. Each browser keeps its own profile, because a profile admits one process, and one process across displays is the shared browser we rejected. So a login moves as cookies, through CDP.

Only what a take-over changed moves. Copying all of a bot's cookies would let an old session in one bot overwrite a newer one in another. `computerd` records a bot's cookies when a take-over opens, compares them when it ends, and merges the difference into a jar. A logout is an entry with a past expiry and no value, so one code path sets and deletes. Only a control stream takes part, so a bot's own browsing never moves anything.

`apps/computerd/src/logins.ts` owns all of this, and nothing else reads its files. They are mode 0600 in `/var/lib/computerd`, which the `browser` user cannot read.

| Record | Where | What it does |
|---|---|---|
| The jar | `logins.json` | One entry for each cookie's name, host, path, and partition, and a generation that comes from the clock and only rises |
| A baseline | `takeovers/<botId>.json` | The cookies when a take-over opened, and which browser held them. It goes last, so a crash repeats the diff, and an equal value adds no generation |
| A cursor | A cookie on `logins.bots.invalid`, in each browser | How far that browser has come. `.invalid` cannot resolve, so no site receives it |

The cursor lives in the browser so that it dies with what it describes. A stop within 30 seconds of a push loses the new cookies and the cursor together, so the next start applies them again. A stop after the flush keeps both, so a cookie that the bot has since rotated stays as the bot left it. A real VM showed the order this needs, in the table below. A session cookie has no such protection, because a restart drops it. So it comes back once for each start of a browser, unless it was logged out. A second reserved cookie names the browser that last had this, so a restart of `computerd` cannot take a running browser for a new one and undo a logout.

| Event | What happens |
|---|---|
| A take-over opens | Catch up, write the baseline unless a newer tab is taking over from a stream that is still open, and count this stream. All of this comes before the input stream restarts, so the baseline comes before any key |
| A give-back, an expiry, or a phone that drops | The relay closes. When no stream of that bot is left, catch up, diff, merge, push, and delete the baseline. It gets one attempt. A baseline kept past a failure would later move what the bot has browsed since, over the other bots' sessions, so missing a move is the safer mistake. The relay keeps its lease until then, so the desktop cannot stop during the read |
| A bot's browser tool arrives | It waits until that bot has no input stream and its cookies are read, for up to 15 seconds. The runner resumes a bot as soon as a take-over ends, and the stream can close up to 5 seconds later, so without this a cookie that the bot changes would move as if the owner had changed it |
| A newer tab | It counts before its restart ends the older tab, so the older close leaves the count at 1, and the first baseline stays |
| `computerd` restarts | Only a kill leaves a baseline. `recover` runs first at startup and publishes it |
| A stopped or new bot starts | It catches up inside `acquire`, after systemd starts its browser and before anything can use it. A failed catch-up logs and goes on, because a bot without a login is better than a bot without a browser |

A push is a catch-up on each of the 8 CDP ports, so it needs nothing from the desktops code, and a refused port is just a stopped slot. A catch-up uses its own short socket and browser-level `Storage` calls, so it skips the per-bot queues and reloads no page. Every `acquire` makes one, so it first compares the browser's GUID and the jar's generation with what it last applied, and returns if neither changed. That connection takes about 1 ms on a real VM. A push into a bot under take-over cannot come back as a new change, because an equal value adds no generation.

A logout stays in the jar for 400 days. Chromium keeps no cookie longer, so after that no browser can still hold what it was for, and a stopped bot has no schedule that a shorter limit could rely on.

`computerd` logs counts and never a cookie's name or value. A JSON parse error quotes its input, so an unreadable jar logs only that it happened. It then starts empty, which is safe, because the next generation comes from the clock and is still ahead of every browser's cursor.

We tested these on a real VM, on Chromium 156, before building this:

| Test | Result |
|---|---|
| `Storage.setCookies` with a past expiry | Deletes plain, domain, HttpOnly, `__Host-`, session, and partitioned cookies. A logout for a cookie that a browser lacks is accepted |
| A batch with one invalid cookie | Chromium refuses all of it and sets none, so a refused batch retries one cookie at a time |
| A cookie on a `.invalid` domain | Accepted, and kept across a stop and a start |
| A cursor set last, in 20 stops and kills placed around the flush | Never on disk ahead of its batch. A batch that split, 256 of 300 and 511 of 600, reached disk as a prefix with no cursor. A batch sent 20 seconds before a stop was lost whole, with its cursor |
| Session cookies across a restart | A stop drops them. A kill keeps those already flushed, so a kill is not a reliable way to test this |
| The GUID in `/json/version` | Changes at a stop and start, at a kill, and at systemd's own restart |
| `__Host-`, SameSite, and partitioned cookies through `getCookies` then `setCookies` | Read back the same in every field, and a real request sends them |
| More than 180 cookies on one registrable domain | Chromium evicts the oldest. This made an early flush test look like a failure |

`infra/proxmox/verify-desktop.sh` proves this on a real VM through `scripts/verify-logins.ts`. That script runs the real `main.ts` under a private unit, with a private state directory and a link on loopback, so a kill is real, it needs no route through the guard, and no test cookie enters the VM's real jar. `pnpm verify:takeover` checks the same thing through the real orchestrator after a deploy.

### What the browser tests showed

We tested a shared browser in an arm64 Debian container against a local page, and later on a real user VM with real websites and the sandbox on. These results still set rules for each browser:

| Test | Result |
|---|---|
| Chromium under its own user, with its sandbox on | `chrome://sandbox` reports that it is adequately sandboxed |
| Two windows receive `xdotool` input at once | Characters landed in the wrong windows |
| Two bots type 100 characters each through CDP at once | Neither input mixed with the other |
| Type through a VNC stream right after a click on another screen | The first keys reached the previous screen's window, even after a 200 ms wait |
| Type through CDP with X focus on another window | Every key reached its page, on every target |
| Send keys and clicks through a VNC stream started with `-viewonly` | No screen received any input |
| Change a dropdown through CDP | The menu appeared on the stream. The keyboard changed the value, and a mouse click on an option did not |
| Type into the real login forms of GitHub and Wikipedia through CDP | The fields took the text, and `navigator.webdriver` was false |
| Close every window | Chromium exited |

The results set these rules:

- Bots drive the browser through CDP, not through desktop input.
- A person uses the desktop through VNC, and only during a take-over. A key cannot reach another bot's window, because each bot has its own display. Across 4 displays and 2,880 keys, none did.
- The watch stream stays view-only, so only a stream that exists for a take-over can take input.
- Take-over has a typing box and a key bar for arrows, Enter, Esc, and Tab, because a phone has no such keys and the noVNC library has no phone keyboard.

The owner used a take-over on a real phone on 2026-11-06. It works, and the key bar is still needed. The step 4 check still has to run on a phone with two bots.

### How a stream reaches its owner

A VM accepts no inbound connections, so a stream is one more outbound connection. The web app opens a WebSocket to the orchestrator. The orchestrator asks `computerd` over the link for that bot's screen, and `computerd` dials back to the link port with its token. The orchestrator then relays bytes between the two, and it accepts a dial only for a stream that it asked for, from a computer of the bot's owner.

During a take-over, the bot waits before its next tool. That state is in Convex, so a restarted orchestrator keeps waiting, and if it cannot read the state it waits too, because starting a tool while a person may be typing is the worse mistake. If the owner leaves without giving back, the take-over expires after 15 minutes and the bot carries on.

A take-over swaps the view-only stream for an input stream on `/screens/<bot>/input`. The orchestrator opens that path only during a take-over, and it checks again every 5 seconds and closes both ends when the take-over ends. Past those checks it is the same byte relay as the watch stream. Nothing logs the bytes, because they can hold a password. `x11vnc` logs the keysyms it adds to the display unless it runs with `-q`, so that flag must stay.

The input stream removes itself, so no code has to clean it up and no state has to survive a crash:

- `-once` ends it when its viewer leaves. So a closed relay, a dead `computerd`, a dead orchestrator, and a give-back all end it through the TCP close. A real VM closed the port 757 ms after a kill of the orchestrator and 806 ms after a kill of `computerd`.
- `-timeout 15` ends it if nobody connects.
- It has no `Restart=`, and the desktop target does not want it, so only a new take-over brings it back.
- `-clear_keys` releases what a viewer held. Without it, a viewer that left with Ctrl down turned the next viewer's typing into shortcuts.

`computerd` restarts the unit for each take-over. That also ends an older take-over from another tab, so a desktop has at most one person's input stream, with no map to keep. x11vnc sometimes hangs on SIGTERM with a viewer connected. A real VM saw this in 13 of 130 restarts, stuck on a futex, so the unit has a 3-second stop limit, and a newer tab no longer waits out `computerd`'s 75 seconds and fails. The older tab sees that the take-over is no longer its own and does not give it back.

x11vnc reports nothing back to the page, so the typing box decides what it can send. It refuses a character with no key, and a character past the limit in the next paragraph, before it sends anything, and it says so. A password that loses a character with no error would just be wrong.

The display has a US keyboard. x11vnc adds any other character to a free key, and a real VM ran out after 17 or 18 different ones in one session, whatever the typing speed. `x11vnc` frees those keys when it exits.

A VM updates after its orchestrator, and an older `computerd` closes its link on a field it does not know. So a watch stream's link message has no mode, and only control carries one. A take-over against an older `computerd` costs a 260 ms link reconnect and fails after 10 seconds, and a watch stream never notices.

Tailscale sends a user's identity with every request, whichever page caused it, and a browser lets any site open a WebSocket. So the orchestrator also requires the request's `Origin` to match its own host, on both the stream and the input. Without this check, any site that a user visits could watch that user's screens or type into them.

## How approvals work

The orchestrator decides on every tool call before it sends the call to a computer. A VM is untrusted, and it never takes part in this decision. Each bot has one level:

| Level | What asks first |
|---|---|
| Everything | Every tool |
| Outside, the default | Shell commands and browser actions that change something |
| Shell | Shell commands |
| Nothing | No tool |

Each tool in `packages/protocol/src/tools.ts` names one effect, and a tool without one fails the typecheck. So a tool added later has to choose an effect, instead of asking by default. At the default level, a tool that reads or that changes only the VM runs without asking, and a tool that changes something outside asks. A new effect fails the typecheck until `needsApproval` gives its answer.

A request is a row in Convex, keyed by the run and the call, so a restarted orchestrator finds the same request and the same answer. Only the bot's owner can answer, and the first answer stands. If the orchestrator cannot read the answer, it keeps waiting, so an outage never runs a call. A refusal, an expired request, and a cancel all leave the call unsent.

Approvals are a check on what a bot asks to do, not a sandbox. An approved shell command runs as a user with `sudo`, and what it starts is not asked about again. The network rules still hold, and step 8 adds the independent reviewer.

## Why only the owner can write an assignment

A bot's assignment is text that the model reads on every call, in every conversation. Whoever can write it decides what the bot works on from then on. If a bot could write its own, one prompt-injected page could leave a lasting instruction that reads as the owner's. So the assignment is an owner's field, and a bot's own notes, when they come, are a separate thing that ranks below it.

One mutation writes it. `bots.setProfile` goes through `requireOwnedBot`, which finds the `users` row for the caller's token and compares it with the bot's owner. The orchestrator's service token has no `users` row, so it gets the same "Bot not found" as another user. The runner reads through `bots.promptFor`, which only the service token can call, and it has no way to write. No tool reaches `setProfile`. A bot holds no Convex token, and its VM reaches only the internet and the link port, so it cannot call Convex or open the web app.

The runner reads the assignment before each model call and not at the claim. An edit during a run reaches the next call, and a resumed run reads the current text. The cost is that no event records which text a model call saw.

An assignment is not a permission. The system prompt tells the model that the assignment cannot override the fixed rules, but that sentence is an instruction to a model and no code checks it. The checks that matter stay in code, so approvals and the network rules hold whatever an assignment says. Convex stores it in plain text, as it does the chat.

## Where secrets live

The orchestrator holds Mistral keys and OAuth tokens, encrypted with a master key that only it can read. Convex stores the ciphertext and the key's last 4 characters, and the web UI shows those 4. A Mistral key uses AES-256-GCM with the owner's user ID as authenticated data, so a ciphertext copied to another user's row does not decrypt. Bots call connector tools without receiving the tokens.

The orchestrator signs a short-lived JWT with the subject `service:orchestrator` for its own Convex calls, and every service function checks that exact subject. User subjects always start with `dev:` or `tailscale:`, so a user token cannot pass that check.

`computerd` holds only its link token. A VM is untrusted, so the orchestrator validates every link message, closes the socket on an invalid one, accepts a result only for a call it sent on that socket, and caps output again.

Logins that a user types into a bot's browser during a take-over stay on the VM. They move to that VM's other bots, and `computerd` keeps the cookies, not the password, in a file that the browser cannot read. A bot with `sudo` can read that file, as it can already read a browser's logins through CDP, and those bots have one owner. A user logs in through take-over until the Vault ships, so passwords never enter the chat. When the Vault ships, bots lose passwordless `sudo`. Otherwise a bot could read a filled password from browser memory.

Chromium and `computerd` run under their own Linux user from the first version to keep that later change small.

## Accepted risks

- The server has one disk and no off-server backups. A disk failure loses every VM and every chat. LVM-thin snapshots protect only against a bot damaging its VM.
- The operator can read friends' chats and keys. Friends need to know this.
- Bots browse from the operator's home IP address, so abuse by one user reflects on that address.
- Prompt injection remains possible. Approvals, read-only scheduled runs, and network rules limit the damage.

## What we took from other products

Bots copies these ideas:

- Grok Bot: one computer for each user, one screen for each bot, a write-only Vault, and connector tools that hide OAuth tokens from bots.
- Dots: an Activity view, take-over, read-only background research, four approval levels, and a separate review model that the agent cannot turn off.
- OpenBot: one gateway that decides on and records every tool call, and fails closed.

Grok Bot and Dots do not let users inspect or edit individual memories, according to reviews. Bots stores memory as rows that users can read, edit, and delete.
