# Roadmap

Each step ends in a check. Start the next step only after that check passes. The reasons behind these choices are in [the architecture document](architecture.md).

| Step | Status | Build | Done when |
|---|---|---|---|
| 1a | Done | Repository, Convex in Docker, dev mode, and the web shell, on a Mac | The web app shows a live Convex query, using a JWT from `/auth/token` |
| 1b | Done, with gaps listed below | Control VM, `tailscale serve`, and Tailscale mode, on Proxmox | A second Tailscale account and a phone browser see the same live query, each as its own user |
| 2 | Done | Agent loop and shell and file tools, with `computerd` in Docker | A user chats with a bot in the web UI, and killing the orchestrator mid-tool resumes the run with no duplicate side effects |
| 3 | Done, with gaps listed below | Proxmox template, reconcile loop, and network rules | Provisioning converges after being killed midway, and a script proves that a VM reaches only the internet and the orchestrator |
| 4 | Done, with gaps listed below | Screens, live view, take-over, and approvals | Two bots work at once while a user watches one and takes over the other from a phone |
| 4b | Done, with gaps listed below | The redesign | On a phone and a computer, the owner creates a bot, chats with it, answers an approval, watches it, takes it over, and deletes it in the new design, and accepts the result |
| 5 | **In progress** | The standing assignment, memory, schedules, and the Activity view | The orchestrator rejects a write attempt from a scheduled run |
| 6 | | Friend invites | A friend goes from invite to working bot without help |
| 7 | | Tauri and Expo apps, and push | A user approves an action from a push notification |
| 8 | | OAuth connectors, the independent reviewer, and the Vault | Bots use saved logins without seeing the passwords, and bots no longer have passwordless `sudo` |

Step 3 isolates bots from the LAN. Friends join through the invites in step 6, and until then an operator declares each computer by hand.

Backups are deferred, and a computer is not a permanent store. A user will be able to reset a computer, which deletes its workspaces and browser logins. Add off-server copies of Convex exports and the master key before anyone depends on this system.

## Where things run

- The Proxmox host is `192.168.1.32`. Log in as `root` over SSH.
- The control VM is VM 110, `bots-control`, at `192.168.1.161`. Log in as `bots` over SSH, which has passwordless `sudo`. The app is in `/opt/bots`.
- Run `sudo tailscale serve status` on the control VM to find its `https://bots-control.<tailnet>.ts.net` address.
- The service runs as `bots-orchestrator`, which has no `sudo`. Keep it separate from the `bots` login: a process can take over another process of its own user, and `bots` has `sudo`.
- The control VM deploys a branch until someone deploys another. It runs `main` now. To update it, run [the deploy script](../infra/control-vm/README.md).
- User VMs use the `botsvms` network, `10.77.0.0/24`, with the gateway at `10.77.0.1`. The control VM is `10.78.0.2` on `botsctl`, `10.78.0.0/30`. The link listens only on `10.78.0.2:8788`.
- VM 9000, `bots-user-template`, is the template for user VMs. Its description names the commit of its `computerd`. A clone updates itself to the current commit, so the template can lag behind.
- VM 201, `bots-user-201`, at `10.77.0.21`, is the owner's computer. The orchestrator's reconcile loop owns it, and it is in slot 1. Reach it with `qm guest exec` on the host, because it accepts no inbound connections and has no SSH keys.
- VM 120, `huddle`, is on the same host and is not part of this system. It is not in the `bots` pool, so the reconcile loop does not touch it.
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

### Progress on step 4

1. Done. A test on a real VM settled how screens and input work. The architecture document has the results.
2. Done. `computerd` gives each bot a browser window, and bots use it through the `browser_*` tools. `pnpm verify:browser` runs two bots at once on real sites.
3. Done. Each screen streams to its owner in the web app, view-only, over the link port. `pnpm verify:screen` checks the stream and who can open it.
4. Done. An owner can take over a screen, and the bot starts no tool until the owner gives back or 15 minutes pass with no renewal. `pnpm verify:takeover` checks this on a real page. The owner used a take-over on a real phone on 2026-11-06.
5. Done. Each bot has an approval setting, which defaults to asking before shell commands and browser actions that change something. The orchestrator decides, and only the owner can answer.
6. Done. Each active bot now has a display, an Xfce desktop, its own Chromium, and a view-only stream, started on demand and stopped when idle. `infra/proxmox/verify-desktop.sh` proves this on a real VM, and a clone of the old template migrated with no hand steps. VM 201 also migrated with no hand steps in a real deploy, and `verify:screen`, `verify:browser`, `verify:takeover`, and the full network check all passed against desktops. Items 2, 3, and 4 of the next section's list are now done too: a take-over is the bot's real desktop through noVNC, and a login typed there reaches the computer's other bots. The checks in item 6 passed again after the last deploy. The owner reported on 2026-11-06 that the step's check on a real phone passed.

