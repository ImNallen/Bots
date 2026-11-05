import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { log } from "./log.ts";

export const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type Slot = (typeof SLOTS)[number];

// Everything about a slot derives from its number, here. The display number is the unit's %i, and computerd never needs it.
export type Desktop = { slot: Slot; cdpPort: number; vncPort: number };

export function desktopOf(slot: Slot): Desktop {
  return { slot, cdpPort: 9300 + slot, vncPort: 5900 + slot };
}

// A lease keeps its desktop running. Nothing stops or evicts a desktop while a lease on it is open.
export type DesktopLease = Desktop & { release: () => void };

export type Desktops = {
  // Returns once this bot's desktop answers, whatever state it was in. It starts the desktop, or heals one that lost a part,
  // or returns at once. Rejects with "this computer has no running browser" where there is no systemd, as in Docker on a Mac,
  // and with a message that a bot can act on when every desktop is in use.
  acquire: (botId: string) => Promise<DesktopLease>;
  // Keeps a bot's desktop alive and never starts one, so a long shell tool cannot lose the page it left open. Returns release.
  hold: (botId: string) => () => void;
  // Stops every desktop that has been idle too long. main.ts calls this on a timer, as it does journal pruning.
  sweep: () => Promise<void>;
};

// Memory is the only reason to stop a desktop, and the cap of 8 already bounds it. A pending approval has no signal here, so a
// long limit keeps its page in most cases. A page that does go fails closed through the stale ref error.
export const IDLE_STOP_MS = 60 * 60 * 1000;

const NO_BROWSER = "this computer has no running browser";
const ALL_IN_USE = "every screen on this computer is in use, so try again in a few minutes";
// A bot id becomes a path and an environment value.
const SAFE_BOT_ID = /^[a-z0-9]+$/i;

export type Claim = {
  slot: Slot;
  lastUsed: number;
  // Settles when the slot is dead and its holder file names this bot. Later acquires wait on the same promise.
  ready: Promise<void>;
};

export type SlotChoice = { kind: "free"; slot: Slot } | { kind: "evict"; botId: string; slot: Slot } | { kind: "full" };

// A free slot if one exists, or else the claim with no holds that was used longest ago. A held claim is never chosen.
export function pickSlot(claims: ReadonlyMap<string, Claim>, holds: ReadonlyMap<string, number>): SlotChoice {
  const taken = new Set([...claims.values()].map((claim) => claim.slot));
  const free = SLOTS.find((slot) => !taken.has(slot));
  if (free !== undefined) {
    return { kind: "free", slot: free };
  }
  const oldest = [...claims.entries()]
    .filter(([botId]) => !holds.has(botId))
    .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0];
  return oldest === undefined ? { kind: "full" } : { kind: "evict", botId: oldest[0], slot: oldest[1].slot };
}

export function idleBots(claims: ReadonlyMap<string, Claim>, holds: ReadonlyMap<string, number>, now: number): string[] {
  return [...claims.entries()]
    .filter(([botId, claim]) => !holds.has(botId) && now - claim.lastUsed >= IDLE_STOP_MS)
    .map(([botId]) => botId);
}

// The one record of who holds a slot. PID 1 reads it as root at each start of a unit, so it needs no wider mode. It lives in
// /run, so it dies with the processes it describes, at a reboot.
export function holderText(botId: string, slot: Slot): string {
  const { cdpPort, vncPort } = desktopOf(slot);
  return `BOT_ID=${botId}\nCDP_PORT=${cdpPort}\nVNC_PORT=${vncPort}\n`;
}

export function parseHolder(text: string): string | null {
  const botId = /^BOT_ID=(.*)$/m.exec(text)?.[1];
  return botId !== undefined && SAFE_BOT_ID.test(botId) ? botId : null;
}

