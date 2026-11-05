import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDesktops,
  holderText,
  IDLE_STOP_MS,
  parseHolder,
  parseLiveSlots,
  SLOTS,
  type DesktopLease,
  type Desktops,
  type Slot,
  type Systemd,
} from "./desktops.ts";

class Killed extends Error {}

function fakeSystemd(runtimeDir: string) {
  const live = new Map<Slot, string>();
  const calls: string[] = [];
  let hook: ((call: string) => Promise<void> | void) | undefined;

  const call = async (name: string) => {
    calls.push(name);
    await hook?.(name);
  };
  const systemd: Systemd = {
    start: async (slot) => {
      await call(`start ${slot}`);
      if (!live.has(slot)) {
        const holder = parseHolder(await readFile(join(runtimeDir, `desktop-${slot}.env`), "utf8"));
        if (holder === null) {
          throw new Error("the unit has no bot to run");
        }
        live.set(slot, holder);
      }
    },
    stop: async (slot) => {
      await call(`stop ${slot}`);
      live.delete(slot);
    },
    liveSlots: async () => {
      await call("liveSlots");
      return [...live.keys()];
    },
  };
  return {
    systemd,
    live,
    calls,
    onCall: (next: (call: string) => Promise<void> | void) => {
      hook = next;
    },
  };
}

let runtimeDir: string;
let pid1: ReturnType<typeof fakeSystemd>;
let clock: number;

beforeEach(async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  runtimeDir = await mkdtemp(join(tmpdir(), "desktops-test-"));
  pid1 = fakeSystemd(runtimeDir);
  clock = 1_000_000;
});

function computerd(): Desktops {
  return createDesktops({ systemd: pid1.systemd, runtimeDir, now: () => clock });
}

const allHeld = /every screen on this computer is in use/;
const noBrowser = /no running browser/;

async function fillEverySlot(desktops: Desktops): Promise<DesktopLease[]> {
  const leases: DesktopLease[] = [];
  for (const slot of SLOTS) {
    leases.push(await desktops.acquire(`bot${slot}`));
    clock += 10;
  }
  return leases;
}