## Next: a desktop for each bot

The owner decided this after looking inside Grok Bot's VM, which runs a full Xfce desktop. Screens used to show only a browser, in one wide display, and that design had limits the owner did not want. A test on a throwaway VM showed that a desktop for each bot works. `docs/spikes/desktop-per-bot` has its scripts.

### What Grok Bot does

These facts come from running commands in a terminal on its VM. Everything runs as one user, and that user is not isolated by bot.

- Each bot has its own `Xvfb` display at 1920x1200, an Xfce desktop, and an `x11vnc` on loopback with no `-viewonly`. noVNC shows the stream, and a person's input goes through VNC.
- Each display runs real Chrome with its own profile, such as `/home/box/chrome-profile/Fork-3`, with `--password-store=basic`. The name suggests that each profile starts as a copy of a base profile. How a new login reaches other bots is unknown.
- Chrome runs with `--no-sandbox`. Keep the sandbox on here.

### What the test showed

| Test | Result |
|---|---|
| Typing through VNC while switching between 4 displays | No key reached another display and none were lost, in 80 rounds and 2,880 keys |
| Other bots open windows or popups, or take focus, during that typing | No effect |
| Delay | About 112 ms for each key, and about 0.7 s for a key right after a click |
| Ctrl+L and the address bar, and a mouse click on a dropdown option | Both work, and CDP could do neither |
| A second `x11vnc` with `-viewonly` on the same display | Types nothing, so input can stay off until a take-over |
| A copied profile, with `--password-store=basic` and the sandbox on | Stays logged in, with HttpOnly cookies and localStorage |
| A login moved to a running browser with `Storage.getCookies` and `Storage.setCookies` | Works with no restart, including GitHub's HttpOnly session cookie. localStorage does not move this way |
| Start | About 2 s for a desktop, and a few seconds more for its browser |
| Memory | About 250 MB for each idle desktop, and about 650 MB with a real page open |
| Disk | About 1 GB of packages on each VM, and about 94 MB for each copy of a profile |
| Real Chrome compared with Chromium at GitLab's Cloudflare check | Both stopped there, so stay with Chromium |

### What to build

1. Done. Give each active bot a display, an Xfce desktop, and its own Chromium, started on demand and stopped when idle. Keep the sandbox on.
2. Done. Each display has a view-only stream for watching and a separate input stream that exists only during a take-over. `infra/proxmox/verify-desktop.sh` proves this on a real VM.
3. Done. A take-over is the real desktop through noVNC, and the CDP input path and its custom touch controls are gone. The noVNC library has no phone keyboard, so a typing box and a key bar stay. The owner confirmed on a real phone on 2026-11-06 that a take-over works and that the key bar is still needed.
4. Done. A new bot starts from a copy of the base, `/home/browser/profile`, plus the logins that have moved since. When a take-over ends, `computerd` moves the cookies that it changed to every running browser through CDP, and a stopped or new bot gets them when it starts. The base stays as it is, because nothing opens it, so writing it would take a throwaway Chromium for each change and make a second record of the same logins. `infra/proxmox/verify-desktop.sh` proves this on a real VM. localStorage does not move, so a site that keeps its session there needs its own login in each bot.
5. Keep what still fits: the stream relay and its origin and owner checks, the take-over state and the pause in the runner, approvals, the update and repair path, and the `browser_*` tools through CDP.
6. Done. `verify:screen`, `verify:browser`, `verify:takeover`, and the full network check passed again after items 3 and 4, and `verify:takeover` now also checks that another bot gets a login typed in a take-over. The owner reported on 2026-11-06 that the step's check on a real phone passed. That report does not say whether a real site's login moved between bots, so treat that as untested.