export function createDesktops(args: { systemd: Systemd; runtimeDir: string; now?: () => number }): Desktops {
  const { systemd, runtimeDir, now = Date.now } = args;
  const claims = new Map<string, Claim>();
  const holds = new Map<string, number>();
  // Every stop stays here until it ends, and every claim waits for the set. So a bot that comes back during its own stop finds
  // its profile unlocked, and no slot needs a "stopping" state.
  const stopping = new Set<Promise<void>>();
  let loaded: Promise<void> | null = null;

  function holderFile(slot: Slot): string {
    return join(runtimeDir, `desktop-${slot}.env`);
  }

  function stopSlot(slot: Slot): Promise<void> {
    const stop = systemd.stop(slot);
    const settled: Promise<void> = stop.catch(() => {}).finally(() => stopping.delete(settled));
    stopping.add(settled);
    return stop;
  }

  function stopInBackground(slot: Slot): void {
    stopSlot(slot).catch((error: unknown) => warn("desktop-stop-failed", error));
  }

  // A restart resets the idle clocks and the holds. That errs toward keeping a desktop, and a restart ended every viewer.
  async function recover(): Promise<void> {
    for (const slot of await systemd.liveSlots()) {
      const holder = parseHolder(await readFile(holderFile(slot), "utf8").catch(() => ""));
      if (holder === null || claims.has(holder)) {
        stopInBackground(slot);
      } else {
        claims.set(holder, { slot, lastUsed: now(), ready: Promise.resolve() });
      }
    }
  }

  // Callers share one promise, so two bots that start together see one recovery. A failure can pass, so the next caller tries again.
  function load(): Promise<void> {
    loaded ??= recover().catch((error: unknown) => {
      loaded = null;
      throw error;
    });
    return loaded;
  }

  // The claim ritual. Each step is safe to repeat and safe to die after. A failed stop ends it, because a write now could name
  // this bot on another bot's running browser.
  async function prepare(slot: Slot, botId: string): Promise<void> {
    await stopSlot(slot);
    await Promise.all(stopping);
    const file = holderFile(slot);
    await writeFile(`${file}.tmp`, holderText(botId, slot), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }

  // This has no await, so two bots that start together cannot take one slot.
  function claimSlot(botId: string): Claim | null {
    const choice = pickSlot(claims, holds);
    if (choice.kind === "full") {
      return null;
    }
    if (choice.kind === "evict") {
      log({ level: "info", event: "desktop-evicted", botId: choice.botId, slot: choice.slot });
      claims.delete(choice.botId);
    }
    const claim = { slot: choice.slot, lastUsed: now(), ready: prepare(choice.slot, botId) };
    claims.set(botId, claim);
    return claim;
  }

  function hold(botId: string): () => void {
    holds.set(botId, (holds.get(botId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const left = (holds.get(botId) ?? 1) - 1;
      if (left === 0) {
        holds.delete(botId);
      } else {
        holds.set(botId, left);
      }
      const claim = claims.get(botId);
      if (claim !== undefined) {
        claim.lastUsed = now();
      }
    };
  }

  return {
    hold,
    acquire: async (botId) => {
      if (!SAFE_BOT_ID.test(botId)) {
        throw new Error("this bot's id cannot name a desktop");
      }
      const release = hold(botId);
      let claim: Claim | null | undefined;
      try {
        await load();
        claim = claims.get(botId) ?? claimSlot(botId);
        if (claim !== null) {
          await claim.ready;
          // On every acquire. This one call is all the health checking computerd does.
          await systemd.start(claim.slot);
          return { ...desktopOf(claim.slot), release };
        }
      } catch (error) {
        warn("desktop-start-failed", error);
        release();
        if (claim && claims.get(botId) === claim) {
          claims.delete(botId);
          stopInBackground(claim.slot);
        }
        throw new Error(NO_BROWSER);
      }
      release();
      throw new Error(ALL_IN_USE);
    },
    sweep: async () => {
      await load();
      for (const botId of idleBots(claims, holds, now())) {
        const claim = claims.get(botId) as Claim;
        claims.delete(botId);
        log({ level: "info", event: "desktop-idle-stop", botId, slot: claim.slot });
        stopInBackground(claim.slot);
      }
      await Promise.all(stopping);
    },
  };
}

function warn(event: string, error: unknown): void {
  log({ level: "warn", event, message: error instanceof Error ? error.message : "unknown error" });
}

// The only code that knows unit names or how to reach systemd. Tests replace it with a fake.
export type Systemd = {
  // Starts the target. Returns when each part has finished its start, and a part's own readiness check is in its unit.
  start: (slot: Slot) => Promise<void>;
  // Stops the display. Everything is bound to it, and a stop returns after Chromium has exited, so its profile and ports are free.
  stop: (slot: Slot) => Promise<void>;
  liveSlots: () => Promise<Slot[]>;
};

// A client that outlives this has lost PID 1, or a part is stuck. Longer than a part's own start timeout.
const SYSTEMCTL_TIMEOUT_MS = 75_000;
const run = promisify(execFile);

export function createSystemd(): Systemd {
  async function sudoSystemctl(verb: "start" | "stop", unit: string): Promise<void> {
    await run("sudo", ["-n", "/usr/bin/systemctl", verb, "--quiet", unit], { timeout: SYSTEMCTL_TIMEOUT_MS });
  }
  return {
    start: (slot) => sudoSystemctl("start", `computerd-desktop@${slot}.target`),
    stop: (slot) => sudoSystemctl("stop", `computerd-xvfb@${slot}.service`),
    liveSlots: async () => {
      try {
        const { stdout } = await run("systemctl", ["list-units", "--plain", "--no-legend", "--no-pager", "computerd-xvfb@*"], {
          timeout: SYSTEMCTL_TIMEOUT_MS,
        });
        return parseLiveSlots(stdout);
      } catch (error) {
        // Docker on a Mac has no systemctl, so nothing is live and any claim fails at its stop.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }
    },
  };
}

// A slot is live when its display is active or activating. Deactivating counts as dead, because a new claim waits for the stop
// anyway. A failed or unexpected line is ignored.
export function parseLiveSlots(listUnitsOutput: string): Slot[] {
  const slots: Slot[] = [];
  for (const line of listUnitsOutput.split("\n")) {
    const match = /^computerd-xvfb@(\d+)\.service\s+\S+\s+(?:active|activating)\s/.exec(line);
    const slot = SLOTS.find((candidate) => String(candidate) === match?.[1]);
    if (slot !== undefined) {
      slots.push(slot);
    }
  }
  return slots;
}
