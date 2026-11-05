import { isBrowserInvocation } from "@bots/protocol";
import { createBrowser } from "./browser.ts";
import { createCalls } from "./calls.ts";
import { parseConfig } from "./config.ts";
import { executeSystemTool } from "./execute.ts";
import { openJournal } from "./journal.ts";
import { connectLink } from "./link.ts";
import { log } from "./log.ts";
import { relayScreen } from "./screens.ts";

const JOURNAL_DIR = "/var/lib/computerd/journal";
const SCREENS_FILE = "/var/lib/computerd/screens.json";
const CDP_BASE_URL = "http://127.0.0.1:9222";
const JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const JOURNAL_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

const browser = createBrowser({ cdpBaseUrl: CDP_BASE_URL, stateFile: SCREENS_FILE });
const calls = createCalls({
  journal,
  execute: ({ botId, tool, signal }) =>
    isBrowserInvocation(tool)
      ? browser.execute({ botId, tool, signal })
      : executeSystemTool({ botId, tool, signal }),
});
connectLink({
  url: config.linkUrl,
  token: config.token,
  calls,
  openScreen: (streamId, botId) => {
    relayScreen({ linkUrl: config.linkUrl, token: config.token, streamId, regionFor: () => browser.regionFor(botId) });
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
