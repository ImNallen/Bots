# Roadmap

Each step ends in a check. Start the next step only after that check passes. The reasons behind these choices are in [the architecture document](architecture.md).

| Step | Build | Done when |
|---|---|---|
| 1a | Repository, Convex in Docker, dev mode, and the web shell, on a Mac | The web app shows a live Convex query, using a JWT from `/auth/token` |
| 1b | Control VM, `tailscale serve`, and Tailscale mode, on Proxmox | A second Tailscale account and a phone browser see the same live query, each as its own user |
| 2 | Agent loop and shell and file tools, with `computerd` in Docker | A user chats with a bot in the web UI, and killing the orchestrator mid-tool resumes the run with no duplicate side effects |
| 3 | Proxmox template, reconcile loop, and network rules | Provisioning converges after being killed midway, and a script proves that a VM reaches only the internet and the orchestrator |
| 4 | Screens, live view, take-over, and approvals | Two bots work at once while a user watches one and takes over the other from a phone |
| 5 | Schedules, the memory UI, and the Activity view | The orchestrator rejects a write attempt from a scheduled run |
| 6 | Friend invites | A friend goes from invite to working bot without help |
| 7 | Tauri and Expo apps, and push | A user approves an action from a push notification |
| 8 | OAuth connectors, the independent reviewer, and the Vault | Bots use saved logins without seeing the passwords, and bots no longer have passwordless `sudo` |

Step 1b can run after step 2, but it must finish before step 3 starts. Friends cannot join before step 3 passes, because bots are not isolated from the LAN until then.

Backups are deferred. Add off-server copies of Convex exports and the master key before anyone depends on this system.
