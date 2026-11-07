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

A dev-mode orchestrator registers its own login's computer at startup, and it claims only that login's runs. Test orchestrators therefore share one Convex backend with a developer's own without touching each other's runs. [A bot with no runner](#a-bot-with-no-runner) says what that means for a routine.

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

Each browser belongs to one bot, so every page in it is that bot's. `computerd` keeps one CDP socket per bot and asks Chromium for its targets on every look. The newest page is the current one, so a popup is current until it closes. This takes no events, no window moves, and no state file. After a `computerd` restart, the list rebuilds with pages that have an opener last, so a popup stays current.

A look reads the pages of one browser context, which `ContextPages` names. A chat call looks in the default context, and a read-only run's call looks in its own, so neither can land on the other's page. [How a read-only run browses](#how-a-read-only-run-browses) explains the second one.

### What a page can do to a browser tool

A page cannot hold a browser tool, a desktop, or a bot's queue. The tool always returns, and its hold is released, so the idle stop can run and a ninth bot can take the slot.

`PageCall` in `apps/computerd/src/browser.ts` is the one owner of this. Each CDP call through it ends when the call's signal aborts or at a 60 second deadline, and none starts after that. The link gives a browser tool 120 seconds, which is 60 for the tool and a 60 second margin. So a take-over's wait, a desktop's start, and closing a page fit in the margin, and the model reads what happened and not `unavailable`.

A call that ended early then finds out what it left behind. It stops any loading, because Chromium holds a session's page calls during a navigation, and a server that never answers would otherwise look like a frozen page. Then it asks the page for one answer, and it waits 5 seconds.

| What the page did | What the model reads | What happens to the page |
|---|---|---|
| It answers | `timeout` or `cancelled`, and any navigation was stopped | It stays |
| It gives no answer | `timeout` or `cancelled`, and the page froze and was closed | A new blank page opens, and then the frozen page closes. The next call works on the new page, and an old ref gets the stale ref error |
| It gives no answer while the owner has the screen | `timeout` or `cancelled`, and the page stayed open | It stays, because the owner may be answering it |
| The browser does not close it in 3 seconds | `timeout` or `cancelled`, and the browser did not close it | The next call tries again. The idle stop can still run |

The order of those two page steps matters. Chromium exits when its last page closes, and a test on a real browser lost the browser that way. The 5 and 3 seconds fit inside the 10 seconds that the link waits after a cancel, so a cancelled call says `cancelled` and not that the computer could not be reached.

Dialogs are the one thing here that takes events. A page with an open `alert()` answers nothing, and Chromium keeps the dialog open until something answers it. So each connection uses `Target.setAutoAttach` with `waitForDebuggerOnStart`, and every page has a session with `Page.enable` before its first script runs. `computerd` refuses `alert`, `confirm`, and `prompt` as soon as they open, in any page, whether a call is running or not. It accepts `beforeunload`, so a page cannot refuse a navigation.

A person who has the screen answers dialogs for themselves, or a take-over could not accept a site's `confirm()`. Page calls wait while a dialog is open, and the next call after the person leaves clears what they left.

The rule that the browser holds the truth still applies. None of this keeps state on disk. After a kill, the journal answers `interrupted`, and a new `computerd` finds a frozen page at its next call, through the same deadline and the same close. A dialog that opened with no socket attached sends no event, even after `Page.enable`, so its page takes the same path. A repeat of a frozen call replays its stored result, and it does not touch the page.

A page can still waste up to 60 seconds of a run for each call. In a chat run it can also use a CPU core until its desktop stops. Same-site pages share a process in Chromium, so a popup that freezes also freezes its opener. The opener stays open behind the new page, and it stays frozen. A logged-out page does not get this far, because a freeze ends its whole context.

We tested these on Chromium 156 in a container, with its sandbox on, using a visible Xvfb display:

| Test | Result |
|---|---|
| `Target.closeTarget` on a page in `while(true){}`, on a page that also spins in `pagehide`, and on a page in a loop of `alert()` | Closed within 10 ms, and gone within 600 ms |
| A dialog that opened before anything attached | No event, even after `Page.enable`. `Page.handleJavaScriptDialog` says no dialog is showing. `Target.closeTarget` still works |
| A popup whose first script calls `alert()`, with `waitForDebuggerOnStart` | The event arrives, and the script carries on after the answer |
| `Runtime.evaluate` during a navigation to a server that never answers | No answer until `Page.stopLoading` |
| `Page.enable` with nothing answering a dialog | The dialog shows on the display, and a key press answers it |
| The socket dies while a popup waits for its debugger | The opener answers again. The popup stays blank |
| A service worker with `filter: [{ type: "page" }]` | It does not wait for a debugger |

### Where a profile comes from

A bot's profile is `/home/browser/profiles/<botId>`, and it starts as a copy of `/home/browser/profile`, the base. Nothing opens or writes the base, so nothing can damage a login in it. VM 201's logins became the base without moving. A real cookie written by the old shared browser reads back from a copied profile, with `--password-store=basic`. The copy goes to `<botId>.tmp` and is renamed when whole, so a kill midway leaves nothing that a later start could use by mistake. The update stops the old browser before anything can copy the base.

A new bot is that copy plus a replay of the logins that have moved since. So the base never needs a write, which would take a throwaway Chromium for each change and make a second record of the same logins.

### Deleting a bot

The bot page deletes a bot, and it refuses during a run or a take-over, because either would lose its desktop midway.

| Where | What goes | When |
|---|---|---|
| Convex | The bot's row, its notes, and its routines | At once, in the mutation, so nothing new can start on it. Notes and routines go here because few enough fit one mutation, and `purge` stops early for a bot with no thread |
| Convex | Every thread of the bot, including each routine's, with its runs, events, streams, and approvals | In batches, because one thread can hold more than a mutation may read. Each thread goes last |
| The VM | Its desktop, profile, workspace, and any take-over baseline | Within about 15 seconds, by the reconcile loop |
| The VM | Its tool results in the `computerd` journal | At the journal's own limit of 7 days |

`bots.remove` adds a `removedBots` row in the same mutation, and the loop deletes that row only after `infra/proxmox/forget-bots.sh` has succeeded. So a VM that is off, or a kill at any point, repeats the removal, which is safe. The script runs as root through the guest agent, as an update does. So it needs no new sudo rule or link message, and it works on a VM whose `computerd` is older than the orchestrator. `computerd` can keep an idle claim on the slot that the script stopped, and its sweep ends that claim within an hour. The script prints each bot it finished, so a bot whose files refuse to go holds back only itself, and the loop tries it again on each pass.

A login that a bot passed on stays with the other bots and in the jar, because it is the owner's login and not the bot's.

### How a login moves

The owner logs in once during a take-over, and every bot on that computer can use the login, whether it is running, stopped, or not created yet. Each browser keeps its own profile, because a profile admits one process, and one process across displays is the shared browser we rejected. So a login moves as cookies, through CDP.

Only what a take-over changed moves. Copying all of a bot's cookies would let an old session in one bot overwrite a newer one in another. `computerd` records a bot's cookies when a take-over opens, compares them when it ends, and merges the difference into a jar. A logout is an entry with a past expiry and no value, so one code path sets and deletes. Only a control stream takes part, so a bot's own browsing never moves anything. Its `Storage` calls name no context, so they read and write only the default context, and a logged-out page's cookies never reach the jar.

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

A VM updates after its orchestrator, and an older `computerd` closes its link on a field it does not know. So a watch stream's link message has no mode, and only control carries one. A take-over against an older `computerd` costs a 260 ms link reconnect and fails after 10 seconds, and a watch stream never notices. A read-only run's call has the same problem, and [How a read-only run browses](#how-a-read-only-run-browses) has its answer.

Tailscale sends a user's identity with every request, whichever page caused it, and a browser lets any site open a WebSocket. So the orchestrator also requires the request's `Origin` to match its own host, on both the stream and the input. Without this check, any site that a user visits could watch that user's screens or type into them.

## How approvals work

The orchestrator decides on every tool call before it sends the call to a computer. A VM is untrusted, and it never takes part in this decision. Each bot has one level:

| Level | What asks first |
|---|---|
| Everything | Every tool |
| Outside, the default | Shell commands and browser actions that change something, a memory tool once a computer tool has a result in this run, and a routine's proposal |
| Shell | Shell commands, and a routine's proposal |
| Nothing | Only a routine's proposal |

Each tool in `packages/protocol/src/tools.ts` names one effect, and a tool without one fails the typecheck. So a tool added later has to choose an effect, instead of asking by default. At the default level, a tool that reads or that changes only the VM runs without asking, and a tool that changes something outside asks. A memory tool's answer depends on the run, as [How memory works](#how-memory-works) explains. A proposal asks at every level, as [How a routine fires](#how-a-routine-fires) explains. A new effect fails the typecheck until `needsApproval` gives its answer.

A request is a row in Convex, keyed by the run and the call, so a restarted orchestrator finds the same request and the same answer. Only the bot's owner can answer, and the first answer stands. If the orchestrator cannot read the answer, it keeps waiting, so an outage never runs a call. A refusal, an expired request, and a cancel all leave the call unsent.

Approvals are a check on what a bot asks to do, not a sandbox. An approved shell command runs as a user with `sudo`, and what it starts is not asked about again. The network rules still hold, and step 8 adds the independent reviewer.

## Why only the owner can write an assignment

A bot's assignment is text that the model reads on every call, in every conversation. Whoever can write it decides what the bot works on from then on. If a bot could write its own, one prompt-injected page could leave a lasting instruction that reads as the owner's. So the assignment is an owner's field, and a bot's own notes are a separate thing that ranks below it.

One mutation writes it. `bots.setProfile` goes through `requireOwnedBot`, which finds the `users` row for the caller's token and compares it with the bot's owner. The orchestrator's service token has no `users` row, so it gets the same "Bot not found" as another user. The runner reads through `bots.promptFor`, which only the service token can call, and it has no way to write. No tool reaches `setProfile`. A bot holds no Convex token, and its VM reaches only the internet and the link port, so it cannot call Convex or open the web app.

The runner reads the assignment before each model call and not at the claim. An edit during a run reaches the next call, and a resumed run reads the current text. The cost is that no event records which text a model call saw.

An assignment is not a permission. The system prompt tells the model that the assignment cannot override the fixed rules, but that sentence is an instruction to a model and no code checks it. The checks that matter stay in code, so approvals and the network rules hold whatever an assignment says. Convex stores it in plain text, as it does the chat.

## How memory works

A bot keeps notes that last across runs, and it writes them by itself with `memory_save` and `memory_forget`. The owner reads and edits every note in the bot's info panel. Each note is a row in `memories`, with its bot, its text, and its source, which is the owner, or the bot and the run that saved it. A run reads the notes through `bots.promptFor` before each model call, so a save reaches the next call of the same run, and an owner's delete is gone from it.

Rows are immutable. An owner's edit deletes a row and inserts a new one in one mutation, so an edit cannot interleave with a bot's forget. The loser of that race gets "no such note". The edited note counts as the owner's, because the owner has read it.

Notes live in Convex and not on the VM. A bot has root on its VM, so anything that runs there could change a file, and a computer is not a permanent store. The owner must also be able to read and edit notes while the computer is off. So `memory_save` and `memory_forget` never reach the link. `toolInvocation` is the link's wire type and leaves them out, so a memory call passed to `Link.call` fails the typecheck. `verify:agent` runs one with `computerd` stopped, and finds no journal entry for one.

`users.about` is one string that the owner writes about themselves, up to 2,000 characters, and all of that owner's bots read it. No tool writes it. If a bot could write a fact that other bots read, one injected page could reach every bot.

### One mutation writes a note and its result

`runs.append` takes a memory call as well as an event body. It checks the lease and the sequence number, then `applyMemoryCall` makes the change and returns a `toolResult` body, and that body goes in as the event. All of this is one Convex mutation, and `applyMemoryCall` has no endpoint of its own. So a memory call happens exactly once, where a call through `computerd`'s journal happens at most once, and it needs no new table or idempotency key.

| Kill or failure | What the next runner finds | Result |
|---|---|---|
| Before the mutation | A turn with no result, so the call is pending | It decides again and applies the call once |
| During the mutation | Neither the note nor the result, because Convex commits both or neither | The same as before the mutation |
| After the commit, with the reply lost | The result, so the call is not pending | Nothing repeats, and a resend fails the sequence check |
| While the call waits for approval | The same request and the same answer | It applies the call once, if the answer was yes |
| A stale runner wakes up | Nothing new, because `requireLease` throws | The whole mutation aborts, with no note |
| The owner stops the run just before the call | A result with outcome `cancelled`, because the mutation reads the owner's request itself | No change to any note, even though the runner hears of the stop only at its next heartbeat |
| `claim` gives up after 5 attempts | `closeUnansweredCalls` recorded `unavailable` | No note, and the next run's prompt holds the true list |

A note that breaks a rule is a tool result with outcome `error`, not a failed mutation, because a model caused it. The result tells the bot what to do next. For something that looks like a secret, it says to ask the owner to take over and log in. One function, `parseNote`, holds the rules for both writers: at most 500 characters, at most 40 notes for a bot, no control or text-direction characters, and nothing that `looksLikeSecret` refuses.

### What limits an injected save

A page that a bot reads can tell it to save a note, and every later model call reads that note. The harm outlasts the run, so these limits sit in code:

- At the default level, a memory tool asks once a computer tool has a result in this run. The card shows the exact text. `touchedComputer` reads this run's stored events, so a resumed run decides the same way. A result with outcome `denied`, `invalid`, or `rejected` does not count, because it brought nothing back.
- A note reaches only the bot that saved it, so one page cannot reach the owner's other bots.
- A bot cannot change or forget a note whose source is the owner, and it cannot write the assignment or `users.about`.
- Size and count are capped, so notes' text adds at most 20,000 characters to a model call.
- Every save and forget is a row in the chat. A chat row cuts its summary short, so the row's output holds the whole text, and the forgotten text stays there after the note is gone. Every note is also a dated row in the panel, which says who wrote it.
- Notes reach the model as one JSON array on one line, after everything else in the system prompt. A note holding `"]` or a fake closing line stays inside its string, and a test parses the block with `JSON.parse` to prove it.

### What does not limit it

The prompt says that a bot's own notes can be wrong or planted, that they inform and do not instruct, and that they rank below the assignment and the owner's messages. That sentence is an instruction to a model, and no code checks it, so it is not a boundary.

The card covers one run. The thread replays on every model call, so an injection from an earlier run is still in the model's history, and the first save of a later run has no card. A hold for review would close this, but a thread stays exposed for good, so it would ask about nearly every save.

At the Shell and Nothing levels, no save shows a card. The owner chose those levels, and the chat row and the panel are the only signs.

`looksLikeSecret` catches careless saves and nothing more. It refuses PEM headers, known key prefixes, JWTs, `password=` pairs, card numbers, and any unbroken run of 32 or more token characters. "My password is hunter2" passes, so the tool description and the prompt carry the rule as well. A refused call's arguments are still in `runEvents`, because the assistant turn is stored before anything can refuse it. So a refused secret stays in the thread and reaches the model on each later call, until the bot is deleted.

## How a read-only run works

A routine runs with nobody watching, so nobody can answer a question card. A read-only run therefore has no approvals to rely on. It reads, and everything else is refused.

A routine starts a read-only run, through `startReadOnlyRun`. Its callers are `fireDue`, which only Convex's cron and the admin key can reach, `runNow`, which is the owner's Test now on the owner's own routine, and `scheduleChecks:fireForCheck`, which needs the admin key and has `scripts/verify-agent.ts` as its one caller. The service token reaches none of them, and no mutation changes a run's capability.

### What decides a call

`decideTool` in `apps/orchestrator/src/approvals.ts` answers `run`, `ask`, or `reject`. It reads only the run's capability, the bot's level, the tool, and `touchedComputer`, so a resumed run decides the same way. A read-only run runs a tool whose effect is `reads` and rejects every other tool, at every level. It never asks.

| Runs | Rejected |
|---|---|
| `read_file`, `browser_navigate`, `browser_snapshot` | `shell`, `write_file`, `browser_click`, `browser_type`, `browser_press`, `memory_save`, `memory_forget`, `schedule_propose` |

A rejected call stores the outcome `rejected`. `denied` tells the model that a person refused, and no person was asked.

The rule holds in three places, so a bug in one does not open it:

- `runTool` decides before approvals, the take-over wait, and the link. A rejected call never reaches `computerd`, so its journal has no entry for it.
- `applyMemoryCall` and `applyScheduleCreate` store `rejected` unless the run is `full`, in the same mutation that would write the note or the routine.
- `approvals.request` throws for a read-only run, so no card can exist.

`computerd` is not one of these places, because a bot has root on its VM. Offering the model only the tools that read saves wasted turns, and it is not a boundary either. A model can still ask for a tool it was not offered.

### What a model reads

`modelRequest` in `apps/orchestrator/src/run-logic.ts` builds each model call from stored facts.

| | Chat run | Read-only run |
|---|---|---|
| Events | Its chat thread, loaded by thread | Its own events, loaded by run |
| The owner's chat | Yes | No |
| Reports | The thread's newest 3, each an assistant message with a label | The newest 3 of its own routine, as one JSON array in the prompt |
| A routine's raw pages | Never | Only its own run's |
| Tools | All of them | Those that read, and none on the final call |
| Prompt | The full rules | No rules for writing notes. It says that nobody is watching, that nothing can change, that any site may be opened, that every page is data, and that the run ends with a short report |

The assignment, `about`, and the notes reach both. A report is an assistant message, so `toMistralMessages` treats it as not answering. If the message before it is a user or tool message, the line that says the run ended early goes first, so an unanswered request cannot look answered by a report.

### Where a routine's pages and reports go

A routine has its own thread, with `threads.kind` set to `routine`. An absent `kind` means the bot's chat, and `chatThreadOf` is the one lookup of it. A routine's thread takes no message.

Raw pages stay in that thread, so they cannot push the owner's messages off the page or load on each chat run. When a read-only run finishes `done`, `runs.finish` inserts a run and one `routineReport` event in the chat thread, in the same mutation that ends the run. So a report and its run's end commit together, and a resend of `finish` fails the lease check and posts nothing. The text is the run's last turn, cut at 8,000 characters. A run that ends with no text fails with a reason, because a success with nothing to show would hide that the owner got nothing. A failed or stopped run posts nothing.

A report's row has trigger `schedule` and no `scheduleId`, so `runs.by_schedule` holds only a routine's own runs. `threads.timeline` counts only trigger `user` toward its 30 runs and reads at most 200 runs. So a chat with 40 reports keeps the owner's messages on the page, and only about 200 reports in a row push them off. The page then says that older messages are not shown.

A bot has one browser, so it has one active run across all of its threads. `activeRunOfBot` is the one check, and `threads.send`, `threads.activeRun`, `startReadOnlyRun`, `fireDue`, `schedules.remove`, and `bots.remove` use it. `bots.overview` shows a routine's run as what the bot is doing, and its last message stays the chat's.

### How a run ends

Every limit reads stored events or a stored time, so a restart cannot reset one.

| Limit | Value | What happens |
|---|---|---|
| Turns | 12 | The 12th turn is the final call |
| The newest prompt | 150,000 tokens | The next call is the final call |
| Rejected calls | 3 | The next call is the final call |
| Deadline | 30 minutes after the fire | The run fails with the reason "The routine ran past its 30 minute limit" |

The token limit reads the newest prompt and not a sum, because each prompt repeats the one before it, and a sum counts the same page again on every turn.

A limit always gives the run a chance to report. The final call offers no tools, and its prompt says to write the report now. If that call still asks for a tool, the call is recorded as rejected, nothing runs, and the run finishes with the turn's text. No flag marks a final call. A turn is final if a limit already held before it, so a resumed run reaches the same answer from the same events.

`heartbeat` answers `cancelRequested: true` past the deadline and does not store that, so `run.cancelRequested` still means that the owner pressed Stop. The runner then stops as it does for a Stop. `runs.finish` turns its `cancelled` into `failed` when the deadline has passed and the owner did not stop it, and `claim` fails a run that is already late. `fireDue` does the same for a run that no runner holds, as [A bot with no runner](#a-bot-with-no-runner) explains. An owner's Stop stays `cancelled`. `endRun` in `runEnd.ts` is the one writer of a terminal state and of `endedAt`.

A chat run's failure after 5 attempts with no progress says to send another message. A routine's says that it tries again at its next time, because a routine has no message to send.

### What read-only does not mean

Read-only stops the bot's own tools from changing anything. It is not a sandbox, and these still happen:

- A run can read any file that the `agent` user can read on its VM, including another bot's workspace. Those bots have one owner.
- Opening a page sends a GET and runs the page's scripts. A careless site can change something on a GET.
- A URL can carry out what the run holds, which is its assignment, `about`, notes, and any file it read. A page can ask for this, and the prompt's rule against it is an instruction to a model.
- Text in a report reaches later chat runs as the bot's own earlier words, and a page can plant it. The label is also an instruction to a model. `touchedComputer` covers only the run itself, so a chat run's first save after such a report shows no card at the default level.
- A process that an earlier chat run left in the background keeps running during a routine.

### How a read-only run browses

A routine may open any site, and nobody is watching it, so a page it reads must not reach the owner's logins. The owner decided on 2026-11-07 that a routine browses logged out. So a read-only run's browser calls use a Chromium browser context of their own, which starts with no cookies and no storage.

`browsingForCall` in `apps/orchestrator/src/run-logic.ts` is the one place that decides this, and `Link.call` requires its answer. A read-only run's `browser_*` call carries `browsing: { kind: "loggedOut", key: runId }`. Its `read_file` and every chat call carry nothing, so their messages stay byte for byte what they were.

In `computerd`, a `Connection` holds the bot's own `ContextPages` and at most one `LoggedOutContext` record. `ContextPages` holds a context's id, its pages, and the exact parameters for a new page there. Every page lookup and every new page goes through it, including the page that replaces a frozen one. So a logged-out call has no code path to a page of the bot's own. If its context cannot be made or its downloads cannot be denied, the tool fails.

| What ends the window | Why it holds |
|---|---|
| `browsingEnd` from the runner | `finish` sends it before `runs.finish`, so a crash between the two sends it again from the resumed run. A run that never reached the browser sends nothing. A `claim` that ends a run answers `ended`, and the runner sends it then, because no other runner is left to do so |
| A browser call for another key, or a chat call | A bot has one active run, so such a call means that the window's run is over |
| A page that freezes | The whole context ends, along with any frozen opener, and it opens no replacement. The next call of the run makes a new context with a blank page. If a person has the screen, the window stays, as a page of the bot's own does |
| 10 minutes with no call | This covers a lost `browsingEnd`, as when the link is down at the run's end, or when `fireDue` ends a late run. A live run gets here only if a model call or a take-over lasts that long, and its next call then gets a blank page |
| `computerd` dies, or its socket closes | The context is made with `disposeOnDetach`, so Chromium ends it with the socket. So a restart leaves no window and has no old context to find. The resumed run's next call makes a new one with the same key |
| The desktop stops | The browser and everything in it stop. Nothing about a window holds a desktop, so the idle stop runs as usual |

The journal keys a call by its call id, not by this key. So a repeat of a call replays its stored result and makes no context, even after the window ended, and a call that `computerd` died during answers `interrupted`.

Chromium exits when its last page closes, in any context, and a real browser did this at a dispose when the bot had no page of its own. So `computerd` makes sure of a page in the default context before it makes or ends a logged-out one.

The window is on the bot's display, on top, so the owner can watch. It looks like any other Chromium window, with no mark that it is logged out. A take-over can start during a run, and the run then waits before its next tool. What a person types in that window stays in that window. A login made there does not move and goes when the window ends.

#### An older `computerd`

A VM updates after its orchestrator, and an older `computerd` closes its link on a field it does not know. On its own, that does not end the call. A real build of the commit before this field closed its link 79 times in 20 seconds, because the link retried the same call at each reconnect, and the call never returned. So a logged-out call whose link closes with the code for an invalid message ends as `unavailable` at once. The same build then closed its link once and journaled nothing, and a chat call on it worked. A chat call that shares the link retries as it does at any drop.

#### What limits a page, and what does not

These hold for a page in a read-only run:

- It reaches none of the owner's logins, so a form that posts to a site the owner uses arrives with no cookie.
- It cannot put a login in the jar. What it sets, and what a person types there, stays in its context and goes with it.
- It cannot download. `Browser.setDownloadBehavior` denies this for the context, including from a script and on an endless stream. A chat run's downloads are unchanged.
- It cannot move the bot's own page, which a chat run finds where it was left.

These do not change:

- A URL can still carry out what the run holds, which is its assignment, `about`, notes, and any file it read. A page can ask for this, and the rule against it is an instruction to a model.
- A page can make its visitor do anything that needs no login. A `GET` or a form runs from the owner's home IP address.
- A person who takes over during a run can type a password into a hostile page, because the window looks like any other. Nothing moves, but the page reads what was typed.
- A chat run still browses logged in, and its downloads still land.
- This is a rule in the orchestrator and in `computerd`, and a bot has root on its VM. A process that a chat run left behind can reach CDP on loopback, and it can drive any context.

#### Link addresses

A read-only run has no click, so it follows a link by opening its address. A logged-out snapshot shows `[3] a "Top story" to: https://...`, for `http` and `https` only, cut at 200 characters with `...` on the end. A `javascript:`, `mailto:`, or `data:` link shows no address, because `browser_navigate` could not open one.

A chat run's snapshot shows no addresses. A logged-in page's links can hold reset tokens and signed URLs, which the model and `runEvents` would then hold, and the URL line shows only the page that the bot already opened. A chat run can click a link instead. A logged-out page has none of the owner's logins, so its links hold none of the owner's secrets.

Addresses make a snapshot larger. On real pages, on 2026-11-07, with a snapshot's output capped at 32 KiB:

| Page | Links | Bytes without | Bytes with |
|---|---|---|---|
| Hacker News | 225 | 6,227 | 18,939 |
| Lobsters | 250 | 6,274 | 19,181 |
| GitHub trending | 174 | 5,401 | 12,545 |
| BBC News | 109 | 7,313 | 12,765 |
| Wikipedia, list of HTTP status codes | 254 | 45,542 | 91,536 |

The Wikipedia page passed the cap in both cases, so the model reads the same 32 KiB of a page that is twice as long, and sees less of its text.

Addresses cost more tokens per byte than prose does. We counted snapshot lines built from three real pages on 2026-11-07, with the v3 tekken tokenizer from Mistral's `mistral-common` package. Which tokenizer `mistral-large-4` uses is not something we checked.

| Page | Bytes, up to the cap | Tokens | Bytes per token |
|---|---|---|---|
| Hacker News | 4,196 | 1,443 | 2.91 |
| Lobsters | 20,494 | 8,207 | 2.50 |
| Wikipedia, list of HTTP status codes | 32,768 | 12,663 | 2.59 |

So one capped page is about 12,700 tokens. A read-only run has 11 turns of research, and each turn is one call when the model obeys `parallel_tool_calls: false`. If every turn returns a capped page, the prompt holds about 139,000 tokens of pages. The 150,000 limit then binds only near the last turn, and only when the assignment, `about`, the notes, and the earlier reports are near their own limits, which we estimate at about 14,000 tokens together. In most runs the turn limit ends research first. A model that asks for several pages in one turn reaches the token limit sooner.

We tested these on Chromium 156 in a container, with its sandbox on, a visible Xvfb display, and Xfce's window manager. `scripts/verify-logged-out.ts` repeats the ones marked as such:

| Test | Result |
|---|---|
| `Target.getBrowserContexts` | Names `defaultBrowserContextId`, and every target has a `browserContextId` |
| `Target.setAutoAttach` on the browser's socket | Covers pages in new contexts. A dialog in such a page's first script and in a popup's first script is answered, and the script carries on (repeated) |
| `window.open` from a logged-out page after a click | The popup stays in the context and is the current page (repeated) |
| `Target.disposeBrowserContext` on a healthy page, a page in `while(true){}`, and a page with `beforeunload` | Ended within 5 ms, and the browser stayed |
| A context whose last page closed | The context stays, and it takes a new page |
| SIGKILL of the real `computerd` during a call on a frozen window | The window was gone when we looked, 1.5 s later. The call answers `interrupted`, and the same key gets a blank page (repeated, with a closed socket) |
| A context made with `disposeOnDetach: false` | It outlives the socket, which is why this one is not |
| A dispose when the default context has no page, without the page that `computerd` now opens | The browser exited |
| A page that burns a core | 0.96 of a core while its window is open, and 0.00 after `browsingEnd` |

## How a routine fires

A routine is a saved instruction and a schedule, owned by one bot. The owner asks the bot in plain words, the bot proposes it, and the owner approves a card. After that it runs with nobody watching, as a [read-only run](#how-a-read-only-run-works), and its report appears in the bot's chat. There is no edit. The owner asks for a new routine and deletes the old one.

### One mutation creates a routine

`schedule_propose` has the effect `changesSchedule`. A read-only run rejects it. A chat run asks at every approval level, including Nothing, because a routine outlives the run that made it and runs later with nobody watching.

The tool has two arguments, the instruction and the cadence, and it refuses any other. So the model cannot attach a description of its own to the card. The card's title comes from `describeCadence` in `scheduleTime.ts` and the owner's time zone, and the card shows the whole instruction behind the lock that makes a person reach the end of a long command. The panel and the prompt read the same function, so what the owner approves and what the bot later says cannot differ.

When the owner approves, the runner sends `runs.append` a `scheduleCreate` call. `applyScheduleCreate` makes these checks in that one mutation:

| Check | If it fails |
|---|---|
| The lease and the sequence number | The mutation throws, and nothing is stored |
| The run's capability is `full` | The result is `rejected` |
| The owner has not pressed Stop | The result is `cancelled` |
| The approval row for this run and call is `approved`, for this tool | The result is `error` |
| The owner has a time zone | The result is `error`, and it says that Settings holds the zone |
| The instruction is at most 2,000 characters and `textProblem` accepts it, which is the same character and secret rule as a note's | The result is `error` |
| `parseCadence` accepts the schedule, which has at least 1 hour between runs | The result is `error` |
| The bot has fewer than 10 routines and the owner fewer than 20 | The result is `error` |

The approval comes from Convex and not from the runner, so a runner cannot create a routine that the owner did not approve. A card that the owner denied, or that expired, stores what any denied call stores.

The routine, its thread, and the tool result commit together. A kill before the mutation repeats the call, which finds the same approval row. A kill after the commit finds the result, so nothing repeats, and a resend fails the sequence check. `verify:agent` runs both with a SIGKILL.

A new routine waits for its next time. Test now runs it at once.

### What a tick decides

`crons.ts` runs `fireDue` once a minute. It takes up to 32 due rows from `by_next_fire`, and `decideFire`, which is pure, answers for each one. The first row of this table that holds decides.

| Facts | Decision | What changes |
|---|---|---|
| More than 15 minutes late, with the bot busy or not | Miss | Sets `lastMissed`, advances `nextFireAt`, and starts no run |
| The bot is busy | Wait | Nothing, so the next tick asks again |
| The owner has 48 scheduled runs in the last 24 hours | Miss | Sets `lastMissed` and advances `nextFireAt` |
| The newest 3 runs since `resumedAt` all failed | Pause | Clears `nextFireAt` and sets `pausedBecause` |
| Anything else | Fire | Inserts a queued run and its `scheduleFired` event, and advances `nextFireAt` |

A bot is busy if `activeRunOfBot` finds a run, if a take-over is on, or if a run ended less than 2 minutes ago, which `runs.by_bot_ended` answers. The 2 minutes give the owner time to reply to a run before a routine takes the bot.

Advancing asks `nextFireAfter` for the next time after now, so fires that a downtime missed collapse into one `lastMissed`. A failed run is not retried, and the routine runs again at its next time.

A report's row has trigger `schedule` and no `scheduleId`, so the limit of 48 filters on `scheduleId`, and a fire counts once. Test now counts toward the limit. It inserts the same run and leaves `nextFireAt` alone. It refuses during an active run, a take-over, or over the limit. It ignores the 2 minute rule, because the owner asked for this run.

Resume sets `resumedAt` and clears `pausedBecause`. The pause rule counts only runs created after `resumedAt`, so a routine that paused itself over a missing key runs again once the key is back. Without this it would pause again at its next tick, on the same three old failures.

### A routine's time follows Settings

`users.timeZone` is an IANA name. The web sends the browser's zone to `users.ensureCurrent`, which stores it when the account has none, and Settings changes it. A weekly routine runs at a wall time in that zone. `nextFireAfter` reads the zone through `Intl.DateTimeFormat`, so a local time that a clock change skips fires once on its day at the shifted instant, and a local time that repeats fires once at its earlier instant. Tests walk a daily routine across 14 months in eight zones.

`users.setTimeZone` does nothing when the zone did not change. Otherwise it recomputes only `weekly` routines whose `nextFireAt` is still in the future. A routine past its time keeps that time, so it can still fire inside its 15 minutes. A paused routine stays paused. An `everyHours` routine does not change, because it has no wall time. It counts from each fire, so its runs stay at least that many hours apart, and it moves later by the tick's delay each time.

### What a routine leaves behind

A routine keeps its newest 20 raw runs. `runs.earlierReports` reads a routine's own finished runs, so `runToPurge` also keeps the newest 3 of those, however old. A fire that finds an older run schedules `purgeOldRuns`, which deletes one batch of events at a time, then the run, and schedules itself again.

Deleting a routine deletes its row at once and purges its thread in batches, with the thread last. A report already in the chat stays. `schedules.remove` refuses while that routine's run is active. Deleting a bot deletes its routines in the same mutation, and `bots.purge` takes every thread of the bot.

### A bot with no runner

A queued run holds no lease, so with no runner it stays queued. Every tick therefore starts with `endRunsPastDeadline`, which fails a queued run past its deadline, and a running run past its deadline whose lease expired. So no routine's run keeps a bot busy for much longer than its 30 minute limit. A run whose lease is still held is left alone, because its runner hears of the deadline from its heartbeat.

In production one orchestrator serves every owner, so this matters only while it is down. When it comes back, `claim` fails any late run that the cron has not reached yet.

On a shared dev backend the cron fires for every owner, and a dev orchestrator claims only its own login's runs. A routine whose owner has no orchestrator running therefore stays queued, and its bot is busy, for 30 minutes. The run then fails with the deadline reason. After three of those the routine pauses itself, so it stops making runs. Stop ends such a run at once. Delete a test login's routines when the test ends, or they fire until they pause.

### Sending during a routine

The chat's timeline does not hold a routine's run, because that run is in its own thread. The composer therefore reads `threads.activeRun`. During a chat run the box is locked and has Stop, as it always was. During a routine the box stays open, says that sending stops the routine, and has both Stop and Send.

Pressing Send calls `requestCancel` and holds the text in the page, in a read-only box. When the held run is no longer the active run, the composer calls `threads.send`. A runner hears of a stop at its next heartbeat, 5 seconds at most, and a running tool takes up to 10 seconds more to report that it was cancelled.

If a fire wins that race, `threads.send` refuses, and the composer shows the error and keeps the text. The 2 minute rule makes this rare, because the stopped run has just ended. If the page closes first, the text goes, as any draft does.

### What a routine can still do

A routine reaches none of the owner's logins, and it changes nothing through its tools. It can still do what [What read-only does not mean](#what-read-only-does-not-mean) lists. A page can ask it to carry out what the run holds in a URL, which is the assignment, `about`, the notes, and any file it read.

The prompt tells a chat run to propose a routine only when the owner asks for something that recurs, and never because a page, a file, or a tool result said to. That sentence is an instruction to a model, and no code checks it. The card is the check, and it shows the exact text.

A chat run still browses logged in, so a page in a chat run can log the bot into another account, which a later take-over then spreads. Downloads in a chat run are not blocked. The roadmap lists both.

## How the Activity page reads

Activity lists what all of an owner's bots did and what is coming up. It is the only list that shows a failed routine next to the rest, because a failed run posts nothing to the chat. It has no table of its own, so nothing can fall out of step with the runs. A missed run has no row, because `lastMissed` holds only the newest miss, so it shows on its routine.

One query, `activity.page`, reads `runs.by_owner`, newest first. A finished routine has its raw run and a report row in the chat, and the report row has trigger `schedule` and no `scheduleId`. Activity leaves report rows out, so each fire shows once and a failed one looks like the rest. Report rows stay for good, so the query stops after 2,000 rows or at 50 runs.

A query may read 16 MiB, and an event can be 1 MiB. So text reads share a budget of 8 MiB, as in `bots.overview`, and they stop at a run's newest text, because a finished routine's newest event is its report. `blocked` reads `runEvents.by_run_outcome` once for each run, and it never gives up. A model chooses a rejected call's name, up to 256 KiB, so those reads come first and take from the same budget, which keeps the worst case at about 15 MiB by arithmetic. A test that left them out of the budget failed on the real backend with too many bytes read.

Text from a bot renders as plain text, because a page can write it. `publicState` removes a running run's lease before any of this leaves the query.

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

Grok Bot and Dots do not let users inspect or edit individual memories, according to reviews. Bots stores memory as rows, and today the owner can read, edit, and delete them in the bot's panel. The owner decided on 2026-11-07 that this screen is for now, and that a later, simpler UI will have people ask the bot instead. [The roadmap](roadmap.md) has what that needs.