### Follow-ups, in this order

1. Let bots use the desktop as well as the user. The owner wants this. A bot needs tools for screenshots, the mouse, and the keyboard, and a model that can read images. These tools must go through approvals, and they count as actions that change something.
2. Let a user reset a computer. A computer is not a permanent store, so a reset deletes its workspaces and browser logins, and the button must say so. It can reuse the removal path and clone a new VM into the same slot.
3. Let a bot ask for a take-over, for example at a login page. Grok Bot calls this a secure handoff.
4. Add automatic review, so most actions need no card. The owner wants this later, in place of asking about everything. What Grok Bot does, according to its documentation, as the owner gave it on 2026-11-06:
   - An automatic check runs before a bot runs a command, uses a connected app, or drives its computer. Most actions go through, and the rest show an approval card with the operation and its inputs.
   - The owner's own messages count as permission. Text from an email or a web page does not.
   - Cards offer Allow once, Always allow, which saves a rule, and Deny, which stops the bot retrying until the owner sends another message.
   - Custom rules can say "ask first" or "allow". Ask first wins a conflict, and built-in safety checks apply even over an allow rule. Turning review off keeps the rules unused.
   - A card from a chat waits for an answer. A card from background work expires after about 30 minutes. A new message or a change to the review settings closes open cards.
   - Commands on a person's own computer have a separate setting. Bots have no such thing yet.

   Always allowing shell would turn approvals off for that bot, so it needs care. Keep the Approve lock on a long command until this replaces it.


## After step 4: the redesign

The web app works but looks basic. The owner wants it redesigned to match Grok Bot's UI, and this comes after step 4 and before step 5. Step 4 settles the take-over screen that the design is built around, and every screen added before the redesign is one more to redo. Steps 6 and 7 bring in other people and new apps, and they should start from the finished design.

### References

- The owner gathers the desktop references, because Mobbin does not appear to cover them.
- Mobile references come from Mobbin.
- References stay out of this repository, because it is public and screenshots can show account details.

### What to build

1. Agree on a direction from the references, before any code.
2. Set the design system, the navigation, and the layout.
3. Rebuild the home page, the bot page, and the screen panel in the new design. Keep the phone typing box and key bar, because noVNC has no phone keyboard.
4. Render markdown in chat, which closes that known gap.

This step adds no features, and the link stays as it is. Step 5 builds the memory UI and the Activity view in the new design, and step 7's apps reuse it.

The owner decided these on 2026-11-06, after trying a prototype:

- Match Grok Bot's layout, flows, and style closely. Colours and proportions come from measuring the references. Keep this project's own name and copy, and draw the bot shapes here instead of tracing Grok Bot's, because this repository is public.
- Bots have 13 shapes and 11 colours, as in Grok Bot's create dialog. Two optional fields on `bots` store them, and a bot without them takes its look from its id.
- One read-only query gives the bot list each bot's activity and last message.
- The backend changes for this step stop at those two things and `createdAt`, a read-only field on each run that `threads.timeline` returns for the chat's time labels.
- Grok Bot's top grid holds its built-in bots. Bots has none, so every bot is a row. Pinning would be a new feature.

This is a proposal, so change it if you find a better answer:

- Add screens that Grok Bot lacks where Bots needs them. Reviews say it has no way to inspect or edit individual memories, for example.

### Progress on the redesign