describe("a desktop for each bot", () => {
  it("gives bots that start together different slots, each running that bot's own browser", async () => {
    const desktops = computerd();
    const leases = await Promise.all(["a", "b", "c"].map((bot) => desktops.acquire(bot)));
    expect(new Set(leases.map((lease) => lease.slot)).size).toBe(3);
    expect(leases.map((lease) => pid1.live.get(lease.slot))).toEqual(["a", "b", "c"]);
  });

  it("derives a lease's ports from its slot", async () => {
    const lease = await computerd().acquire("a");
    expect(lease).toMatchObject({ slot: 1, cdpPort: 9301, vncPort: 5901 });
  });

  it("keeps a bot on its slot, and starts it on every acquire so that a lost part heals", async () => {
    const desktops = computerd();
    const first = await desktops.acquire("a");
    first.release();
    pid1.calls.length = 0;
    const second = await desktops.acquire("a");
    expect(second.slot).toBe(first.slot);
    expect(pid1.calls).toEqual([`start ${first.slot}`]);
  });

  it("brings a desktop back on the same slot when its display died", async () => {
    const desktops = computerd();
    const first = await desktops.acquire("a");
    first.release();
    pid1.live.delete(first.slot);
    const second = await desktops.acquire("a");
    expect(second.slot).toBe(first.slot);
    expect(pid1.live.get(first.slot)).toBe("a");
  });

  it("rejects a bot id that could not be a path or an environment value, and touches nothing", async () => {
    await expect(computerd().acquire("../root")).rejects.toThrow("cannot name a desktop");
    await expect(computerd().acquire("a\nBOT_ID=b")).rejects.toThrow("cannot name a desktop");
    expect(pid1.calls).toEqual([]);
  });

  describe("claiming a slot", () => {
    it("stops a stray on the slot before it writes, so a bot never gets another bot's browser", async () => {
      await writeFile(join(runtimeDir, "desktop-1.env"), holderText("stray", 1));
      pid1.live.set(1, "stray");
      const desktops = createDesktops({
        systemd: { ...pid1.systemd, liveSlots: async () => [] },
        runtimeDir,
        now: () => clock,
      });
      const lease = await desktops.acquire("a");
      expect(lease.slot).toBe(1);
      expect(pid1.live.get(1)).toBe("a");
    });

    it("writes the holder file only after the stop has returned", async () => {
      await writeFile(join(runtimeDir, "desktop-1.env"), holderText("old", 1));
      let holderDuringStop = "";
      pid1.onCall(async (call) => {
        if (call === "stop 1") {
          holderDuringStop = await readFile(join(runtimeDir, "desktop-1.env"), "utf8");
        }
      });
      await computerd().acquire("a");
      expect(parseHolder(holderDuringStop)).toBe("old");
      expect(parseHolder(await readFile(join(runtimeDir, "desktop-1.env"), "utf8"))).toBe("a");
    });

    it("writes nothing and answers no browser when the slot's stop fails, because it may still run another bot", async () => {
      await writeFile(join(runtimeDir, "desktop-1.env"), holderText("old", 1));
      pid1.onCall((call) => {
        if (call === "stop 1") {
          throw new Error("sudo failed");
        }
      });
      await expect(computerd().acquire("a")).rejects.toThrow(noBrowser);
      expect(parseHolder(await readFile(join(runtimeDir, "desktop-1.env"), "utf8"))).toBe("old");
    });

    it("leaves no temporary file behind", async () => {
      await computerd().acquire("a");
      expect(await readdir(runtimeDir)).toEqual(["desktop-1.env"]);
    });
  });

  describe("when computerd restarts", () => {
    it("finds the same slot for the same bot, without touching the desktop", async () => {
      const lease = await computerd().acquire("a");
      pid1.calls.length = 0;
      const after = computerd();
      expect((await after.acquire("a")).slot).toBe(lease.slot);
      expect(pid1.calls).toEqual(["liveSlots", `start ${lease.slot}`]);
    });

    it("stops a live slot whose holder file is missing, because nothing can say whose it is", async () => {
      pid1.live.set(3, "unknown");
      await computerd().sweep();
      expect(pid1.live.has(3)).toBe(false);
    });

    it("stops a live slot whose holder file does not name a safe bot", async () => {
      pid1.live.set(3, "unknown");
      await writeFile(join(runtimeDir, "desktop-3.env"), "BOT_ID=../root\n");
      await computerd().sweep();
      expect(pid1.live.has(3)).toBe(false);
    });

    it("ignores the holder file of a dead slot, and the slot is free", async () => {
      await writeFile(join(runtimeDir, "desktop-1.env"), holderText("gone", 1));
      const lease = await computerd().acquire("a");
      expect(lease.slot).toBe(1);
      expect(pid1.live.get(1)).toBe("a");
    });

    it("stops the second of two live slots that name one bot, because one profile cannot serve both", async () => {
      await writeFile(join(runtimeDir, "desktop-1.env"), holderText("a", 1));
      await writeFile(join(runtimeDir, "desktop-2.env"), holderText("a", 2));
      pid1.live.set(1, "a");
      pid1.live.set(2, "a");
      const lease = await computerd().acquire("a");
      expect(lease.slot).toBe(1);
      expect([...pid1.live.keys()]).toEqual([1]);
    });

    it("gives every recovered bot a full idle period", async () => {
      (await computerd().acquire("a")).release();
      clock += IDLE_STOP_MS - 1;
      const after = computerd();
      await after.sweep();
      clock += IDLE_STOP_MS - 1;
      await after.sweep();
      expect(pid1.live.size).toBe(1);
      clock += 1;
      await after.sweep();
      expect(pid1.live.size).toBe(0);
    });
  });

  describe("eviction", () => {
    it("takes the slot of the unheld bot that was used longest ago", async () => {
      const desktops = computerd();
      const leases = await fillEverySlot(desktops);
      leases.forEach((lease) => lease.release());
      clock += 10;
      (await desktops.acquire("bot1")).release();
      const lease = await desktops.acquire("bot9");
      expect(lease.slot).toBe(2);
      expect(pid1.live.get(2)).toBe("bot9");
      expect(pid1.live.get(1)).toBe("bot1");
    });

    it("never takes a held slot, whichever kind of hold it is", async () => {
      const desktops = computerd();
      const leases = await fillEverySlot(desktops);
      leases.slice(1).forEach((lease) => lease.release());
      desktops.hold("bot2");
      const lease = await desktops.acquire("bot9");
      expect(lease.slot).toBe(3);
      expect(pid1.live.get(1)).toBe("bot1");
      expect(pid1.live.get(2)).toBe("bot2");
    });

    it("rejects a ninth bot when all 8 are held, stops nothing, and works once one is free", async () => {
      const desktops = computerd();
      const leases = await fillEverySlot(desktops);
      pid1.calls.length = 0;
      await expect(desktops.acquire("bot9")).rejects.toThrow(allHeld);
      expect(pid1.calls).toEqual([]);
      leases[4]?.release();
      expect((await desktops.acquire("bot9")).slot).toBe(5);
    });

    it("gives a returning bot a new slot on the same profile name", async () => {
      const desktops = computerd();
      (await fillEverySlot(desktops)).forEach((lease) => lease.release());
      await desktops.acquire("bot9");
      const back = await desktops.acquire("bot1");
      expect(pid1.live.get(back.slot)).toBe("bot1");
      expect(back.slot).not.toBe(1);
    });
  });

  describe("idle stop", () => {
    it("stops a desktop after a full idle period, and not before", async () => {
      const desktops = computerd();
      (await desktops.acquire("a")).release();
      clock += IDLE_STOP_MS - 1;
      await desktops.sweep();
      expect(pid1.live.size).toBe(1);
      clock += 1;
      await desktops.sweep();
      expect(pid1.live.size).toBe(0);
    });

    it("keeps a desktop for as long as a lease on it is open", async () => {
      const desktops = computerd();
      const lease = await desktops.acquire("a");
      clock += IDLE_STOP_MS * 3;
      await desktops.sweep();
      expect(pid1.live.size).toBe(1);
      lease.release();
      await desktops.sweep();
      expect(pid1.live.size).toBe(1);
    });

    it("keeps a desktop through a long shell tool, and the idle period starts when the tool ends", async () => {
      const desktops = computerd();
      (await desktops.acquire("a")).release();
      const release = desktops.hold("a");
      clock += IDLE_STOP_MS * 2;
      await desktops.sweep();
      expect(pid1.live.size).toBe(1);
      release();
      clock += IDLE_STOP_MS - 1;
      await desktops.sweep();
      expect(pid1.live.size).toBe(1);
    });

    it("starts nothing for a hold on a bot with no desktop", async () => {
      const desktops = computerd();
      const release = desktops.hold("a");
      await desktops.sweep();
      release();
      expect(pid1.live.size).toBe(0);
      expect(pid1.calls.some((call) => call.startsWith("start"))).toBe(false);
    });

    it("counts a release once, however many times it is called", async () => {
      const desktops = computerd();
      (await desktops.acquire("a")).release();
      const first = desktops.hold("a");
      desktops.hold("a");
      first();
      first();
      clock += IDLE_STOP_MS;
      await desktops.sweep();
      expect(pid1.live.size).toBe(1);
    });

    it("makes a bot that returns during its stop wait for that stop", async () => {
      const desktops = computerd();
      (await desktops.acquire("a")).release();
      clock += IDLE_STOP_MS;
      let finishStop: () => void = () => {};
      pid1.onCall((call) => {
        if (call === "stop 1") {
          pid1.onCall(() => {});
          return new Promise<void>((done) => {
            finishStop = done;
          });
        }
      });
      const sweeping = desktops.sweep();
      await new Promise((done) => setTimeout(done, 5));
      let started = false;
      pid1.calls.length = 0;
      const returning = desktops.acquire("a").then((lease) => {
        started = true;
        return lease;
      });
      await new Promise((done) => setTimeout(done, 20));
      expect(started).toBe(false);
      expect(pid1.calls.filter((call) => call.startsWith("start"))).toEqual([]);
      finishStop();
      await Promise.all([returning, sweeping]);
      expect(started).toBe(true);
    });
  });

  describe("failures", () => {
    it("answers no browser where there is no systemd, and tries again on the next call", async () => {
      const desktops = createDesktops({
        runtimeDir,
        systemd: {
          liveSlots: async () => [],
          start: async () => {
            throw new Error("no such command");
          },
          stop: async () => {
            throw new Error("no such command");
          },
        },
      });
      await expect(desktops.acquire("a")).rejects.toThrow(noBrowser);
      await expect(desktops.acquire("a")).rejects.toThrow(noBrowser);
    });

    it("answers no browser when systemd cannot list slots, and recovers later", async () => {
      let broken = true;
      const desktops = createDesktops({
        runtimeDir,
        systemd: {
          ...pid1.systemd,
          liveSlots: () => (broken ? Promise.reject(new Error("timed out")) : pid1.systemd.liveSlots()),
        },
      });
      await expect(desktops.acquire("a")).rejects.toThrow(noBrowser);
      broken = false;
      expect((await desktops.acquire("a")).slot).toBe(1);
    });

    it("answers no browser and frees the slot when a start fails", async () => {
      pid1.onCall((call) => {
        if (call === "start 1") {
          pid1.onCall(() => {});
          throw new Error("a part failed");
        }
      });
      const desktops = computerd();
      await expect(desktops.acquire("a")).rejects.toThrow(noBrowser);
      expect(pid1.live.has(1)).toBe(false);
      expect((await desktops.acquire("a")).slot).toBe(1);
    });

    it("does not keep a hold after a failed acquire", async () => {
      pid1.onCall((call) => {
        if (call === "start 1") {
          throw new Error("a part failed");
        }
      });
      const desktops = computerd();
      await desktops.acquire("a").catch(() => {});
      pid1.onCall(() => {});
      (await desktops.acquire("b")).release();
      clock += IDLE_STOP_MS;
      await desktops.sweep();
      expect(pid1.live.size).toBe(0);
    });
  });

  describe("when computerd dies at any call", () => {
    type Moment = "before" | "after";

    function dyingSystemd(moment: Moment, dieAt: number): { systemd: Systemd; died: () => boolean } {
      let calls = 0;
      let dead = false;
      const wrap = <T>(effect: () => Promise<T>): Promise<T> => {
        if (dead) {
          return Promise.reject(new Killed());
        }
        const index = calls;
        calls += 1;
        if (index !== dieAt) {
          return effect();
        }
        dead = true;
        return moment === "before" ? Promise.reject(new Killed()) : effect().then(() => Promise.reject(new Killed()));
      };
      return {
        died: () => dead,
        systemd: {
          start: (slot) => wrap(() => pid1.systemd.start(slot)),
          stop: (slot) => wrap(() => pid1.systemd.stop(slot)),
          liveSlots: () => wrap(() => pid1.systemd.liveSlots()),
        },
      };
    }

    async function scenario(desktops: Desktops): Promise<void> {
      const a = await desktops.acquire("a");
      const b = await desktops.acquire("b");
      a.release();
      (await desktops.acquire("a")).release();
      clock += 1;
      const others = [];
      for (const bot of ["c", "d", "e", "f", "g", "h"]) {
        others.push(await desktops.acquire(bot));
      }
      (await desktops.acquire("i")).release();
      b.release();
      others.forEach((lease) => lease.release());
      clock += IDLE_STOP_MS;
      await desktops.sweep();
      (await desktops.acquire("a")).release();
    }

    function expectOneBrowserForEachBot(): void {
      const running = [...pid1.live.values()];
      expect(new Set(running).size).toBe(running.length);
      expect(running.length).toBeLessThanOrEqual(SLOTS.length);
    }

    it.each<Moment>(["before", "after"])("converges on a new instance when it dies %s each call", async (moment) => {
      let reached = 0;
      for (let dieAt = 0; ; dieAt += 1) {
        runtimeDir = await mkdtemp(join(tmpdir(), "desktops-kill-"));
        pid1 = fakeSystemd(runtimeDir);
        clock = 1_000_000;

        const dying = dyingSystemd(moment, dieAt);
        const first = createDesktops({ systemd: dying.systemd, runtimeDir, now: () => clock });
        await scenario(first).catch(() => {});
        if (!dying.died()) {
          reached = dieAt;
          break;
        }
        expectOneBrowserForEachBot();

        const second = computerd();
        await second.sweep();
        const leases = new Map<string, DesktopLease>();
        for (const bot of ["a", "b", "c"]) {
          const lease = await second.acquire(bot);
          leases.set(bot, lease);
          expect(pid1.live.get(lease.slot), `${moment} call ${dieAt}: ${bot} runs its own browser`).toBe(bot);
        }
        expect(new Set([...leases.values()].map((lease) => lease.slot)).size).toBe(3);
        expectOneBrowserForEachBot();

        leases.forEach((lease) => lease.release());
        clock += IDLE_STOP_MS * 2;
        await second.sweep();
        expect(pid1.live.size, `${moment} call ${dieAt}: everything idle stops`).toBe(0);
      }
      expect(reached).toBeGreaterThan(25);
    });
  });
});

