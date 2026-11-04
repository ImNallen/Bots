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
- A journal in `computerd` makes tool execution at most once. `computerd` writes a meta file with fsync before it starts a tool, and it writes the result to a temp file and renames it. The journal survives restarts of both processes, and it keeps entries for 7 days.

The runner persists an assistant turn before it sends any of the turn's tool calls. After a crash it sends each pending call again with the same call id, and `computerd` answers from what it finds:

| Journal state | Answer |
|---|---|
| A result exists | The stored result, with no execution |
| The call is running in this process | The running execution's result |
| Only meta exists | `interrupted`, recorded and never rerun, because `computerd` died during the call |
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
- `users.email` holds the Tailscale login, which is how existing users would map to new accounts. A login is usually an email address, but some identity providers use a form such as `user@github`. Those users would need a manual match.

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

## Why screens share one browser

Each bot has its own screen, and all of a user's bots share logins. These two requirements conflict in the obvious design, one X display for each bot. Chromium locks a profile to one process, and that process stays on one display.

The design that works has one wide virtual display. Each bot gets one Chromium window in its own 1280x800 region of that display. A cropped `x11vnc` stream shows each region.

We tested this in an arm64 Debian container against a local page:

| Test | Result |
|---|---|
| Open the same profile on a second display | The page opened on display 1, and display 2 stayed empty |
| Bot B visits a site after bot A logs in | Bot B sent bot A's HTTP-only cookie |
| Two bots type 100 characters each through CDP at once | Neither input mixed with the other |
| Simulated user types on screen A while a bot types on screen B | Neither input mixed with the other |
| Two windows receive `xdotool` input at once | Characters landed in the wrong windows |
| Bot B opens a popup | The popup opened on screen A until CDP moved it to screen B |
| One VNC stream per region | Each stream returned 1280x800 and the correct page color |

The results set three rules:

- Bots drive the browser through CDP, not through desktop input.
- `computerd` moves each popup to the screen of the bot that opened it.
- Screens show the browser only until desktop apps get an input lock.

The test did not cover real websites, more than two screens, input through a VNC stream, noVNC on a phone, or Chromium with its sandbox on. Step 4 of the roadmap covers these.

## Where secrets live

The orchestrator holds Mistral keys and OAuth tokens, encrypted with a master key that only it can read. Convex stores ciphertext only. A Mistral key uses AES-256-GCM with the owner's user ID as authenticated data, so a ciphertext copied to another user's row does not decrypt. Bots call connector tools without receiving the tokens.

The orchestrator signs a short-lived JWT with the subject `service:orchestrator` for its own Convex calls, and every service function checks that exact subject. User subjects always start with `dev:` or `tailscale:`, so a user token cannot pass that check.

`computerd` holds only its link token. A VM is untrusted, so the orchestrator validates every link message, closes the socket on an invalid one, accepts a result only for a call it sent on that socket, and caps output again.

Logins that a user types into a VM's browser stay in that VM's shared browser profile, so every bot on that VM can use them. A user logs in through take-over until the Vault ships, so passwords never enter the chat. When the Vault ships, bots lose passwordless `sudo`. Otherwise a bot could read a filled password from browser memory.

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
