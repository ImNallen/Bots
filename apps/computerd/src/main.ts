import { isBrowserInvocation } from "@bots/protocol";
import { createBrowser } from "./browser.ts";
import { createCalls } from "./calls.ts";
import { parseConfig } from "./config.ts";
import { createDesktops, createSystemd } from "./desktops.ts";
import { executeSystemTool } from "./execute.ts";
import { openJournal } from "./journal.ts";
import { connectLink } from "./link.ts";
import { log } from "./log.ts";
import { relayScreen } from "./screens.ts";

const JOURNAL_DIR = "/var/lib/computerd/journal";
const RUNTIME_DIR = "/run/computerd";
const JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const JOURNAL_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DESKTOP_SWEEP_INTERVAL_MS = 60 * 1000;

const config = parseConfig(process.env);
const journal = await openJournal({ dir: JOURNAL_DIR });
async function pruneJournal(): Promise<void> {
  const pruned = await journal.prune({ now: Date.now(), maxAgeMs: JOURNAL_MAX_AGE_MS });
  log({ level: "info", event: "journal-pruned", pruned });
}
await pruneJournal();
setInterval(() => {
  pruneJournal().catch((error: unknown) => {
    log({ level: "warn", event: "journal-prune-failed", message: error instanceof Error ? error.message : "unknown error" });
  });
}, JOURNAL_PRUNE_INTERVAL_MS);

const desktops = createDesktops({ systemd: createSystemd(), runtimeDir: RUNTIME_DIR });
setInterval(() => {
  desktops.sweep().catch((error: unknown) => {
    log({ level: "warn", event: "desktop-sweep-failed", message: error instanceof Error ? error.message : "unknown error" });
  });
}, DESKTOP_SWEEP_INTERVAL_MS);

const browser = createBrowser({ desktops });
const calls = createCalls({
  journal,
  // Every tool holds the bot's desktop, so a long shell tool cannot lose the page that the bot left open.
  execute: async ({ botId, tool, signal }) => {
    const release = desktops.hold(botId);
    try {
      return await (isBrowserInvocation(tool)
        ? browser.execute({ botId, tool, signal })
        : executeSystemTool({ botId, tool, signal }));
    } finally {
      release();
    }
  },
});
connectLink({
  url: config.linkUrl,
  token: config.token,
  calls,
  openScreen: (streamId, botId) => {
    relayScreen({ linkUrl: config.linkUrl, token: config.token, streamId, acquire: () => desktops.acquire(botId) });
  },
  // The event can hold a password, so only the error's message reaches the log.
  onInput: (botId, event) => {
    browser.input(botId, event).catch((error: unknown) => {
      log({ level: "warn", event: "screen-input-failed", message: error instanceof Error ? error.message : "unknown error" });
    });
  },
});

// Exiting leaves any tool's journal entry as "started", which reads as interrupted.
process.on("SIGTERM", () => process.exit(0));