1. Done. The foundation: the shape and colour fields, `bots.overview`, the design tokens, bot faces, the sidebar and bot page, the info panel, and the new bot and Settings dialogs. The screen panel stayed inline in the chat until its own unit.
2. Done. Chat with markdown: `conversation.ts` turns the timeline into display items, bot output renders as markdown with no raw HTML, no remote images, and only `http`, `https`, and `mailto` links, approvals are question cards, and the composer has its new design. Tested with a scripted fake model at 1280 and 412 wide, in light and dark.
3. Done. The screen is a full-screen view, opened from the chat's header or the info panel and tracked in the URL, so a back gesture leaves it. One reducer in `screenState.ts` decides its states. On a device with a coarse pointer it has the typing box and key bar, and a phone on its side has the stream beside its controls. A bot's row now carries `takeoverUntil`, and a timer in the page ends "You have the screen" at that moment. Docker's `computerd` has no desktop, so this was tested with a fake `RFB` class and with the real noVNC library against a fake VNC server, at 1280 wide, 412 by 860, and 844 by 390. A real stream, real input on a desktop, a real phone, and a real on-screen keyboard are untested until the owner accepts this step.
4. Done. Settings has a left navigation with General and Mistral key on a computer, and one column on a phone. A question card says how many rendered lines of an argument are below its box, counting wrapped lines, and updates as the person scrolls. The sign-in, reconnecting, problem, and not-found notices share one look, a focus ring inside a card or the bot list is no longer clipped, and five bubble colours are darker so white text reaches 4.5:1, which a test now holds. Tested with a scripted fake model at 1280 and 412 wide, in light and dark. A real phone's touch scrolling and hidden scrollbars are untested until the owner accepts this step.
5. Done. `verify:screen` and `verify:takeover` passed on the control VM, a real model and the real desktop worked in the new design, and the owner accepted it on 2026-11-06. A Convex export from just before the first deploy of this design is at `/root/backups/bots-before-redesign-2026-11-06.zip` on that VM. Going back to a commit before this redesign would need that export or a cleanup of stored bot looks, because the older schema has no `shape` or `color`.

## Step 5: a standing assignment, memory, and schedules

Before this step, a bot has only a fixed system prompt. It has no job of its own, and it remembers only what is in its thread.

### What Grok Bot does