describe("parseLiveSlots", () => {
  it("reads the slots whose display is active or activating, from systemctl's real output", () => {
    const output = [
      "computerd-xvfb@1.service loaded active   running    Bots desktop 1 display",
      "computerd-xvfb@2.service loaded activating start-post Bots desktop 2 display",
      "computerd-xvfb@3.service loaded deactivating stop-sigterm Bots desktop 3 display",
      "computerd-xvfb@4.service loaded failed   failed     Bots desktop 4 display",
      "computerd-xvfb@9.service loaded active   running    Bots desktop 9 display",
      "computerd-xvfb@8.service loaded active running Bots desktop 8 display",
      "",
    ].join("\n");
    expect(parseLiveSlots(output)).toEqual([1, 2, 8]);
  });

  it("reads nothing from empty output", () => {
    expect(parseLiveSlots("")).toEqual([]);
  });
});

describe("the holder file", () => {
  it("names the bot and the slot's ports, in the form a unit reads", () => {
    expect(holderText("abc123", 3)).toBe("BOT_ID=abc123\nCDP_PORT=9303\nVNC_PORT=5903\n");
    expect(parseHolder(holderText("abc123", 3))).toBe("abc123");
  });

  it("names no one when it is empty, cut short, or unsafe", () => {
    expect(parseHolder("")).toBeNull();
    expect(parseHolder("CDP_PORT=9301\n")).toBeNull();
    expect(parseHolder("BOT_ID=\n")).toBeNull();
    expect(parseHolder("BOT_ID=../root\n")).toBeNull();
    expect(parseHolder("BOT_ID=a b\n")).toBeNull();
  });
});
