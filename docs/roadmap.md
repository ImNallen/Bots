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
| 5 | Done, with gaps listed below | The standing assignment, now the description, memory, schedules, and the Activity view | The orchestrator rejects a write attempt from a scheduled run |
| 6 | Deferred | Friend invites | A friend goes from invite to working bot without help |
| 7 | | Tauri and Expo apps, and push | A user approves an action from a push notification |
| 8 | | OAuth connectors, the independent reviewer, and the Vault | Bots use saved logins without seeing the passwords, and bots no longer have passwordless `sudo` |

Step 3 isolates bots from the LAN. Friends join through the invites in step 6, and until then an operator declares each computer by hand.

The owner deferred step 6 on 2026-11-08, because nobody is waiting for an invite yet. Until then, work continues on [the desktop follow-ups](#follow-ups-in-this-order), starting with letting bots use the desktop. Step 6's gaps below still apply when it starts.

Backups are deferred, and a computer is not a permanent store. A user will be able to reset a computer, which deletes its workspaces and browser logins. Add off-server copies of Convex exports and the master key before anyone depends on this system. The owner confirmed on 2026-11-08 that nothing depends on it yet.

## Where things run

- The Proxmox host is `192.168.1.32`. Log in as `root` over SSH.
- The control VM is VM 110, `bots-control`, at `192.168.1.161`. Log in as `bots` over SSH, which has passwordless `sudo`. The app is in `/opt/bots`.
- Run `sudo tailscale serve status` on the control VM to find its `https://bots-control.<tailnet>.ts.net` address.
- The service runs as `bots-orchestrator`, which has no `sudo`. Keep it separate from the `bots` login: a process can take over another process of its own user, and `bots` has `sudo`.
- The control VM deploys a branch until someone deploys another. It runs `main` now. To update it, run [the deploy script](../infra/control-vm/README.md).
- User VMs use the `botsvms` network, `10.77.0.0/24`, with the gateway at `10.77.0.1`. The control VM is `10.78.0.2` on `botsctl`, `10.78.0.0/30`. The link listens only on `10.78.0.2:8788`.
- VM 9000, `bots-user-template`, is the template for user VMs. Its description names the commit of its `computerd`. A clone updates itself to the current commit, so the template can lag behind.
- VM 201, `bots-user-201`, at `10.77.0.21`, is the owner's computer. The orchestrator's reconcile loop owns it, and it is in slot 1. Reach it with `qm guest exec` on the host, because it accepts no inbound connections and has no SSH keys.
- VM 120, `huddle`, is on the same host and is not part of this system. Its VMID is outside the reserved 201 through 400 range, so reconciliation never targets it.
- Your Mac has its own Convex data and its own Mistral key, separate from the control VM.

## Decisions for step 3

The user chose these:

- Each user gets one VM, and all of that user's bots share it.
- The owner's VM has 32 GB of RAM. Friends start at 8 GB and get more only if a measurement shows they need it.
- VMs use fixed memory, with no ballooning and no KSM.
- The server has 16 cores with 32 threads, a single 2 TB disk, and 91 GiB of usable RAM. Storage is `local-lvm`, which is LVM-thin.

These are proposals, so change them if you find a better answer:

- Give the owner's VM 12 vCPUs and 500 GB. Give each friend 6 vCPUs and 200 GB.
- Give the orchestrator a Proxmox API token scoped to the bots pool. Resolve the out-of-pool recovery permission prerequisite before rolling out reset.
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

   Done and deployed. VM 201's `computerd` runs it at `5a8313e` since 2026-11-08, and the control VM runs `e42b9bf`, which adds the fix below. A bot has `desktop_look`, `desktop_click`, `desktop_type`, `desktop_key`, and `desktop_scroll`, and [How a bot uses its desktop](architecture.md#how-a-bot-uses-its-desktop) explains them. A look is a picture with numbered marks from each app's accessibility tree. Input asks at Outside and at Shell, acts only on the element that the card names, and a routine gets none of the tools. `infra/proxmox/verify-desktop.sh` passed on the throwaway VM 950 on 2026-11-08, with its new checks for looks, clicks, typing in a field and the address bar, keys, scrolling, a stale aim, a take-over, a file chooser, and a terminal opened from the panel. `verify:agent` passed in full on the same code, with new scenarios for a run's screen and for desktop calls against Docker, which has no desktop. `pnpm verify:desktop-tools` checks a real model's use of a real desktop. Against the deploy, a real model looked, opened Chromium's menu by its mark, read its first three items, and closed it with Escape, and no picture reached the stored history. At Outside, the card named the click and had its picture, and the denial was recorded. But the bot then looked again and asked for the same click, because a denied desktop result carried the hint to look again for new marks. A denied, invalid, or rejected desktop result now carries no such hint, and the check now fails if the bot asks twice. With that fix deployed at `e42b9bf`, the check passed in full on 2026-11-09, and the bot asked once. `verify:screen`, `verify:browser`, and `verify:takeover` passed against `5a8313e`.
2. Let bots search and read the web without the screen. The owner wants each bot to use its visible desktop only when a task needs it, such as a logged-in site, a form, a native dialog, or another app, and to read and search the web through a quiet text path otherwise.

   Done and deployed. The control VM runs `633f0d6` since 2026-11-09, and VM 201's `computerd` moved to it within a minute of the deploy. A bot has `web_search` and `web_fetch`, which [Reading the web without the screen](architecture.md#reading-the-web-without-the-screen) explains. Neither asks at Outside, a routine gets both, and both kinds of run are told to use them before the browser and the desktop. `browser_navigate` now says that it opens the bot's screen. `pnpm verify:web` checks them. Its network checks passed on 2026-11-09 inside the Docker `computerd` that `pnpm bootstrap` built from the branch. `web_search` found 7 results, all about the query, for each of three queries in a row, `web_fetch` read the Wikipedia article on SQLite in 4 parts, it refused CDP on `127.0.0.1`, the link's address, and `localtest.me` before it connected, and a certificate for another name failed while `example.com` read. The run two minutes before that got Bing's "There are no results" page for one of the three queries, as [Why it no longer reads one results page](architecture.md#why-it-no-longer-reads-one-results-page) describes. `verify:agent` passed in full on the same code. Against the deploy, the model checks of `verify:web` passed, with no tool named in either request. Asked what a page says, `mistral-large-4` called `web_fetch` once and opened nothing on its screen. Asked for two sources, it called `web_search` four times and `web_fetch` five times, again with nothing on its screen. Bing was returning results about other things by then, and the bot said so and read well-known pages by their addresses. On VM 201 itself, the network checks refused CDP, the link's address, and `localtest.me`, read the Wikipedia article in 4 parts, and failed a certificate for another name, but two of the three searches got results about other things, as [Why it no longer reads one results page](architecture.md#why-it-no-longer-reads-one-results-page) describes. Its known gaps are under [Known gaps](#known-gaps).

   On 2026-11-09 search moved to a self-hosted SearXNG, deployed at `39cd6fb` the same day, and VM 201's `computerd` moved to it within a minute. Bing had started answering the home IP address with results about other things, and `web_search` reported them as ok. `web_search` now runs in the orchestrator and asks SearXNG in the `bots-control` project, which [How it searches](architecture.md#how-it-searches) explains. The Bing code in `computerd` is gone, and `web_fetch` is unchanged. A search's result counts as untrusted text, so a save after it asks at Outside. On the Mac, `pnpm bootstrap` started SearXNG, which answered JSON on `127.0.0.1:8789` and refused connections on the LAN and tailnet addresses. `pnpm verify:web` passed there. Each of three queries in a row got 10 results through `search.ts`, all 10 sharing a word with the query, and the `web_fetch` checks passed inside the Docker `computerd`. `verify:agent` passed in full on the same code, with a new scenario in which a search goes to a fake SearXNG, leaves nothing in `computerd`'s journal, and makes the save after it ask. On the control VM after the deploy, SearXNG listened only on `127.0.0.1:8789`, and the Mac could not connect to port 8789 on the control VM's LAN address, tailnet address, or tailnet name. `verify:web --search` passed there, with 10 results, all sharing a word with the query, for each of three queries. The model checks of `verify:web` passed against the deploy. Asked what a page says, the bot called `web_fetch` once. Asked for two sources, it called `web_search` once and `web_fetch` three times. Neither run opened anything on the screen.
3. Let a user reset a computer. A computer is not a permanent store, so a reset deletes its workspaces and browser logins, and the button must say so.

   Implemented locally, awaiting independent review and a disposable Proxmox VM check. Settings confirms that all bots share the computer, active work stops, and all computer files, workspaces, and browser logins disappear. The computer row, VM slot, sizing, bots, chats, memories, and routine definitions stay. A generation in the clone name lets reconciliation distinguish the old disk from its replacement after a crash. Reset remains pending through retrying errors until the new generation authenticates and connects and durable cleanup completes. Runs, approvals, take-overs, and completion-time missed routines are cleaned in bounded transactions. New work and take-overs are blocked, and due routine occurrences are skipped. Local Docker computers show reset as unavailable. `pnpm verify:reset` checks the real local backend, and `pnpm verify:reset-ui` checks desktop and phone Chromium in light and dark. The unit suite kills fake Proxmox reconciliation at every effect boundary and checks link generation and stream cleanup. These checks do not establish that a real VM reset passed. The existing pool-only token cannot recover an out-of-pool clone. Static reserved-ID ACLs are removed by Proxmox destroy and cannot alone fix this. Host-crash recovery remains the existing manual repair path, tracked in [issue 54](https://github.com/ImNallen/Bots/issues/54). Real-host reset still needs verification before rollout. No existing VM was reset or deployed to.
4. Let a bot ask for a take-over, for example at a login page. Grok Bot calls this a secure handoff.
5. Add automatic review, so most actions need no card. The owner wants this later, in place of asking about everything. What Grok Bot does, according to its documentation, as the owner gave it on 2026-11-06:
   - An automatic check runs before a bot runs a command, uses a connected app, or drives its computer. Most actions go through, and the rest show an approval card with the operation and its inputs.
   - The owner's own messages count as permission. Text from an email or a web page does not.
   - Cards offer Allow once, Always allow, which saves a rule, and Deny, which stops the bot retrying until the owner sends another message.
   - Custom rules can say "ask first" or "allow". Ask first wins a conflict, and built-in safety checks apply even over an allow rule. Turning review off keeps the rules unused.
   - A card from a chat waits for an answer. A card from background work expires after about 30 minutes. A new message or a change to the review settings closes open cards.
   - Commands on a person's own computer have a separate setting. Bots have no such thing yet.

   Always allowing shell would turn approvals off for that bot, so it needs care. Keep the Approve lock on a long command until this replaces it.

   A model reviewer was built and measured on 277 held-out cases before any rule was written. The best Mistral model let about one in eight non-critical dangerous actions through, and it answered the same case both ways, so on 2026-11-09 the owner chose fixed, deterministic rules instead. A new Automatic level, now the default for a bot with no level of its own, runs reads and routine steps and asks only before actions that commit something or run something unknown.

   PR 1 of 4 is done in code. It adds the Automatic level and the rules for shell and the desktop in `apps/orchestrator/src/rules.ts`, a pure table with no model call. The rules ask before the research set's built-in dangers, allow a read-only shell command parsed by a conservative tokenizer, allow a named desktop click, scroll, navigation key, or non-submitting type outside a terminal, and keep a page action and a file write where Outside left them. A test drives `decideByRules` from the 277 ported cases, holds a safety bar that no dangerous case runs at Automatic when Outside would have asked, and reports the card rate on the safe cases. `VERIFY_SCENARIOS=A,approvals pnpm verify:agent` checks it end to end. The later PRs add browser targets named from the snapshot, structured Always allow, and a grant for the rest of a task.


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

This step adds no features, and the link stays as it is. Step 7's apps reuse the design. The Figma revision below replaces the earlier plan to expose memory and Activity.

The owner decided these on 2026-11-06, after trying a prototype:

- Match Grok Bot's layout, flows, and style closely. Colours and proportions come from measuring the references. Keep this project's own name and copy, and draw the bot shapes here instead of tracing Grok Bot's, because this repository is public.
- Bots have 13 shapes and 11 colours, as in Grok Bot's create dialog. Two optional fields on `bots` store them, and a bot without them takes its look from its id.
- One read-only query gives the bot list each bot's activity and last message.
- The backend changes for this step stop at those two things and `createdAt`, a read-only field on each run that `threads.timeline` returns for the chat's time labels.
- Grok Bot's top grid holds its built-in bots. Bots has none, so every bot is a row. Pinning would be a new feature.

This is a proposal, so change it if you find a better answer:

- Add screens that Grok Bot lacks where Bots needs them. The owner changed this for memory on 2026-11-07, as [Later: hide memory's details](#later-hide-memorys-details) says.

### Progress on the redesign

1. Done. The foundation: the shape and colour fields, `bots.overview`, the design tokens, bot faces, the sidebar and bot page, the info panel, and the new bot and Settings dialogs. The screen panel stayed inline in the chat until its own unit.
2. Done. Chat with markdown: `conversation.ts` turns the timeline into display items, bot output renders as markdown with no raw HTML, no remote images, and only `http`, `https`, and `mailto` links, approvals are question cards, and the composer has its new design. Tested with a scripted fake model at 1280 and 412 wide, in light and dark.
3. Done. The screen is a full-screen view, opened from the chat's header or the info panel and tracked in the URL, so a back gesture leaves it. One reducer in `screenState.ts` decides its states. On a device with a coarse pointer it has the typing box and key bar, and a phone on its side has the stream beside its controls. A bot's row now carries `takeoverUntil`, and a timer in the page ends "You have the screen" at that moment. Docker's `computerd` has no desktop, so this was tested with a fake `RFB` class and with the real noVNC library against a fake VNC server, at 1280 wide, 412 by 860, and 844 by 390. A real stream, real input on a desktop, a real phone, and a real on-screen keyboard are untested until the owner accepts this step.
4. Done. Settings has a left navigation with General and Mistral key on a computer, and one column on a phone. A question card says how many rendered lines of an argument are below its box, counting wrapped lines, and updates as the person scrolls. The sign-in, reconnecting, problem, and not-found notices share one look, a focus ring inside a card or the bot list is no longer clipped, and five bubble colours are darker so white text reaches 4.5:1, which a test now holds. Tested with a scripted fake model at 1280 and 412 wide, in light and dark. A real phone's touch scrolling and hidden scrollbars are untested until the owner accepts this step.
5. Done. `verify:screen` and `verify:takeover` passed on the control VM, a real model and the real desktop worked in the new design, and the owner accepted it on 2026-11-06. A Convex export from just before the first deploy of this design is at `/root/backups/bots-before-redesign-2026-11-06.zip` on that VM. Going back to a commit before this redesign would need that export or a cleanup of stored bot looks, because the older schema has no `shape` or `color`.

### Figma revision on 2026-11-07

Implemented locally from the approved Figma screens. The app uses neutral light and dark themes, round bot heads with pill eyes, and coloured bots. The bot list has one add button and account access. The centred bot pill opens a docked details sidebar on a computer and a separate page on a phone. Chat resizes beside the sidebar. Routines have their own view, and Computer keeps the existing noVNC stream and takeover controls.

Memory, description, and Activity are absent from the navigation and bot details. Their stored data and bot tools remain. Profile edits use `bots.setIdentity`, which changes only name and title, so an edit cannot overwrite a description that the bot updated while the form was open. Existing stored colours remain supported. New bots start sage green, with blue and peach choices.

On 2026-11-08, routines moved into the right details sidebar, leaving chat and its composer mounted and visible on desktop. The compact list shows schedules and pause switches; selecting a routine opens its status, run history, test and delete controls in the same panel. Creation and changes still go through chat because there is no routine-update API. Mobile uses a right drawer with the conversation behind it inert. The account control sits 12 px above the sidebar bottom and uses violet initials. The desktop update button is deferred. Typecheck, unit tests, build, and the local Chromium design check cover the change, including pause/resume, deletion, drafts, direct routine links, themes and phone navigation.

The floating Computer view was implemented locally on 2026-11-08. On a desktop, the header's Computer button opens a movable window over chat. Its title bar and edges support dragging, with arrow-key access; size and position persist in browser storage. The window preserves 16:10 proportions and stays inside the chat, at least 24 px above the composer. It minimizes and restores without dropping the watch stream, and the same viewer switches to and from full screen. Minimizing or closing during takeover gives control back. Phones, coarse-pointer devices and chat columns too small for the compact window use the existing full-screen view and touch controls. Opening and closing details or routines preserves the viewer.

`pnpm verify:floating-computer` checks this with the real noVNC client, a local RFB fixture and real local-backend takeover mutations. It covers display and input, pointer and keyboard movement/resizing, storage, stream continuity, draft preservation, takeover release, retry, narrow layouts, phone rotation and both themes. The full typecheck, tests and build also pass. A real VM desktop and a physical phone have not been rechecked for this change.

Settings has General and Mistral key sections. General contains the account, shared information, time zone, and System, Light, and Dark appearance choices. Appearance persists in the browser. The mockup's code control remains omitted. Attachment and microphone controls now work as described below.

The sidebar follows the approved highlight revision. It has no wordmark or section label, and the add button sits higher. Each user can drag zero to four bots into highlights, reorder them, or drag them back into the list. One or two highlights are centred when the width permits them to share a row. The 84-pixel rounded square buttons contain 44-pixel bot heads and names. With no highlights, the area takes no space. A drop target appears during dragging. `users.highlightedBotIds` saves the order across sessions and devices, and deleting a bot removes its highlight. `bots.setHighlight` checks ownership, positions, and the four-bot limit. Going back to a schema from before this revision requires clearing `highlightedBotIds` from users.

The desktop sidebar resizes from its right border between 88 and 400 pixels, with no visible handle. It starts at 264 pixels and saves the width in the browser as `bots.sidebarWidth`. The border accepts arrow keys, Home, and End. Double-clicking resets the width. Highlights wrap as the sidebar narrows. At widths below 148 pixels, the sidebar becomes a compact rail with names available as tooltips. The phone list fills the screen, uses two columns for highlights, and has no resize border.

Routines show the newest run across the bot's current routines, using the existing recent-run data. The summary names the routine and shows its actual status and start time. It opens Chat and preserves a docked details panel. Bots with no routine runs have no summary. The delete-bot footer includes the bot's name and keeps the existing confirmation before deletion.

`pnpm verify:highlights` uses a separate local account and the real backend. It checks mouse dragging, touch dragging, touch scrolling, keyboard movement, reordering, centring, square buttons with names inside, long names, reloads, a second browser session, the four-bot limit, ownership, invalid positions, and deletion. It also checks border and keyboard resizing, saved and invalid widths, responsive grids, and dragging in the compact rail. `pnpm verify:design` seeds routine records through the existing internal check functions to verify the last-run summary and its navigation. Touch was checked through Chromium's touch emulation. A physical phone is untested.

`pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm verify:auth` passed locally. `pnpm verify:design` checks the live app at 1440, 1024, and 390 pixels wide. It covers sidebar geometry, hidden description preservation, draft preservation, colours, Settings, system and saved themes, mobile navigation, Computer's disconnected state, and bot creation and deletion. Screenshots were reviewed in light and dark, and an existing conversation was reviewed on a computer and at phone width. The control VM runs `e42b9bf`, which includes this revision. On 2026-11-08, `verify:screen`, `verify:takeover`, and `verify:browser` passed there against VM 201. Those checks speak to the stream and take-over directly, not through the web app, so the floating Computer view on a real desktop and the phone keyboard are still untested. The owner has not accepted this revision on a real phone.

### Chat attachments on 2026-11-07

Implemented locally. The composer accepts up to four PNG, JPEG, WebP, PDF, or UTF-8 text/code files through the picker, drag-and-drop, or pasted images. It shows previews, upload status, retry, and removal. Sending waits for every selected file to be ready, and a file-only message is valid. Sent files remain in the conversation after reload and have authenticated previews and downloads. Images and PDFs are limited to 8 MiB each, and text/code files to 256 KiB.

The orchestrator receives uploads through the existing authenticated app listener and stores them in Convex. It checks file names, sizes, binary signatures, and UTF-8 text before storing bytes. An `attachments` row binds each file to its owner and bot. `threads.send` checks those bindings and attaches the server's metadata atomically with the queued run. Unsent uploads expire after 24 hours, and deleting a bot removes its files. A repeated completion preserves the file. A failed completion or a completion after bot deletion removes the new stored bytes.

The runner sends text contents and base64 image/document chunks to the model, following the [Mistral image](https://docs.mistral.ai/inference/conversations/vision) and [document](https://docs.mistral.ai/studio/document-processing/document_qna) input formats. A request includes at most the eight newest files within 32 MiB. Older attachments have an explicit omission note, and an unavailable older file does not prevent a new message. Files are not copied to the bot's computer.

`pnpm verify:attachments` exercises real Convex storage, a separate orchestrator and account, and the browser with a fake Mistral endpoint. It checks file contents in model requests, file-only and four-file messages, duplicate and fifth-file rejection, ownership, authentication, reloads, retries, removal, drag-and-drop, paste, phone sizing, expiration, repeated completion, and storage cleanup after failed completion and bot deletion. Real Mistral document interpretation and a physical phone are untested. Older text-only messages remain valid because the event's attachment field is optional. Rolling back to a backend from before this revision requires removing attachment fields from saved user-message events and deleting the corresponding stored files and rows.

### Voice dictation on 2026-11-07

Implemented locally. The composer uses the approved Figma microphone icon. A tap asks for microphone permission and starts recording. The rounded composer shows a live waveform, elapsed time, and Done and Cancel controls. Done finishes capture and appends the transcript to the current draft, with an Added to draft confirmation. The user reviews and edits the text before sending. Dictation preserves text edits made during transcription and keeps selected attachments. Recording and transcription block sending until they finish or are cancelled. Failed requests retain the recording in browser memory for retry or discard.

Recording stops after two minutes. Cancelling, leaving the bot, opening the full-screen Computer view, opening phone details or routines, and opening Settings stop microphone capture. On desktop, the routines sidebar and floating Computer view leave the composer and microphone available. Hiding the page stops capture as well. A permission grant or transcription response arriving after cancellation cannot restart capture or alter another draft. WebM and Ogg recordings go directly to transcription. Browsers that record MP4 use the browser's audio decoder to create mono, 16 kHz WAV first.

The authenticated `POST /api/voice/:botId` route checks ownership and uses that owner's encrypted Mistral key. It accepts at most 8 MiB and calls the [Mistral file transcription API](https://docs.mistral.ai/studio/audio/speech-to-text/transcribe-files) with `voxtral-mini-transcribe-3-0`, configurable through `MISTRAL_TRANSCRIPTION_MODEL`. It stores no audio in Bots and creates no chat run. Only the reviewed text is saved when the user sends the message. The feature changes no schema, protocol, or `computerd` code.

`pnpm verify:voice` checks a real browser recorder, the authenticated route, encrypted key lookup, and multipart model request through a separate local account. The browser microphone and provider transcript are fixtures. It covers cancellation, retries, empty speech, permission failures and late grants, microphone cleanup, navigation, phone sizing, the two-minute limit, WAV conversion, owner checks, body limits, and provider-error redaction.

The waveform uses logarithmic scaling so quiet microphone input remains visible, settles during silence, and respects reduced-motion preferences. Browser checks cover both Chromium and Firefox, including quiet audio, silence, and audio-context cleanup.

On 2026-11-07, the user tested voice input with a real microphone and reported that it works well. After the composer redesign, the user reported a flat waveform and no speech detected in Zen Browser, then confirmed that it worked after the browser's microphone permission popup appeared. The user identified the intended microphone as Elgato Wave:3 MK.2. The unfinished app input selector was removed.

## Step 5: a standing assignment, memory, and schedules

The owner renamed the field and changed its meaning on 2026-11-07. `bots.assignment` is now `bots.description`, one general text about the bot that the owner and the bot both write, as [The description](#the-description) says. This section uses the old name where it records what happened.

Before this step, a bot has only a fixed system prompt. It has no job of its own, and it remembers only what is in its thread.

### What Grok Bot does

The owner asked a Grok Bot about itself on 2026-11-06, and its answers agree with [its documentation](https://docs.x.ai/grok-bot/bots) on memory.

- A bot keeps lasting notes and a dated log. Each bot has its own, across all its chats. A few personal facts, such as a name and a time zone, reach the owner's other bots.
- A bot decides by itself when to save, and it does not ask first. Saying "remember" makes a save certain. Nothing lists the notes, so the owner asks the bot what it remembers.
- A reset keeps memory, and deleting the bot deletes it. Logins and cards belong in the Vault.

The two sources disagree on the rest. The bot described a name, a title, and a free-text description that holds its assignment. The documentation says that a personal bot no longer has a description, that a shared bot does, and that a job is set by telling the bot in chat. It does not say how routines run or whether they are read-only, and it describes no activity view.

Bots differs on purpose in five ways. The owner can read and edit each note. No bot can write a fact that another bot reads, because one injected page could then reach every bot. A save after a computer tool asks first at the default level, so a page cannot plant a note silently. Nothing stores a dated log, because the thread already records the work, and a log would be one more way into every later prompt. Add one if long threads get compaction. The documentation also says that a personal bot has no description, and Bots keeps one, which the owner and the bot both write.

### What to build

1. The standing assignment. Each bot gets a title and an assignment that only its owner writes, and the model reads them on each call. The owner changed this on 2026-11-07, as [The description](#the-description) says.
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
| Activity's summary | The run's last text, as plain text, cut to two lines | It needs no model call and no stored field, and a routine's last text is its report |

A review on 2026-11-07 settled the thread. A routine's raw pages go in its own thread, and only its final report reaches the chat. In one shared thread, an hourly routine pushed the owner's own messages off the page in about a day, and one month of runs made each run load 121 MB of old pages. The prototype behind those numbers is not in this repository.

### Progress on step 5

1. Done. An owner sets a bot's name, title, and assignment in the info panel, and the title shows under the name there and in the chat header. `callModel` reads them through `bots.promptFor`, so an edit reaches the run's next model call. `VERIFY_SCENARIOS=assignment pnpm verify:agent` checks this with a scripted fake model, and it checks that another user and the service token cannot write them. Tested in a real browser at 1280 and 412 wide, in light and dark. A real model, the control VM, and a real phone are untested. Going back to a commit before this one needs a cleanup of stored titles and assignments, because the older schema has neither field and Convex checks every stored row at a deploy. The field is now called description, and the scenario's id is `description`.
2. Done. Each row of `TOOLS` names a required `effect`, one of `reads`, `changesVm`, or `changesOutside`, and `needsApproval` reads it through `toolEffect`. `FREE_AT_OUTSIDE_LEVEL` is gone, and a new tool fails the typecheck until it names an effect. A test written before the change holds every level's answer for every tool, the definitions sent to the model are byte for byte the same, and `VERIFY_SCENARIOS=A,approvals pnpm verify:agent` passes. The approvals scenario stores no key, so it needs `A`. This changes `packages/protocol`, and `deploy.sh` counts that as a change to `computerd`. So deploying this change updates and restarts `computerd` on every VM, though `computerd` behaves the same. The control VM is untested.
3. Done. A bot saves and forgets its own notes with `memory_save` and `memory_forget`, and the owner lists, adds, edits, and deletes them in the info panel. `users.about` holds what the owner writes in Settings, and all of that owner's bots read it. A note and its tool result go in one fenced mutation. At the default level, a memory tool asks once a computer tool has a result in this run. `VERIFY_SCENARIOS=memory pnpm verify:agent` checks this with a scripted fake model and a real backend, orchestrator, and `computerd`, including a SIGKILL placed after the commit and before its reply. The UI was tested with the same fake model in a real browser at 1280 and 412 wide, in light and dark. A real model, the control VM, and a real phone are untested. This changes `packages/protocol`, so deploying it updates and restarts `computerd` on every VM, though `computerd` behaves the same. Going back to a commit before this one needs every `users.about` cleared. A real deploy of the previous commit's schema stopped on a stored `about`, and passed with it cleared and a `memories` row still stored. An older commit's code ignores those rows, and its delete of a bot leaves them behind.
4. Done. A page with `alert()`, `confirm()`, `prompt()`, `onbeforeunload`, or `while(true){}` no longer holds a browser tool, its desktop, or the bot's queue. A dialog is answered as soon as it opens, in any page. A tool call ends at its signal or at a 60 second deadline, a page that stays hung is closed, and the model reads that it froze. The next call works on a new page. `consider` in `runner.ts` no longer asks again at once after `unavailable`, which took `runs.claim` from 555 calls a second to 0.2 under a real fence on a Mac, and a run still starts within 5 seconds of the fence ending. Unit tests cover this with a fake browser, and a real Chromium in a private container reproduced each bug before the fix and passed after it, with the real `createDesktops` and link and a faked systemd. `pnpm verify:agent` passes, in four sets that together run every scenario. `pnpm verify:browser` and `infra/proxmox/verify-desktop.sh` need a VM and have not run on this change, so real desktops under systemd, and a real take-over, are untested. This changes `computerd`, so deploying it restarts `computerd` on every VM.
5. Done. A read-only run calls `read_file`, `browser_navigate`, and `browser_snapshot`, and every other tool stores `rejected`, at every approval level. It never creates an approval and cannot write memory. It has 12 turns, and it stops researching at a prompt of 150,000 tokens or after 3 rejected calls. A final call with no tools then asks for its report. A deadline ends it as `failed` with its reason, and an owner's Stop stays `cancelled`. A routine has its own thread, and a finished run posts one report in the chat. `threads.timeline` counts only the owner's runs toward its 30, and a chat run's model reads the newest 3 reports and no raw page. Nothing starts a read-only run in production. Only an internal function that needs the admin key makes one. `VERIFY_SCENARIOS=A,readonly pnpm verify:agent` checks this with a scripted fake model and a real backend, orchestrator, and `computerd`, including a SIGKILL between a turn and its results and 40 reports in one chat. It failed before the feature and passes after. Docker's `computerd` has no desktop, so `browser_navigate` and `browser_snapshot` reached `computerd` and its journal and returned an error, and no real page has been read in a read-only run. The UI was tested in a real browser at 1280 and 412 wide, in light and dark. A rejected call's row was stored by hand in a chat thread for that test, because no page shows a routine's thread yet. A real model, the control VM, and a real phone are untested, so nothing has shown that Mistral accepts a call with no tools after a history that holds tool calls. This changes neither `packages/protocol` nor `computerd`, so deploying it restarts nothing on a VM. Going back to a commit before this one needs `endedAt` cleared from every run, because the older schema has no such field and Convex checks every stored row at a deploy.
6. Done. A read-only run's browser calls use a browser context of their own, with none of the owner's logins and with downloads denied, and the bot's own page stays where it was. A form that a page posts to a site where the owner is logged in now arrives with no cookie, a login that a page or a person makes in that window never reaches the jar, and it goes when the window ends. A frozen page ends its whole context, and the next call gets a blank page in a new one. The window ends at the run's end, at a call for another key or a chat call, after 10 minutes with no call, or with `computerd`'s socket. A logged-out snapshot shows a link's address. A chat run's snapshot does not, which differs from the design, because a logged-in page's links can hold secrets. `browser_navigate` and `browser_snapshot` have their own wording for a read-only run. An older `computerd` closes its link on the new field, so such a call ends as `unavailable`, which a real older build showed needs a check in the link. Unit tests cover this with a fake browser. A real Chromium in a private container, with its sandbox on, a visible display, and Xfce's window manager, reproduced each attack before the change and showed each failing after it, and ran the real `main.ts` through a SIGKILL with only `systemctl` and `sudo` faked. `scripts/verify-logged-out.ts` repeats this against any running browser. `pnpm verify:agent` passes, in sets that together run every scenario, and it checks that `computerd` received `browsing` on a read-only run's browser calls and not on a chat run's. Docker's `computerd` has no desktop, so that scenario still reads no real page. `pnpm verify:browser` and `infra/proxmox/verify-desktop.sh` need a VM and have not run on this change, so a real VM's Chromium and systemd, and a real model reading `to:`, are untested, and `verify-desktop.sh` has a new step that has never run. This changes `packages/protocol`, so deploying it restarts `computerd` on every VM.
7. Done in code, with a scripted fake model. A real model on the control VM still has to run the check. The owner asks a bot for something that recurs, the bot calls `schedule_propose`, and the owner approves a card, at every approval level. The card's words come from `describeCadence`, and `runs.append` reads the approval row from Convex. A Convex cron fires each due routine once as a read-only run, and its report appears in the chat. The info panel lists a bot's routines, with when, the next run, recent runs, and the last missed run, and it has Pause, Resume, Test now, and Delete. Settings holds the time zone. The composer stays open during a routine, and a message sent then stops the routine and goes when it has stopped. `VERIFY_SCENARIOS=A,schedule pnpm verify:agent` checks this with a real backend, a real orchestrator, and a real `computerd`, including the real cron, all 8 forbidden tools in one turn with a SIGKILL between the turn and its results, a kill on each side of the mutation that creates a routine, each repro behind the design, and cleanup in `finally`. It failed before the feature and passes after, and `pnpm verify:agent` passes in seven sets that together run every scenario. The UI was tested in a real browser at 1280 and 412 wide, in light and dark, with the same fake model. The composer's refusal when a fire wins the race was tested in a pure function and against the backend, and not in a browser. Docker's `computerd` has no desktop, so a routine in these tests reads files and no real page. A real model, the control VM, a real page through a routine, and a real phone are untested. So nothing has shown how a real model uses `schedule_propose`. Its schema is one flat object with no `oneOf`, because every chat run's request carries it, and nothing shows that Mistral accepts `oneOf` there. This changes `packages/protocol`, so deploying it restarts `computerd` on every VM. Going back to a commit before this one needs every `schedules` row deleted, and `timeZone` cleared from every user, because the older schema has neither `cadence` nor `timeZone` and Convex checks every stored row at a deploy.
8. Done in code, with a scripted fake model. `/activity`, reached from the sidebar, lists an owner's routines and 50 newest runs across all bots, from one query, `activity.page`, with no table and no counter of its own. A routine shows its bot, instruction, schedule, next run or that it is paused, and its last missed run. A run shows its bot, whether it was a chat or a routine, its state, a failure's reason, when it started, its last text as plain text cut to two lines, and "Blocked an attempt to change something" when it stored a `rejected` result. A chat row opens the chat, and a routine's row opens the panel at its routines. `VERIFY_SCENARIOS=A,activity pnpm verify:agent` checks this with a real backend, orchestrator, and `computerd`, including a real rejected call, a stopped run, failed runs, 50 runs with events near 1 MiB, 50 rejected calls with the longest name a model can send, another user, and a query with no sign-in. It failed before the feature and passes after, and removing either read limit made the backend refuse the query for too many bytes read. `pnpm verify:agent` passes in eight sets that together run every scenario. The page was tested in a real browser at 1280 and 412 wide, in light and dark, with the same fake model, and the back action there stands in for a back gesture. A real model, the control VM, a real page through a routine, and a real phone are untested. This changes neither the schema nor `packages/protocol`, so deploying it restarts nothing on a VM, and going back to a commit before this one needs no cleanup.

Step 5 was accepted on 2026-11-07, after these checks on the real system:

- The stack went to the control VM at `1bfb6d0`. A Convex export from just before that deploy is at `/root/backups/bots-before-step5-2026-11-07.zip` on that VM.
- `pnpm verify:template` ran a real chat through a real Mistral model, with a real shell tool on VM 201 and the new `computerd`. So Mistral accepts the new tool definitions.
- `infra/proxmox/verify-desktop.sh 201` passed all 247 checks, including the logged-out step and the reboot.
- The owner tried a real routine and reported that it works.

The step's check itself, that the orchestrator rejects a write attempt from a scheduled run, has only run with a scripted fake model, because a real model has no reason to attempt one. So nothing shows that Mistral accepts a history that holds a call to a tool it was not offered. `pnpm verify:browser`, `pnpm verify:screen`, and `pnpm verify:takeover` passed on 2026-11-08 against `1dc9f04`, which includes this stack.

### Routines by title, managed in chat

Done in code on 2026-11-09, with a scripted fake model, and not deployed. The owner approved the Figma redesign of the Routines panel, file `uHL0QLe51riKivmYXo2o4q`, section "03b · Routine detail", and asked that a bot create, change, and delete routines with no card when the owner asks in chat. [How a routine fires](architecture.md#how-a-routine-fires) gives the design.

- A routine has a title, a one-line description, and 1 to 6 steps beside the instruction it runs. The panel shows those and never the instruction. A routine made before this shows the start of its instruction as its title, with no description and no steps.
- `schedule_propose` is gone. `schedule_create`, `schedule_update`, and `schedule_delete` ask at Everything, and at the other levels only once the run has read untrusted text. The prompt lists each routine's id and title, and tells the bot to update a routine rather than create a second one. Stored `schedule_propose` calls replay to the model as `schedule_create` and show in the chat as a created routine.
- The details have no buttons. Test now and `schedules.runNow` are gone, and the owner asks the bot to try something instead. Delete is a context menu on a computer, by right-click, Shift+F10, or the context menu key, and a swipe on a phone.
- A delete, by the owner or by the bot, leaves an Undo line for 8 seconds. The routine cannot fire in that time and counts toward no limit, and Convex removes it for good when the window ends.

`pnpm verify:routines` drives the panel in Chromium in light and dark, at 1440 wide and on a 390 wide touch phone, and it passed against the local app on 2026-11-09. Its swipe is Chromium's touch emulation. `pnpm verify:design` passed with its routine steps rewritten for the menu and Undo. `pnpm verify:agent` passed in full on 2026-11-09, all 31 scenarios and 522 checks, against a separate local backend. Its `schedule` scenario now covers a create in chat with no card, a card at Everything and after a read at every other level, an update that moves the next run and one that leaves a paused routine paused, a bot that cannot reach another bot's routine, a bot's delete that the owner sees with Undo, a deleted routine that never fires and counts toward no limit, an Undo, the end of a window after an Undo, and the delete that lands when the window ends. Nobody ran these new checks against the code before this change, so they have not been seen to fail. A real model, the control VM, and a real phone are untested, so nothing shows how Mistral fills the title, description, and steps, or whether it accepted `schedule_propose` in history before the rename.

This changes `packages/protocol`, so deploying it restarts `computerd` on every VM. Going back to a commit before this one needs `title`, `summary`, `steps`, and `deleting` cleared from every `schedules` row, because the older schema has none of them and Convex checks every stored row at a deploy.

### The description

The owner said on 2026-11-07 that a description is a generic information field, and that like memories and routines it is meant for the AI to edit and update. `bots.description` has the old field's 8,000 character limit. The owner still edits it in the panel, and a bot replaces it with `description_set`, which works like the memory tools at every approval level. [The architecture document](architecture.md#who-can-write-a-description-and-what-limits-it) gives the reasons and the limits.

No stored row held the old field when it was renamed, so no migration ran. On the Mac, 0 of 1,467 bots held a value just before each deploy. The operator found 0 of 1 on production, and that count needs repeating just before the deploy there.

`VERIFY_SCENARIOS=A,description pnpm verify:agent` checks this with a scripted fake model and a real backend, orchestrator, and `computerd`, including a SIGKILL on each side of the mutation, a stale lease, a stop, a refused secret, a denied card, a read-only run, and `computerd` stopped. The `readonly` and `schedule` scenarios each forbid the tool. The panel was tested in a real browser at 1280 and 412 wide, including a bot's change that reaches the open panel and leaves the owner's unsaved text alone. A real model, the control VM, and a real phone are untested, so nothing shows when a real model chooses to call `description_set`.

This changes `packages/protocol`, so deploying it restarts `computerd` on every VM. Going back to a commit before this one needs `description` cleared from every bot, because the older schema has no such field and Convex checks every stored row at a deploy.

### The date and time

Done on 2026-11-10, and deployed that day at `6d89350` with the change that moved it. [Less history in each model call](#less-history-in-each-model-call) moved the line the same day, from the system message to each message from the owner, so this section records what the first version did. A bot's prompt had the owner's time zone and no date, so a bot guessed what "today" meant. Each model call's prompt now gives the date and time from the orchestrator's clock, in a chat run and in a routine. It reads in the owner's time zone with the same instant in UTC, or in UTC alone when the owner has no zone.

`pnpm test` checks the line's words across a zone, daylight saving, a day that has already turned, and midnight. `VERIFY_SCENARIOS=A,B pnpm verify:agent` passed on 2026-11-10 with a new check that the real orchestrator's request to a fake Mistral holds a time within five minutes of the clock. The same check failed against the code before this change. Against the deploy, a real model asked for the weekday, the date, and the time named Tuesday, 10 November, and 2026 from the time on the owner's message, with no tool call.

This changes neither the schema nor `packages/protocol`, so deploying it restarts nothing on a VM, and going back to a commit before this one needs no cleanup.

### Less history in each model call

The owner asked on 2026-11-10 for a way to manage a bot's context that sends fewer tokens. A measurement of every stored run on the control VM came first, and [What a model call reads of its thread](architecture.md#what-a-model-call-reads-of-its-thread) has its numbers and the design.

PR 1 of 4 is done, and deployed on 2026-11-10 at `6d89350`. An answered request now reaches a later model call as the owner's message and the bot's reply. A run that stored no reply leaves the next run its newest steps whole and a line for each older call. `historyOf` in `apps/orchestrator/src/history.ts` decides this from the stored events, and it stores nothing.

- `pnpm test` checks `historyOf` and the messages a model receives. Three deliberate breaks in `historyOf` each turned 6 tests red: no turn ever answers, a listed step is also sent whole, and a cut that moves on every call.
- `node scripts/context-report.ts` replayed the control VM's stored runs through the new code. It estimates 51% of the prompt tokens that the 175 chat calls sent, and a largest call of 44,482 in place of 90,698. A routine's request is the same.
- `VERIFY_SCENARIOS=A,B,context,desktop pnpm verify:agent` passed on the Mac. The new `context` scenario checks the request that a fake Mistral receives after an answered run and after a run with no reply, and the `model-call` log line.
- A full `pnpm verify:agent` passed every other scenario and failed `schedule` and `activity`. The commit before this change fails the same 5 checks on the same backend, because the Mac's Convex held the functions of an older commit, with `schedules:runNow` still deployed. So those two scenarios have not run against this change.
- No real model ran on this code before its deploy, because the Mac's stored Mistral key did not decrypt with the env files at hand. The deploy's checks are below.

This changes neither the schema nor `packages/protocol`, so deploying it restarts nothing on a VM, and going back to a commit before this one needs no cleanup.

PR 2 of 4 is done, and deployed on 2026-11-10 at `6d89350`. The owner asked for it the same day. A request now sends Mistral's `prompt_cache_key` with its thread's id, and each turn stores the cached token count that Mistral reports. The date and time left the system message, where it changed the first message every minute. Each message from the owner, and each routine's instruction, now starts with the time it was sent. [What two requests of one run share](architecture.md#what-two-requests-of-one-run-share) has the design. This lowers the bill and not the size of a request.

- `pnpm test` checks that each request of a growing run starts with the request before it, that the system message holds no date and no time, the time line's words, the cache key in the request, and the cached count from the stream. Three deliberate breaks each turned tests red: a clock back in the system message, no count read as 0, and no key in the request.
- A full `pnpm verify:agent` passed on 2026-11-10, all 32 scenarios and 532 checks, against a separate Convex backend on the Mac that held this change's functions. The commit before this change passed 527 checks on the same backend, so the `schedule` and `activity` scenarios, which PR 1 could not run, have now run on both. Its fake Mistral reports a cached count, and the stored turn and the `model-call` log line hold it. A killed orchestrator sends the same messages after its restart.
- No real model ran on this code before its deploy. The deploy's checks are below.

This changes the schema and not `packages/protocol`, so deploying it restarts nothing on a VM. Going back to a commit before this one needs `cachedTokens` cleared from the `usage` of every stored turn that has one, because the older schema has no such field and Convex checks every stored row at a deploy. A turn has one only after Mistral reported a count.

Run `pnpm verify:template` right after the deploy. Mistral's page shows `prompt_cache_key` on `/v1/chat/completions`, and no request from this system has sent it. If Mistral refused the field, every run would fail at its first model call with the status in its reason, and no turn would hold a count, so going back would need no cleanup. Then `journalctl -u bots-orchestrator | grep model-call` shows `cachedTokens` beside `promptTokens` for each call, and a call with no `cachedTokens` means Mistral sent no count.

The control VM runs `6d89350` since 2026-11-10, released as `v0.2.0`. A Convex export from just before the deploy is at `/root/backups/bots-before-prompt-cache-2026-11-10.zip` on that VM. The deploy restarted nothing on VM 201. These checks ran against it with a real `mistral-large-4`:

- `pnpm verify:template` passed. Mistral accepted `prompt_cache_key` on every streamed call, and its stream reports a cached count. The run's first call reported 0 of 4,616 prompt tokens cached, and its second 4,352 of 4,731.
- A chat of five runs on a throwaway bot, driven by a script that is not in this repository. In a run of five calls, the calls after the first had 18,688 of 20,105 prompt tokens cached, which is 93%. The first call of each later run had 4,352 or 4,608 cached of about 4,800, so the system message and the tool definitions stay cached from one run to the next.
- Across all 11 real calls, Mistral served 41,216 of 53,562 prompt tokens from its cache, which is 77%. At a tenth for a cached token, those calls cost what 16,468 uncached prompt tokens cost, 31% of the full price.
- Asked for the weekday, the date, and the time with no tool, the bot named Tuesday, 10 November, and 2026 from the time on the owner's message. No turn copied the bracketed line.
- A run stopped during a `sleep`, and the next message was answered. So Mistral accepts the history that a run with no reply leaves, and the reply named both the earlier work and the stopped command.
- Asked what the one line in a file from an answered request was, the bot answered right with no tool call. The owner's first message held that line, so this does not show that a bot reads again what it can no longer see.

The stored runs from before the deploy sent 5.7 million prompt tokens with no cache. Nothing has measured a long, tool-heavy thread on the new code, so the 51% estimate for PR 1 still has no real number beside it. `journalctl -u bots-orchestrator | grep model-call` on the control VM has each call's `promptTokens`, `cachedTokens`, `storedBytes`, and `sentBytes`.

The next PRs, in this order:

1. Let the run in progress shed its own old steps a page at a time. The estimate for this is about 27% of today's tokens sent. It waits on a real-model check, because Mistral's guide says that dropping a thinking trace makes later turns worse, and reasoning was about a third of the measured tokens. The cache changes what it is worth. Inside a run, 93% of a later call's prompt tokens were cached, so the steps it would shed already cost a tenth, and each cut gives up the cache from the cut onward for one call. It still bounds a request that would outgrow the model. Measure a long run's `model-call` lines before building it.
2. Bound a thread's messages and replies, and give a routine's pages a window. This closes the gap about a thread that outgrows the model.

These are proposals, so change them if you find a better answer:

- Make `readUntrustedText` read the steps that a run with no reply left for the next run. A save after "continue" would then ask when the failed run read a page. It adds cards, so it is the owner's call.
- Raise or remove the limit of 40 turns once a run sheds its own steps. Two of the 11 measured runs ended there.
- Give a tool result its own time when it lands 10 minutes or more after the last time shown, so a run that waited on a card reads the time without asking its shell.

### Later: hide memory's details

The owner decided this on 2026-11-07. Showing the details of memory and similar things is fine for now. Later, Bots should have a simple UI that hides this complexity and stays clean, as Grok Bot does. The owner will not edit memory directly, and will ask the bot to list and change memories instead. This replaces the earlier plan for individual notes to stay editable by hand. A description now follows the same plan as memories, so the owner's field in the panel goes with them. Bots still cannot edit or delete routines or notes that their owner wrote, so that later work needs those tools.

When that work starts, these things need an answer. They are proposals, so change them if you find a better answer:

- Which other details go with it. The owner named memory "and such", and the panel's routines and profile, the chat's tool rows, and Activity are candidates. A tool row in the chat is how the owner sees a save happen today.
- A bot cannot change or forget a note whose source is the owner, and it refuses the owner's own request to. So the rule needs to change, or the owner's existing notes need a path. A page must not gain that power, so a change to an owner's note should show a question card.
- The panel is the only view of notes that does not pass through the model. A planted note can tell a bot to leave itself out of an answer, so "what do you remember?" alone cannot show it. A `memory_list` tool whose chat row shows the stored rows, not the model's words, would keep one honest view with no screen of its own.
- Rows stay the store, with their source and run, so an injected save can still be traced. Only the screen goes.

## After step 3: deploy from `main`

Add a systemd timer on the control VM. The server pulls, so GitHub holds no Tailscale key and no SSH key. The timer does these things:

1. Check `origin/main` every few minutes for a new commit.
2. Continue only if CI passed on that commit.
3. Run a Convex export.
4. Run `deploy.sh main`.

## Known gaps

These are open on purpose. Fix each one when the work reaches it.

- At Automatic, git reads a repository's own config when it runs an allowed command such as `git status`, and that config could carry a setting the rules never saw. The rules match a `git config` that sets one and a write to a config file, not what an existing file already holds.
- At Automatic, a page action still asks, because the page's own buttons aren't named yet. The next PR names them from the snapshot so a safe page action can run.
- At Automatic, the rules read the call and its desktop aim, not the state the call lands in, so a click's real effect can still depend on what the app shows at that moment.
- Deleting a routine removes its runs, so they stop counting toward the limit of 48 scheduled runs a day.
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
- A run reads the time of the message that started it, and no newer time. After a long wait on a question card, or a start that was delayed, that time is behind. The prompt tells a chat run to ask its shell for the date then, which is an instruction to a model. A routine has no shell, and it never waits on a card.
- A model may copy the bracketed time line into its own replies. In one real chat of 11 calls, none did.
- A model call still reads every message and reply of its thread, every step of the run in progress, and every page of a routine's run, as [Less history in each model call](#less-history-in-each-model-call) says. So a thread with enough messages, or one run with enough output, can still exceed what the model accepts.
- A bot no longer reads what an answered request's commands printed, which pages it read, or how it reasoned. Asked about one, it must run or read again, and a model may guess instead. The prompt tells it not to, which is an instruction to a model. No check with a real model has shown a bot reading again what it can no longer see.
- After a run that ended with no reply, the next run reads the newest 8 to 16 KiB of its steps and a line for each older call. It may repeat a read whose output is no longer shown, and nothing stops it from repeating a call that changed something.
- `readUntrustedText` covers one run. An answered request's tool output no longer reaches a later run. A run that stored no reply still leaves its newest steps for the next run, so an injection in them passes the check, and the first save of that next run has no card. A reply can also repeat what a page planted.
- At the Shell and Nothing levels, a save shows no card, so a page can plant a note there. The chat row and the panel still show it.
- A forget's card shows only an id, so the owner approves it without seeing the text unless they open Memory. The row's output shows the text afterward.
- `looksLikeSecret` is best effort. "My password is hunter2" passes, and so does "My password: hunter2 today", because a pair with a colon counts only when one token follows and then the line ends. `"password": "hunter2"` passes too, because a quote after the name is no pair for a short value, and `token == abc` passes because it reads as a comparison. A refused call's arguments stay in `runEvents` and in later model calls, until the bot is deleted.
- A 40 or 64 character lowercase hex token, or a UUID, passes when nothing before it on its line gives it away, because it looks the same as a git hash. `=`, `:`, a flag that ends in a secret word, and a secret word each give it away. So `API_KEY | <hex>`, `key -> <hex>`, and the same token on the line after `MY_KEY:` pass. Under `commit`, `hash`, `sha`, `sha1`, `sha256`, `digest`, `rev`, `revision`, `etag`, `id`, or `uuid`, it passes after `=` or `:` as well.
- A key made of words and digit groups passes, such as a long dashed passphrase or a group of letters repeated with dashes, because it looks the same as a long file name. A random token can also read as words by chance. In 2 million tries each, 0.0105% of 24 byte base64url tokens passed, 0.00035% of 32 byte tokens, and none of 48 byte tokens. Base64 measured 0.0095%, 0.00035%, and none. Random letters and digits with no separator never passed.
- A run of digits of any length passes unless the card row catches it.
- A 40 or 64 hex token passes unless `=`, `:`, a flag, or a secret word comes right before it. So `API_KEYS=["<hex>"]`, `auth=("ada","<hex>")`, `'api_key' => '<hex>'`, and `<apiKey><hex></apiKey>` pass, and `main` refused them. An independent review measured this on 2026-11-07. It is the cost of letting a git hash pass.
- The webhook rules cover only `hooks.slack.com/services/` and `discord.com/api/webhooks/`. `discord.com/api/v10/webhooks/...` and `hooks.slack.com/triggers/...` pass as a key in a URL's path. So does a long run in a later label of a host, such as `https://sub.<key>.example.com`.
- The check still refuses some ordinary text that `main` passes, and these are the ones a person is most likely to hit: a mixed id after a label, such as `Order: ORD-2026-A1B2C3D4`, `Tracking: 1Z999AA10123456784`, or an IBAN, and a digit inside a word in a long name, such as `Model: gpt-4o-mini-2024-07-18`, `MYSQL_COLLATION: utf8mb4_unicode_ci`, or `src/i18n/locales/en-US/messages.json`. The bot's refusal says not to try again, so a false refusal can lose a note instead of costing a retry.
- Text can still hide data with no visible change: U+FE0F and a joiner after an emoji, and a space swapped for a no-break space, as well as joiners in Persian or Hindi and runs of tabs and spaces. The review stored about 50 bytes that way in one note. `main` accepts all of these too.
- A year right before a card number, as in `2029 4111 1111 1111 1111`, misaligns the Luhn check, so that card passes.
- A key in a URL's path passes, because document ids look the same. So does a key joined by `.`, `-`, `_`, or `~` right after a URL, and a key in the path of a URL inside a query, as in `?next=https://y.com/<key>`.
- Two runs of under 32 characters joined by `=` count as a name and a value, so only the value is read, and a value with no digit or under 16 characters passes.
- A value of under 32 characters with no digit passes under any name but a secret's own, such as `MY_KEY=abcdefghijklmnopqrst`. After an underscore, a short value needs a digit and a letter, so `FOO_PASSWORD=hunter2` is refused and `FOO_PASSWORD=sunshine` passes. A percent-encoded value passes unless it sits under a listed query name, or a stretch of it reaches 16 characters.
- A mixed value of 16 or more characters after `=`, `:`, a flag, or a secret word is refused even when it is no secret, such as `Tracking: 1Z999AA10123456784`, an IBAN, or `?id=abc123def456abc123def456`. A hash or UUID under a name outside the list is refused the same way, such as `request_id=<uuid>` or `GITHUB_SHA=<hash>`. Each costs a bot one retry.
- A long token that reads as no row of `ORDINARY_LONG_TOKENS` is refused even when it is no secret. That covers a segment with a digit inside it, such as `k8s/deployments/orchestrator-config.yaml/backups` or `IMG_20260101_123456_HDR_Screenshot_FINAL_v2Copy.png`, one camelCase word or plain word of 32 or more letters, a 32 character hex digest, and a Convex id. Each costs a bot one retry.
- A long id in a URL is refused when the URL ends before it. That covers an id after a comma, a bracket, a quote, `;`, `|`, or `!`, an id in a query such as a YouTube playlist, and a document id in a URL with no scheme. Each costs a bot one retry.
- A heading such as `Password: required` or `Secret: Santa`, or code such as `const token = getToken();` or `password = NULL`, is refused, because a value after a secret's name looks the same. Each costs one retry.
- About one in ten numbers in a card's layout pass Luhn, so a 13 digit timestamp or a 19 digit id in a URL can be refused. A card typed in another layout, such as two groups of 8, passes.
- A long phrase that starts with a known key prefix, such as a package name that starts with `sk-` or `npm_config_registry_is_set_here_ok`, is refused.
- U+200C and U+200D pass beside a character of a script that uses them, or after that character's combining marks, so text in Persian, Hindi, or a similar script can still hide data in them. A script missing from the list has its joiners refused, and the message says to type the text again.
- Long runs of blank lines or of tabs and spaces pass.
- Some real text is refused because it holds a character that the rule cannot tell from a hidden one: a subdivision flag such as England's, which uses tag characters, a text-style emoji such as a footnote's return arrow, Mongolian variation selectors, a soft hyphen in pasted text, the Arabic end of ayah U+06DD and number signs U+0600 to U+0605, the Syriac abbreviation mark U+070F, the Kaithi number signs, the Egyptian hieroglyph format controls, the Tifinagh consonant joiner U+2D7F, and private-use icons. The owner's message says to type the text again. A character newer than the backend's Unicode tables is refused too, unless Unicode reserves it for emoji.
- A bot's name and title have a length limit and no character or secret check, and every model call reads them. Only the owner writes them.
- A stored note, About you, description, or instruction keeps whatever it held before this rule, and it reaches the model until someone edits it. That includes an invisible character, a Slack webhook URL, a mixed value of 16 or more characters after a name, and a long token that holds `/` or `.`, all of which `main` stored. A stored row that fails the new rule blocks a Save from the panel until it is retyped. The panel's Save sends the description with the name and the title, so a description that holds any of these, a webhook included, also stops a rename. About you works the same way. A note's edit replaces only that note.
- A bot's forget during an owner's edit removes the row, with its edit box and the typed text. A draft in the add box goes when the panel closes.
- A chat row calls a refused save "Saved a note" with "failed" beside it, as it does for any tool that failed. The expanded row says why.
- The prompt dates a note in UTC, and the panel dates it in the device's time zone, so the two can differ by a day.
- The prompt gives the time of the model call and no time for any earlier message, so a bot cannot tell whether its owner wrote a message a minute ago or a month ago.
- A chat run loads every report in its thread and sends only the newest 3 to the model. An hourly routine adds up to about 5.8 MB to that load in a month, and nothing removes old reports.
- About 200 reports in a row push the owner's messages off the page, because `threads.timeline` reads at most 200 runs. An hourly routine does this after about 8 days with no message from the owner, and the page says that older messages are not shown.
- A report reaches later chat runs as the bot's own words, and a page can plant its text. A chat run's first save after such a report shows no card at the default level, because `readUntrustedText` covers only the run itself.
- An assistant turn with no text and no call replays as an empty message, and Mistral's own validator refuses that in some of its versions. A read-only run's report is never empty, so this affects only a chat run.
- A chat row calls a refused routine "Created a routine" with "failed" beside it, as it does for any tool that failed. The expanded row says why.
- A routine change that breaks a rule, such as an owner with no time zone or a bot with 10 routines, shows its card when it asks, and it fails only after the owner approves. The prompt lists a bot's routines, so a bot can see that limit first.
- `fireDue` takes 32 due rows in a tick, oldest first. If 32 routines wait for busy bots at once, the rows behind them wait with them, and they can miss their 15 minutes. With 20 routines for each owner, this needs several owners at once.
- An owner who keeps chatting keeps a routine waiting, because a run that ended under 2 minutes ago counts as busy. After 15 minutes that fire is missed, and the panel says so.
- A description that a bot wrote reaches every later model call, so a page that persuades a bot can change it. At the Shell and Nothing levels, `description_set` shows no card, and the chat row and the panel are the only signs.
- The check on `description_set` covers one run. An injection still in the replayed history can pass it, because the first change of a later run has no card at the default level.
- A job told in chat lasts only if the model chooses to save it, with `description_set` or a note, and otherwise only as long as the thread replays it. A new routine's run reads the description and the notes but no chat, so its work comes from its own instruction.
- The card for `description_set` shows the new text and not the old text. A call that clears the description shows an empty box, with nothing that says it clears.
- The panel's Save sends the name, the title, and the description. A bot's change that lands after the panel's last live update and before the save is overwritten. The chat row still holds that text.
- An `everyHours` routine moves later by the cron's delay at each fire, about 30 seconds on average, so an hourly routine moves about 12 minutes in a day.
- The panel shows a routine's run states and failure reasons. No page shows a routine's raw pages, so the owner reads only its report.
- The panel and Activity give the next run in the zone from Settings, and past runs in the device's zone, so the two can differ.
- The panel never shows a routine's instruction. Its title, description, and steps are the bot's words about it, and no code checks that they match. The owner can ask the bot what a routine runs, because the prompt holds each instruction.
- A routine tool's check on untrusted text covers one run, as a note's does. So an injection still in replayed history passes it, and the first routine change of a later run has no card below Everything.
- A delete's card shows only the routine's id, as a forget's does.
- The Undo line shows only in the panel, so a bot's delete while the panel is closed leaves only its chat row. The line counts down on the device's clock against Convex's end, so a wrong clock moves the bar and not the delete.
- An Undo does not check the limit of 10, so a routine created during another's window can leave a bot with 11.
- A delete from the keyboard leaves focus on the page, not on Undo.
- A held message stays in a read-only box until the held run ends. If no runner holds that run, that can last until the next tick after its 30 minute limit.
- A message held during a routine lives only in that page, so closing the page loses it.
- A routine whose owner has no orchestrator on a shared dev backend keeps its bot busy for 30 minutes at each fire, until 3 failures pause it.
- Activity lists a routine's fire only while its raw run exists, and a routine keeps about 20. So one routine and no chat fill about 20 rows of the 50, and an older fire has only its report in the chat.
- Activity reads at most 2,000 of an owner's newest runs, because report rows stay for good and it reads past them. At 48 routine runs a day, a chat run about 40 days old is no longer listed.
- Activity gives text to rows until it has read 8 MiB. With events near 1 MiB that is about 8 rows, and the rest show no text.
- `blocked` means that a run stored a `rejected` result. It does not say why. A model's own mistake reads the same as an injection, and a final call's leftover calls count, even a read. So a run that hit its limits and then asked to read a file says "Blocked an attempt to change something".
- A row's last text comes from a model, and a page can plant it. It can say "Succeeded" or "Blocked". The line above it comes from the run.
- A tool call's id has no size limit in `apps/orchestrator/src/mistral.ts`, and its name and arguments do. An upstream that sent rejected calls with ids near 1 MiB could take `activity.page` past its read limit, and the page would then fail until those runs left the newest 50. Nobody has seen Mistral send a long id.
- Activity's time labels change when its data does, so a page left open past midnight can say "Today" about yesterday until the next run.
- On a phone, closing a panel opened from Activity goes back to Activity and not to the bot's chat. On a computer, moving to another bot with such a panel open scrolls that bot's panel to its routines too.
- A bot's first time zone comes from the browser of the device that first opens the app. An owner who travels changes it in Settings.
- Downloads in a chat run are not blocked, so a page can put a file on a bot's computer. Step 5's logged-out browsing blocks them only in a routine.
- A logged-out window looks like any other Chromium window. A person who takes over during a run can type a password into a hostile page. Nothing moves, but the page reads what was typed.
- A window whose `browsingEnd` was lost keeps running its page for up to 10 minutes after its last call, or until the bot's next browser call. This happens when the link is down at the run's end, or when `fireDue` ends a late run. A frozen page uses a CPU core for that time.
- A live run whose next tool waits 10 minutes, for a slow model call or a long take-over, finds a blank page. The run's model reads this and opens the page again.
- `browsingEnd` closes an older `computerd`'s link, as each logged-out call does, at a cost of about 260 ms for a reconnect each time, until that VM updates.
- Link addresses made the 5 real logged-out snapshots measured 1.7 to 3 times as large. A long page reaches the 32 KiB cap sooner, so the model reads less of its text. A capped link-heavy page is about 12,700 tokens by the v3 tekken tokenizer, so 11 such pages reach about 139,000 of the 150,000 token limit before the description, the notes, and the reports count.
- An address cut at 200 characters may not open, and the model reads only that it was cut.
- A chat run's snapshot shows no link addresses, so a chat bot still has to open a link to learn where it goes.
- `computerd` needs Chromium to name its default context, and it fails every browser tool on a browser that does not. Chromium 156 does. A VM's Chromium has not run this code.
- A bot's own process can dispose a logged-out context through CDP on loopback. That run's next browser calls then fail closed.
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
- `pnpm verify:takeover` needs the model to start a local test page. On 2026-11-08 the model refused once, because a page that turns typed text into a cookie looked like a fake login to it. An earlier failure that day printed no reason, so its cause is unknown. The prompt now says what the page is for, and a refused setup prints the bot's reply. Two runs passed after that change, so a refusal is rarer, but it can still happen.
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
- `browser_navigate` checks no address, so a bot can still open loopback, such as CDP, or the link's address on its screen with no card. `web_fetch` checks every address and every redirect.
- `web_search` gets only what the engines behind SearXNG answer the home IP address. Measured on 2026-11-09 over 20 queries in a row, Google and Brave answered the first 13, then Brave stopped answering and Google answered the rest alone. DuckDuckGo answered CAPTCHA every time, and Wikidata failed on some queries. A search while every engine blocks the address is untested. It would answer `error`, name each engine that failed, and name DuckDuckGo's and Bing's results pages for `browser_navigate`. Whether a real browser can read those pages from the home IP address is also untested.
- SearXNG is pinned to `searxng/searxng:2026.11.9-57ff753ad`. A fix that SearXNG makes for an engine reaches Bots only when someone moves the pin, and nothing does that.
- `web_fetch` asks for English, and `web_search` sends SearXNG no language, so SearXNG picks one by its own defaults. Neither follows the owner's language or country.
- `web_fetch` runs no JavaScript and sends no cookies, so a page that draws its text with a script, or a consent wall, reads as almost no text. The prompt then sends the bot to its screen.
- `web_fetch` keeps no cache, so each part fetches the page again, and a page that changed in between can shift its parts.
- A link to a place on the same page is left out with its text, so a table of contents of numbered links reads without its numbers.
- `web_fetch`'s User-Agent names Chrome 130. Nothing keeps it current.
- Searches and fetches leave from the home IP address, like the browser, so a site that blocks it blocks both.
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
- Chromium's file chooser opens taller than the 1280x800 screen, so its Cancel and Select buttons are off the screen and have no marks. A bot can press Escape or Return, or type a path after ctrl+l.
- An app that a bot starts from its shell runs as `agent`, outside the desktop's bus, so a look lists none of its elements. An app started from the panel runs as `browser` and is listed.
- A desktop that was running before the update that added the bus has no marks until its next start, which the idle stop brings within an hour. Its looks say so.
- Accessibility is on in every Chromium, which costs about 67 MB more anonymous memory with a real page, 318 MB against 251 MB on the Wikipedia page for Linux. Turning it on only after a run's first look would save this for desktops that no bot looks at.
- A click is refused, with a new look, when the page moved the element more than 24 px between the look and the action. This costs one look and never clicks the wrong thing.
- A look walks every app's tree, including apps that it then leaves out because another window covers them. A page with 2,000 links in a window behind the active one still costs about 1.4 s.
- An always-visible menu on a web page, made with `role="menu"`, counts as an open menu, so an element of the page that overlaps it loses its mark.
- Each click at the default level is its own card, so one task can ask many times. Automatic review is the later answer.
- A desktop card shows the run's newest look. A card whose look was replaced cannot happen today, because a run waits on its card, but nothing records which look a card was aimed from.
- The numbers on the picture can cover text near a box, and two labels that would overlap leave the second unlabelled. The text list carries every mark.
- Desktop tools have no coordinate click and no drag, so an app with no accessibility tree gets only keys.