The owner asked a Grok Bot about itself on 2026-11-06, and its answers agree with [its documentation](https://docs.x.ai/grok-bot/bots) on memory.

- A bot keeps lasting notes and a dated log. Each bot has its own, across all its chats. A few personal facts, such as a name and a time zone, reach the owner's other bots.
- A bot decides by itself when to save, and it does not ask first. Saying "remember" makes a save certain. Nothing lists the notes, so the owner asks the bot what it remembers.
- A reset keeps memory, and deleting the bot deletes it. Logins and cards belong in the Vault.

The two sources disagree on the rest. The bot described a name, a title, and a free-text description that holds its assignment. The documentation says that a personal bot no longer has a description, that a shared bot does, and that a job is set by telling the bot in chat. It does not say how routines run or whether they are read-only, and it describes no activity view.

Bots differs on purpose in four ways. The owner can read and edit each note. No bot can write a fact that another bot reads, because one injected page could then reach every bot. A save after a computer tool asks first at the default level, so a page cannot plant a note silently. Nothing stores a dated log, because the thread already records the work, and a log would be one more way into every later prompt. Add one if long threads get compaction.

### What to build

1. The standing assignment. Each bot gets a title and an assignment that only its owner writes, and the model reads them on each call.
2. The tool table, with no change in behavior. One required `effect` for each tool replaces `FREE_AT_OUTSIDE_LEVEL`.
3. Memory. A bot saves and forgets its own notes with `memory_save` and `memory_forget`, the owner reads and edits them in the panel, and `users.about` holds what the owner writes about themselves.
4. No freeze and no spin. A hostile page cannot freeze a browser tool, and the runner does not spin on a refused claim. These bugs affect chat bots today.
5. Read-only runs in the orchestrator and Convex, with nothing starting one yet. Such a run can call `read_file`, `browser_navigate`, and `browser_snapshot`, never creates an approval, and cannot write memory.
6. Logged-out browsing in `computerd`, and link addresses in a snapshot.
7. Routines and the step's check. A Convex cron starts each scheduled run once, and the orchestrator rejects a write attempt from that run.
8. The Activity view, which needs no table of its own.

The owner decided these on 2026-11-07:

- Routines are read-only for now.
- A routine may open any website it finds relevant. There is no site list.
- A routine browses logged out, in a browser context with none of the owner's logins.

These are proposals, so change them if you find a better answer:

| Question | Proposal | Why |
|---|---|---|
| A bot's title | Keep it | The owner named it, it is one optional field, and the panel and the chat header show it |
| Facts that all of an owner's bots read | One string, `users.about`, that only the owner writes | A name and a time zone are few facts, and an owner types them once. Shared rows and a Share button are more to build for the same result, and no bot can write what other bots read |
| How a bot's save gets checked | The question card, once a computer tool has run in this run | A hold for review would need a tap on nearly every save, because a thread stays exposed for good. It would also add a status and a review UI. The card already exists and shows the exact text |
| The memory tools | `memory_save` and `memory_forget` | Each card and chat row says one thing. A replace in one `update_memory` tool is not worth a second optional field |
| Where a bot's memory write happens | `runs.append` takes a memory call | The note and its tool result go in one fenced mutation, so a kill leaves both or neither |
| The tool table's shape | One required `effect` for each tool | One field answers every consumer, and three fields could disagree |
| A separate type for calls cleared to reach `link.call` | None | `Link.call` already takes only `ToolInvocation`, so passing it a memory call fails to compile |
| The shape of a schedule, its thread, preemption, and Activity's summary | Decide in the routines PR | These are the contested part, and they do not affect PRs 1 to 3 |

A review on 2026-11-07 settled the thread. A routine's raw pages go in its own thread, and only its final report reaches the chat. In one shared thread, an hourly routine pushed the owner's own messages off the page in about a day, and one month of runs made each run load 121 MB of old pages. The prototype behind those numbers is not in this repository.

### Progress on step 5

1. Done. An owner sets a bot's name, title, and assignment in the info panel, and the title shows under the name there and in the chat header. `callModel` reads them through `bots.promptFor`, so an edit reaches the run's next model call. `VERIFY_SCENARIOS=assignment pnpm verify:agent` checks this with a scripted fake model, and it checks that another user and the service token cannot write them. Tested in a real browser at 1280 and 412 wide, in light and dark. A real model, the control VM, and a real phone are untested. Going back to a commit before this one needs a cleanup of stored titles and assignments, because the older schema has neither field and Convex checks every stored row at a deploy.
2. Done. Each row of `TOOLS` names a required `effect`, one of `reads`, `changesVm`, or `changesOutside`, and `needsApproval` reads it through `toolEffect`. `FREE_AT_OUTSIDE_LEVEL` is gone, and a new tool fails the typecheck until it names an effect. A test written before the change holds every level's answer for every tool, the definitions sent to the model are byte for byte the same, and `VERIFY_SCENARIOS=A,approvals pnpm verify:agent` passes. The approvals scenario stores no key, so it needs `A`. This changes `packages/protocol`, and `deploy.sh` counts that as a change to `computerd`. So deploying this change updates and restarts `computerd` on every VM, though `computerd` behaves the same. The control VM is untested.
3. Done. A bot saves and forgets its own notes with `memory_save` and `memory_forget`, and the owner lists, adds, edits, and deletes them in the info panel. `users.about` holds what the owner writes in Settings, and all of that owner's bots read it. A note and its tool result go in one fenced mutation. At the default level, a memory tool asks once a computer tool has a result in this run. `VERIFY_SCENARIOS=memory pnpm verify:agent` checks this with a scripted fake model and a real backend, orchestrator, and `computerd`, including a SIGKILL placed after the commit and before its reply. The UI was tested with the same fake model in a real browser at 1280 and 412 wide, in light and dark. A real model, the control VM, and a real phone are untested. This changes `packages/protocol`, so deploying it updates and restarts `computerd` on every VM, though `computerd` behaves the same. Going back to a commit before this one needs every `users.about` cleared. A real deploy of the previous commit's schema stopped on a stored `about`, and passed with it cleared and a `memories` row still stored. An older commit's code ignores those rows, and its delete of a bot leaves them behind.
4. Done. A page with `alert()`, `confirm()`, `prompt()`, `onbeforeunload`, or `while(true){}` no longer holds a browser tool, its desktop, or the bot's queue. A dialog is answered as soon as it opens, in any page. A tool call ends at its signal or at a 60 second deadline, a page that stays hung is closed, and the model reads that it froze. The next call works on a new page. `consider` in `runner.ts` no longer asks again at once after `unavailable`, which took `runs.claim` from 555 calls a second to 0.2 under a real fence on a Mac, and a run still starts within 5 seconds of the fence ending. Unit tests cover this with a fake browser, and a real Chromium in a private container reproduced each bug before the fix and passed after it, with the real `createDesktops` and link and a faked systemd. `pnpm verify:agent` passes, in four sets that together run every scenario. `pnpm verify:browser` and `infra/proxmox/verify-desktop.sh` need a VM and have not run on this change, so real desktops under systemd, and a real take-over, are untested. This changes `computerd`, so deploying it restarts `computerd` on every VM.

## After step 3: deploy from `main`

Add a systemd timer on the control VM. The server pulls, so GitHub holds no Tailscale key and no SSH key. The timer does these things:

1. Check `origin/main` every few minutes for a new commit.
2. Continue only if CI passed on that commit.
3. Run a Convex export.
4. Run `deploy.sh main`.

## Known gaps

These are open on purpose. Fix each one when the work reaches it.

- Unsaved text in the panel's profile section survives closing the panel, and it goes on a reload or a move to another bot. It stays in that page only, so a second tab can save over the same field.
- The profile's fields, About you, and a note's box are read-only while a save is in flight, so an edit cannot be lost to the save's end. On a lost connection they stay read-only until the save finishes, with the text still on screen.
- On a computer the info panel takes no history entry, and on a phone closing it goes back in history. So a window narrowed below 760 wide with the panel open leaves the bot when the panel closes.
- A question card locks Approve until the person has reached the end of every argument, so a very long command takes a long scroll. Automatic review, below, is the later answer.
- A focus ring takes the bot's colour, as the prototype does. On a light page, amber, green, teal, and grey rings fall below 3:1, measured at 2.25, 2.30, 2.45, and 2.92.
- A question card shows an argument's text as it is, so Unicode bidirectional controls may change how a command reads. Nobody has tested this.
- A markdown link's text can differ from where it goes, and a phone has no hover to show the address. An image shows its URL, and a link does not.
- A stopped run loses the words that had streamed so far, because the timeline returns a stream only for an active run.
- The bot list strips markdown from a last message with a few patterns, on text already cut to 140 characters, so some marks can still show.
- A run's failure reason for a missing or rejected Mistral key still says "the home page", but the key is now in Settings. `apps/orchestrator/src/runner.ts` and `apps/orchestrator/src/mistral.ts` hold that text.
- A bot's row compares a take-over's end with the device's clock, so a device with a wrong clock shows "You have the screen" for too long or too short a time. The orchestrator decides what the bot does with its own clock.
- On a phone on its side with the keyboard open, the controls do not all fit. They scroll beside the stream, so the second row of keys and the Give back button can start out of sight. This was simulated, not seen on a phone.
- A tablet with a real keyboard still gets the typing box and key bar, because `pointer: coarse` says nothing about a keyboard.
- A reload during a take-over does not give the screen back, so the bot waits for up to 15 minutes, and the view that comes back says "Watching". Taking control and giving back ends it.
- Long threads have no compaction, so a very long thread will eventually exceed what the model accepts.
- `touchedComputer` covers one run, and the thread replays on every model call. So an injection from an earlier run that is still in replayed history passes the check, and the first save of a later run has no card.
- At the Shell and Nothing levels, a save shows no card, so a page can plant a note there. The chat row and the panel still show it.
- A forget's card shows only an id, so the owner approves it without seeing the text unless they open Memory. The row's output shows the text afterward.
- `looksLikeSecret` is best effort. "My password is hunter2" passes. It also refuses some things that are not secrets, such as a git hash, a Convex id, or a hyphenated phrase of 32 or more characters, and each costs the bot one retry. A refused call's arguments stay in `runEvents` and in later model calls, until the bot is deleted.
- A bot's forget during an owner's edit removes the row, with its edit box and the typed text. A draft in the add box goes when the panel closes.
- A chat row calls a refused save "Saved a note" with "failed" beside it, as it does for any tool that failed. The expanded row says why.
- The prompt dates a note in UTC, and the panel dates it in the device's time zone, so the two can differ by a day.
- Downloads in a chat run are not blocked, so a page can put a file on a bot's computer. Step 5's logged-out browsing blocks them only in a routine.
- A page in a chat run can log the bot into another account, because a chat bot browses logged in. A later take-over then moves that session to the owner's other bots.
- A dialog gets no word to the model. A site whose button asks `confirm()` gets a refusal, so the click looks as if it did nothing.
- A page that keeps its main thread busy for 5 seconds when a stop arrives counts as frozen, so a slow page can close at a stop. The model reads this, and the bot opens the address again.
- A same-site opener of a frozen popup stays frozen behind the new page, and it uses a CPU core until its desktop stops. A bot has no tool to go back to it.
- A dialog that opened while no socket was attached, as during a `computerd` restart, costs the next call its 60 seconds before the page closes.
- A real site that takes more than about 30 seconds to start answering can now reach the 60 second deadline during its load. That call returns `timeout` and stops the load, where it used to return a snapshot after up to 2 minutes.
- Approvals limit what a bot does through its tools, not what runs after a tool. Once the owner approves one shell command, that command can start a program that uses the network or the browser's CDP port with no further approval. So a prompt-injected bot can still send out anything in its workspace.
- At the default level, opening a page runs without asking, and a URL can carry data out. Writing a file also runs without asking, because it stays in the VM.
- An unanswered approval expires after 24 hours as a refusal. Until then, the run stays active, which holds back `computerd` updates on that VM.
- A tool that calls `setsid` can survive a cancel or a timeout.
- A bot with `sudo` can delete the journal, and the wiped call then runs again. Deleting the `computerd` journal volume has the same effect. Step 8 removes passwordless `sudo`.
- A `sudo` child and a `setsid` child both outlive a cancel or a timeout, because `computerd` kills the process group as `agent`.
- A bot can read its VM's link token through `sudo`, and it can then forge results for its own owner's runs. It cannot reach another owner's runs.
- One unreadable journal entry, such as a broken symlink, stops `computerd` at startup until someone removes it. `prune` also has no guard for a file that vanishes mid-scan.
- Meta files in the journal never expire, so the journal grows slowly. Pruning 200,000 of them took 158 ms.
- An error body cut at 300 characters can split an emoji. Convex then rejects the failure reason, so the run makes 5 model calls before it stops.
- Redaction matches only the whole, exact key. An upstream that echoes part of a key could put that part in a failure reason.
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
- A check that fails or times out before its end leaves its `verify-*` bots in the user's list. The bot page deletes them.
- Deleting a bot does not end a background process that the bot left running, and a process can keep a deleted file open. A computer reset will end them.
- A screen that opens in the instant before a delete can bring back an empty profile for that bot, and nothing removes it.
- A deleted bot's tool results stay in the VM's `computerd` journal for up to 7 days, where another bot with `sudo` can read them.
- A bot with root can make its own delete hang, and the reconcile loop then waits 2 minutes on that VM on each pass, which delays every other computer. It needs a fix before step 6 brings other users.
- A desktop that a delete stopped still counts as taken for up to an hour. If all 8 slots are claimed, the next bot can evict a live idle bot instead of that empty slot.
- `forget-bots.sh` checks a slot's holder and then stops it, with no lock against `computerd`. If all 8 slots are claimed and another bot takes the deleted bot's slot in those few milliseconds, that bot's desktop stops. Its tool call fails, and its next use starts the desktop again.
- A purge step that fails with an error Convex does not retry leaves that bot's history in Convex, and nothing restarts it. A deploy of an older branch during a purge is the one known trigger.
- A deleted bot's files stay in the Docker volume on a Mac, where no reconcile loop runs.
- Step 1b did not test a live update on a phone, or a bot created by a second real account. `pnpm verify:agent` covers isolation between users on a Mac.
- `pnpm verify:agent` relies on Docker Desktop's `host.docker.internal`, so it does not run on Linux or in CI as written.
- CI is not a required check on `main`. That is a repository setting.
- Any bot can reach CDP on loopback, so it can drive another bot's browser on the same computer, and read the logins in that browser. It can also reach an input stream for the 15 seconds before its viewer connects, which takes that take-over's place. A bot with `sudo` can also read the jar of moved logins, which `computerd` keeps in plain text. Those bots have one owner, so this crosses no user's boundary.
- A browser snapshot hides password fields, but it shows the first 300 characters of a page's URL. A site that puts a secret in its URL shows that secret to the bot and the model.
- A bot's mouse click cannot choose an option in a dropdown through CDP. Its keyboard can. A person's mouse click can, through the desktop.
- Only a take-over moves a login. A login that a bot makes by itself stays in that bot's profile. A login from before desktops is in the base, so every new bot starts with it.
- Chromium writes a new cookie to disk about 30 seconds after it changes, and SIGTERM does not make it write sooner. A test lost a cookie set 20 seconds before a stop and kept one set 35 seconds before. A login from a take-over survives this once the owner gives back, because the jar holds it and the next start applies it again. A cookie that a bot's own page set in those 30 seconds is still lost, and so is what the owner typed if the browser dies during the take-over.
- A site that rotates one token across several browsers can log them out, because each browser that uses the moved token can make the others' copy stale.
- A browser that is down when a take-over opens or ends moves no login. The login stays in that bot's profile, so the owner has to log in again in a later take-over to move it.
- A cookie that another bot's push put into a bot during its own take-over, and that the owner then logs out of there, does not move as a logout, because the baseline never held it.
- localStorage logins do not move. A new copy of the base would not bring them either, because the base holds only what it held before desktops.
- An owner's login replaces a bot's own account on that site, because a moved cookie has the same name, host, and path.
- A cookie moved in the middle of a task can disturb a form that a bot has open, for example by ending the session that the form belongs to.
- A session cookie in the jar comes back once at each start of a browser until the owner logs out in a take-over, even if the site would have ended that session by now.
- A pending approval has no signal that reaches a desktop. After an hour with no tool, the desktop stops, and a ninth bot can take its slot sooner. The approved click then gets the stale ref error, so it clicks nothing wrong, and the bot starts again on a blank page.
- A bot loses its page on every browser restart and idle stop. Its next snapshot says `about:blank`.
- A ninth bot gets an error when all 8 screens have a tool running or a person watching. This is on purpose, so a screen never stops under a viewer.
- A viewer whose phone loses its network holds its desktop until TCP gives up, because a viewer's socket has no ping.
- A Chromium that cannot start, for example with a damaged profile, restarts every 2 seconds until the idle stop. Each `browser_*` call waits 45 seconds for it and then answers that there is no running browser.
- A bot can take a slot's display number or port before a slot needs it. That display then fails to start, and its bots on that computer report no running browser.
- A new desktop has a fixed list of fonts, so some scripts show as empty boxes. example.com's Arabic and Hebrew text did on a real VM.
- A tool that is running when the owner takes over keeps running. The bot waits only before its next tool. A cookie that it changes during the take-over moves as if the owner had changed it. So does one that a shell tool changes through CDP after the take-over ends, because only browser tools wait for the cookies to be read.
- A closed tab or a sleeping phone leaves the bot waiting for up to 15 minutes, because only the renewal stopping can show that the owner left.
- A screen on a phone is small, 396 by 248 pixels at 412 wide. During a take-over, a pinch zooms the page on the desktop and not the owner's view of the desktop, so the view and the window's bars stay small.
- A phone has no Ctrl key. It reaches the address bar and the tabs by tapping them.
- A browser keeps some shortcuts for itself, such as Ctrl+W, so a real keyboard cannot send those to the desktop. Nobody has measured which ones.
- During one take-over, x11vnc can type about 17 different characters that the display's US keyboard lacks, and it drops the next one with no error. The typing box refuses the 17th and says so. A real keyboard on the screen has no such check. A new take-over frees the room.
- A person who opens a tab makes it the newest page, so the bot follows it. A person who only switches tabs does not change the bot's page, so the bot can act on a tab the person left. After a `computerd` restart, the order of tabs with no opener comes from Chromium, so the bot can land on another tab.
- If a VM's connection to the orchestrator is cut with no close, as in a network outage, an input stream stays open until a new take-over replaces it. Nothing can reach it except on the VM's loopback.
- A kill of the input stream's `x11vnc` with a key held leaves that key down until the next viewer leaves. A viewer that only leaves or is replaced releases its keys, unless x11vnc hangs on its SIGTERM and the 3-second stop limit kills it.
- Streams carry no limit on bandwidth, and a bot that reads its own link token can send its owner false video.
- A site can block the browser. GitLab stopped it at a Cloudflare check during testing.
