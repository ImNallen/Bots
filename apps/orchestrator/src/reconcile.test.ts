import { describe, expect, it } from "vitest";
import type { Proxmox, VmConfig } from "./proxmox.ts";
import { addressFor, forgetBots, reconcileVm, vmidFor, type DesiredVm, type Stage } from "./reconcile.ts";

const HASH = "a".repeat(64);
const COMMIT = "c".repeat(40);
const NEW_COMMIT = "d".repeat(40);
const OTHER_HASH = "b".repeat(64);
const desired: DesiredVm = { slot: 1, cores: 4, memoryMb: 4096, diskGb: 32, removing: false };
const vmid = vmidFor(desired.slot);
const address = addressFor(desired.slot);

type FakeVm = {
  config: VmConfig;
  ipset: string[] | null;
  firewall: Record<string, string | number>;
  running: boolean;
  inPool: boolean;
  pendingChanges: boolean;
  agentUp: boolean;
  hasToken: boolean;
};

type World = {
  vms: Map<number, FakeVm>;
  tokenHash: string | undefined;
  installedCommit: string | undefined;
  observed: { stage: string; at: number } | undefined;
  forgotten: boolean;
  connected: boolean;
  busy: boolean;
  fenceRefused: boolean;
  fenced: boolean;
  now: number;
  log: string[];
  startsWithFilters: boolean[];
};

function newWorld(): World {
  return {
    vms: new Map(),
    tokenHash: undefined,
    installedCommit: undefined,
    observed: undefined,
    forgotten: false,
    connected: true,
    busy: false,
    fenceRefused: false,
    fenced: false,
    now: 1_000_000,
    log: [],
    startsWithFilters: [],
  };
}

function clonedVm(): FakeVm {
  return {
    config: {
      name: `bots-user-${vmid}`,
      net0: "virtio=BC:24:11:00:00:01,bridge=botsvms,firewall=1",
      scsi0: "local-lvm:vm-201-disk-0,size=8G",
      tags: "bots-template",
      cores: 2,
      memory: 2048,
      balloon: 0,
      ipconfig0: undefined,
    },
    ipset: ["10.77.0.2"],
    firewall: { enable: 1, ipfilter: 1, macfilter: 1 },
    running: false,
    inPool: true,
    pendingChanges: false,
    agentUp: false,
    hasToken: false,
  };
}

function vmIn(world: World, id: number): FakeVm {
  const vm = world.vms.get(id);
  if (vm === undefined) {
    throw new Error(`VM ${id} does not exist`);
  }
  return vm;
}

function fakeProxmox(world: World): Proxmox {
  return {
    members: async () =>
      [...world.vms.entries()].flatMap(([id, vm]) => (vm.inPool ? [{ vmid: id, running: vm.running }] : [])),
    clone: async ({ vmid: id }) => {
      world.log.push("clone");
      if (world.vms.has(id)) {
        throw new Error(`VM ${id} already exists`);
      }
      world.vms.set(id, clonedVm());
    },
    config: async (id) => ({ ...vmIn(world, id).config }),
    setConfig: async (id, fields) => {
      world.log.push("setConfig");
      const vm = vmIn(world, id);
      Object.assign(vm.config, fields);
      vm.pendingChanges = vm.running;
    },
    resizeDisk: async (id, sizeGb) => {
      world.log.push("resize");
      const vm = vmIn(world, id);
      vm.config.scsi0 = `local-lvm:vm-201-disk-0,size=${sizeGb}G`;
    },
    hasPendingChanges: async (id) => vmIn(world, id).pendingChanges,
    ipset: async (id) => (vmIn(world, id).ipset === null ? null : [...(vmIn(world, id).ipset ?? [])]),
    createIpset: async (id) => {
      vmIn(world, id).ipset = [];
    },
    addToIpset: async (id, cidr) => {
      vmIn(world, id).ipset?.push(cidr);
    },
    removeFromIpset: async (id, cidr) => {
      const vm = vmIn(world, id);
      vm.ipset = (vm.ipset ?? []).filter((entry) => entry !== cidr);
    },
    firewallOptions: async (id) => ({ ...vmIn(world, id).firewall }),
    setFirewallOptions: async (id, options) => {
      vmIn(world, id).firewall = { ...options };
    },
    start: async (id) => {
      world.log.push("start");
      const vm = vmIn(world, id);
      world.startsWithFilters.push(
        vm.ipset?.length === 1 && vm.ipset[0] === address && vm.firewall.ipfilter === 1 && vm.firewall.macfilter === 1,
      );
      vm.running = true;
      vm.agentUp = true;
    },
    reboot: async (id) => {
      world.log.push("reboot");
      vmIn(world, id).pendingChanges = false;
    },
    stop: async (id) => {
      world.log.push("stop");
      vmIn(world, id).running = false;
    },
    destroy: async (id) => {
      world.log.push("destroy");
      world.vms.delete(id);
    },
    agentResponds: async (id) => vmIn(world, id).agentUp,
    exec: async (id, command) => {
      if (command[3] === "install-computerd") {
        world.log.push(command[5] === "force" ? "repair" : String(command[5]));
        if (command[5] === "activate" && !world.fenced) {
          throw new Error("activate ran without the fence");
        }
        return { exitCode: 0, stdout: `some output\n${command[4]}\n` };
      }
      world.log.push("exec");
      vmIn(world, id).hasToken = true;
      return { exitCode: 0, stdout: `${HASH}\n` };
    },
  };
}

class Killed extends Error {}

// Every effect the logic has goes through here, so counting them lets a test stop the process between any two.
function withKill<T extends object>(target: T, shouldKill: (when: "before" | "after") => boolean): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      const value: unknown = Reflect.get(object, key, receiver);
      if (typeof value !== "function") {
        return value;
      }
      return async (...args: unknown[]) => {
        if (shouldKill("before")) {
          throw new Killed();
        }
        const result: unknown = await (value as (...inner: unknown[]) => unknown).apply(object, args);
        if (shouldKill("after")) {
          throw new Killed();
        }
        return result;
      };
    },
  });
}

async function pass(world: World, overrides: { proxmox?: Proxmox; want?: DesiredVm; commit?: string; effects?: (when: "before" | "after") => boolean } = {}): Promise<{ stage: Stage; stages: Stage[] }> {
  const stages: Stage[] = [];
  const effects = withKill(
    {
      report: async (stage: Stage) => {
        stages.push(stage);
        if (world.observed?.stage !== stage) {
          world.observed = { stage, at: world.now };
        }
      },
      recordCommit: async (commit: string) => {
        world.installedCommit = commit;
      },
      fence: async () => {
        world.log.push("fence");
        world.fenced = !world.fenceRefused;
        return world.fenced;
      },
      releaseFence: async () => {
        world.log.push("release");
        world.fenced = false;
      },
      recordToken: async (hash: string) => {
        world.log.push("recordToken");
        world.tokenHash = hash;
      },
      forget: async () => {
        world.forgotten = true;
      },
    },
    overrides.effects ?? (() => false),
  );
  const stage = await reconcileVm({
    proxmox: overrides.proxmox ?? fakeProxmox(world),
    desired: overrides.want ?? desired,
    linkUrl: "ws://10.78.0.2:8788",
    tokenHash: world.tokenHash,
    install: { commit: overrides.commit ?? COMMIT, script: "the install script" },
    installedCommit: world.installedCommit,
    observed: world.observed,
    now: world.now,
    busy: world.busy,
    report: effects.report,
    recordCommit: effects.recordCommit,
    fence: effects.fence,
    releaseFence: effects.releaseFence,
    recordToken: effects.recordToken,
    forget: effects.forget,
    isConnected: () => world.connected,
    disconnect: () => {
      world.log.push("disconnect");
      world.connected = false;
    },
  });
  return { stage, stages };
}

function expectConverged(world: World): void {
  const vm = vmIn(world, vmid);
  expect(vm.running).toBe(true);
  expect(vm.config).toMatchObject({
    tags: "bots-user",
    cores: 4,
    memory: 4096,
    balloon: 0,
    onboot: 1,
    ipconfig0: "ip=10.77.0.21/24,gw=10.77.0.1",
  });
  expect(String(vm.config.scsi0)).toContain("size=32G");
  expect(vm.ipset).toEqual([address]);
  expect(vm.firewall).toMatchObject({ enable: 1, ipfilter: 1, macfilter: 1, policy_in: "DROP", policy_out: "ACCEPT" });
  expect(world.tokenHash).toBe(HASH);
  expect(world.installedCommit).toBe(COMMIT);
}

describe("reconcileVm", () => {
  it("takes a missing VM to ready in one pass, with the filters in place before the start", async () => {
    const world = newWorld();
    const { stage, stages } = await pass(world);
    expect(stage).toBe("ready");
    expect(stages).toEqual(["cloning", "configuring", "filtering", "starting", "updating", "making-token", "registering", "ready"]);
    expectConverged(world);
    expect(world.startsWithFilters).toEqual([true]);
  });

  it("changes nothing on a pass over a converged VM", async () => {
    const world = newWorld();
    await pass(world);
    world.log.length = 0;
    const { stage, stages } = await pass(world);
    expect(stage).toBe("ready");
    expect(stages).toEqual(["ready"]);
    expect(world.log).toEqual([]);
  });

  for (const when of ["before", "after"] as const) {
    it(`converges when killed ${when} each call, with one clone, one start, and the filters first`, async () => {
      let checked = 0;
      for (let killAt = 0; ; killAt += 1) {
        const world = newWorld();
        let calls = 0;
        const shouldKill = (moment: "before" | "after") => moment === when && calls++ === killAt;
        const killable = withKill(fakeProxmox(world), shouldKill);
        let killed = false;
        try {
          await pass(world, { proxmox: killable, effects: shouldKill });
        } catch (error) {
          expect(error).toBeInstanceOf(Killed);
          killed = true;
        }
        const { stage } = await pass(world);
        expect(stage).toBe("ready");
        expectConverged(world);
        expect(world.log.filter((entry) => entry === "clone")).toHaveLength(1);
        expect(world.log.filter((entry) => entry === "start")).toHaveLength(1);
        expect(world.startsWithFilters.every(Boolean)).toBe(true);
        if (!killed) {
          break;
        }
        checked += 1;
      }
      // A fresh VM makes about 20 calls, so a low count means the kill stopped reaching them.
      expect(checked).toBeGreaterThan(15);
    });
  }

  it("fails on a clone that is still running, then finds the finished VM", async () => {
    const world = newWorld();
    world.vms.set(vmid, { ...clonedVm(), inPool: false, config: { ...clonedVm().config, lock: "clone" } });
    await expect(pass(world)).rejects.toThrow("already exists");
    const vm = vmIn(world, vmid);
    vm.inPool = true;
    delete vm.config.lock;
    expect((await pass(world)).stage).toBe("ready");
    expectConverged(world);
  });

  it("waits on a locked VM and changes nothing", async () => {
    const world = newWorld();
    world.vms.set(vmid, { ...clonedVm(), config: { ...clonedVm().config, lock: "backup" } });
    expect((await pass(world)).stage).toBe("waiting-for-lock");
    expect(world.log).toEqual([]);
  });

  it("refuses a VM with this number and another name", async () => {
    const world = newWorld();
    world.vms.set(vmid, { ...clonedVm(), config: { ...clonedVm().config, name: "somebody-else" } });
    await expect(pass(world)).rejects.toThrow("not this computer's VM");
    expect(world.log).toEqual([]);
  });

  it.each([
    ["the wrong bridge", "virtio=BC:24:11:00:00:01,bridge=vmbr0,firewall=1"],
    ["no firewall", "virtio=BC:24:11:00:00:01,bridge=botsvms"],
  ])("does not start a VM with %s", async (_name, net0) => {
    const world = newWorld();
    world.vms.set(vmid, { ...clonedVm(), config: { ...clonedVm().config, net0 } });
    await expect(pass(world)).rejects.toThrow("must not start");
    expect(world.log).not.toContain("start");
  });

  it("does not start a VM when the filters read back wrong", async () => {
    const world = newWorld();
    const proxmox: Proxmox = { ...fakeProxmox(world), firewallOptions: async () => ({ enable: 0, ipfilter: 1, macfilter: 1 }) };
    await expect(pass(world, { proxmox })).rejects.toThrow("must not start");
    expect(world.log).not.toContain("start");
  });

  it("repairs a filter that changes on a running VM", async () => {
    const world = newWorld();
    await pass(world);
    const vm = vmIn(world, vmid);
    vm.firewall.ipfilter = 0;
    vm.ipset = ["10.77.0.250"];
    const { stages } = await pass(world);
    expect(stages).toContain("filtering");
    expect(vm.firewall.ipfilter).toBe(1);
    expect(vm.ipset).toEqual([address]);
  });

  it("replaces the template's address in the filter", async () => {
    const world = newWorld();
    await pass(world);
    expect(vmIn(world, vmid).ipset).toEqual([address]);
    expect(vmIn(world, vmid).ipset).not.toContain("10.77.0.2");
  });

  it("restarts a running VM once when its size changes, and grows only", async () => {
    const world = newWorld();
    await pass(world);
    world.log.length = 0;
    const bigger = { ...desired, cores: 8, diskGb: 16 };
    const { stages } = await pass(world, { want: bigger });
    expect(stages).toContain("restarting");
    expect(world.log.filter((entry) => entry === "reboot")).toHaveLength(1);
    expect(world.log).not.toContain("resize");
    expect(String(vmIn(world, vmid).config.scsi0)).toContain("size=32G");
    world.log.length = 0;
    await pass(world, { want: bigger });
    expect(world.log).toEqual([]);
  });

  it("stops at connecting until the link has the computer", async () => {
    const world = newWorld();
    world.connected = false;
    expect((await pass(world)).stage).toBe("connecting");
    world.connected = true;
    expect((await pass(world)).stage).toBe("ready");
  });

  it("waits for the agent without making a token", async () => {
    const world = newWorld();
    const proxmox: Proxmox = { ...fakeProxmox(world), agentResponds: async () => false };
    expect((await pass(world, { proxmox })).stage).toBe("waiting-for-agent");
    expect(world.log).not.toContain("exec");
  });

  it("replaces a stored hash that does not match the VM", async () => {
    const world = newWorld();
    world.tokenHash = OTHER_HASH;
    world.connected = false;
    await pass(world);
    expect(world.tokenHash).toBe(HASH);
  });

  it.each([
    ["an exit code", { exitCode: 1, stdout: `${HASH}\n` }],
    ["output that is not a hash", { exitCode: 0, stdout: "COMPUTER_TOKEN=secret\n" }],
  ])("rejects %s and does not repeat the output", async (_name, result) => {
    const world = newWorld();
    const real = fakeProxmox(world);
    const proxmox: Proxmox = {
      ...real,
      exec: async (id, command, timeoutMs) => (command[3] === "make-token" ? result : real.exec(id, command, timeoutMs)),
    };
    const failure = pass(world, { proxmox });
    await expect(failure).rejects.toThrow("could not make its token");
    await expect(failure).rejects.not.toThrow("secret");
    expect(world.tokenHash).toBeUndefined();
  });

  describe("updates", () => {
    const fresh = async () => {
      const world = newWorld();
      await pass(world);
      world.log.length = 0;
      return world;
    };

    it("installs before the token on a new VM, so computerd starts on the right version", async () => {
      const world = newWorld();
      await pass(world);
      expect(world.log.indexOf("activate")).toBeLessThan(world.log.indexOf("exec"));
      expect(world.log.indexOf("start")).toBeLessThan(world.log.indexOf("build"));
    });

    it("builds, then fences, then activates, then releases", async () => {
      const world = await fresh();
      await pass(world, { commit: NEW_COMMIT });
      expect(world.log.slice(0, 4)).toEqual(["build", "fence", "activate", "release"]);
      expect(world.installedCommit).toBe(NEW_COMMIT);
      expect(world.fenced).toBe(false);
    });

    it("updates once when the commit changes, and then leaves the VM alone", async () => {
      const world = await fresh();
      await pass(world, { commit: NEW_COMMIT });
      world.log.length = 0;
      await pass(world, { commit: NEW_COMMIT });
      expect(world.log).toEqual([]);
    });

    it("keeps the token through an update", async () => {
      const world = await fresh();
      await pass(world, { commit: NEW_COMMIT });
      expect(world.log).not.toContain("recordToken");
      expect(world.tokenHash).toBe(HASH);
    });

    it("does not build while a run is active, and updates on the next quiet pass", async () => {
      const world = await fresh();
      world.busy = true;
      expect((await pass(world, { commit: NEW_COMMIT })).stage).toBe("ready");
      expect(world.log).toEqual([]);
      world.busy = false;
      await pass(world, { commit: NEW_COMMIT });
      expect(world.installedCommit).toBe(NEW_COMMIT);
    });

    it("does not restart when a run started during the build, and finishes on a later pass", async () => {
      const world = await fresh();
      world.fenceRefused = true;
      expect((await pass(world, { commit: NEW_COMMIT })).stage).toBe("ready");
      expect(world.log).toEqual(["build", "fence"]);
      expect(world.installedCommit).toBe(COMMIT);
      world.fenceRefused = false;
      await pass(world, { commit: NEW_COMMIT });
      expect(world.log).toContain("activate");
      expect(world.installedCommit).toBe(NEW_COMMIT);
    });

    it("releases the fence when activate fails", async () => {
      const world = await fresh();
      const real = fakeProxmox(world);
      const failing: Proxmox = {
        ...real,
        exec: async (id, command, timeoutMs) =>
          command[5] === "activate" ? { exitCode: 1, stdout: "" } : real.exec(id, command, timeoutMs),
      };
      await expect(pass(world, { proxmox: failing, commit: NEW_COMMIT })).rejects.toThrow("could not activate");
      expect(world.fenced).toBe(false);
      expect(world.installedCommit).toBe(COMMIT);
    });

    it.each(["build", "activate"])("does not record a commit when %s fails", async (mode) => {
      const world = await fresh();
      const real = fakeProxmox(world);
      const failing: Proxmox = {
        ...real,
        exec: async (id, command, timeoutMs) =>
          command[5] === mode ? { exitCode: 1, stdout: `${NEW_COMMIT}\n` } : real.exec(id, command, timeoutMs),
      };
      await expect(pass(world, { proxmox: failing, commit: NEW_COMMIT })).rejects.toThrow(`could not ${mode}`);
      expect(world.installedCommit).toBe(COMMIT);
    });

    it("does not record a commit that the script did not print", async () => {
      const world = await fresh();
      const real = fakeProxmox(world);
      const wrong: Proxmox = { ...real, exec: async () => ({ exitCode: 0, stdout: `${COMMIT}\n` }) };
      await expect(pass(world, { proxmox: wrong, commit: NEW_COMMIT })).rejects.toThrow("could not build");
      expect(world.installedCommit).toBe(COMMIT);
    });

    it.each(["build", "activate"])("converges when killed right after %s", async (mode) => {
      const world = await fresh();
      const real = fakeProxmox(world);
      const killing: Proxmox = {
        ...real,
        exec: async (id, command, timeoutMs) => {
          const result = await real.exec(id, command, timeoutMs);
          if (command[5] === mode) {
            throw new Killed(String(result.exitCode));
          }
          return result;
        },
      };
      await expect(pass(world, { proxmox: killing, commit: NEW_COMMIT })).rejects.toBeInstanceOf(Killed);
      expect(world.installedCommit).toBe(COMMIT);
      await pass(world, { commit: NEW_COMMIT });
      expect(world.installedCommit).toBe(NEW_COMMIT);
      expect(world.fenced).toBe(false);
    });
  });

  describe("repair", () => {
    const PASS_MS = 15_000;

    // The real loop passes every 15 seconds, so a stage that flaps between passes never grows old.
    async function passesFor(world: World, ms: number): Promise<Stage[]> {
      const stages: Stage[] = [];
      for (let elapsed = 0; elapsed < ms; elapsed += PASS_MS) {
        world.now += PASS_MS;
        stages.push(...(await pass(world)).stages);
      }
      return stages;
    }

    it("runs nothing on a VM that may just be connecting", async () => {
      const world = newWorld();
      world.connected = false;
      await pass(world);
      world.log.length = 0;
      const stages = await passesFor(world, 60_000);
      expect(world.log).toEqual([]);
      expect(new Set(stages)).toEqual(new Set(["connecting"]));
    });

    it("reinstalls computerd when a VM stays disconnected across real passes", async () => {
      const world = newWorld();
      world.connected = false;
      await pass(world);
      world.log.length = 0;
      await passesFor(world, 3 * 60_000);
      expect(world.log).toContain("repair");
    });

    it("waits again after a repair instead of repairing on every pass", async () => {
      const world = newWorld();
      world.connected = false;
      await pass(world);
      world.log.length = 0;
      await passesFor(world, 2 * 60_000 + PASS_MS * 2);
      const repairs = world.log.filter((entry) => entry === "repair").length;
      expect(repairs).toBe(1);
      world.log.length = 0;
      await passesFor(world, 60_000);
      expect(world.log).not.toContain("repair");
    });

    it("repairs a VM that was ready and then lost its connection", async () => {
      const world = newWorld();
      await pass(world);
      world.connected = false;
      world.log.length = 0;
      await passesFor(world, 3 * 60_000);
      expect(world.log).toContain("repair");
      expect(world.tokenHash).toBe(HASH);
    });

    it("does not repair a connected VM", async () => {
      const world = newWorld();
      await pass(world);
      world.log.length = 0;
      await passesFor(world, 10 * 60_000);
      expect(world.log).toEqual([]);
    });
  });

  describe("removal", () => {
    const removing = { ...desired, removing: true };

    it("stops and destroys the VM, then forgets the computer", async () => {
      const world = newWorld();
      await pass(world);
      expect((await pass(world, { want: removing })).stage).toBe("removed");
      expect(world.vms.has(vmid)).toBe(false);
      expect(world.forgotten).toBe(true);
    });

    it("forgets a computer whose VM is already gone", async () => {
      const world = newWorld();
      expect((await pass(world, { want: removing })).stage).toBe("removed");
      expect(world.log).not.toContain("destroy");
      expect(world.forgotten).toBe(true);
    });

    it("does not destroy a VM with another name", async () => {
      const world = newWorld();
      world.vms.set(vmid, { ...clonedVm(), config: { ...clonedVm().config, name: "somebody-else" } });
      await expect(pass(world, { want: removing })).rejects.toThrow("not this computer's VM");
      expect(world.vms.has(vmid)).toBe(true);
      expect(world.forgotten).toBe(false);
    });

    it("waits on a locked VM, with the computer already disconnected", async () => {
      const world = newWorld();
      world.vms.set(vmid, { ...clonedVm(), config: { ...clonedVm().config, lock: "backup" } });
      expect((await pass(world, { want: removing })).stage).toBe("waiting-for-lock");
      expect(world.log).toEqual(["disconnect"]);
      expect(world.connected).toBe(false);
    });

    it("disconnects the computer before stopping the VM", async () => {
      const world = newWorld();
      await pass(world);
      world.log.length = 0;
      await pass(world, { want: removing });
      expect(world.log).toEqual(["disconnect", "stop", "destroy"]);
    });

    it("disconnects the computer when Proxmox is down", async () => {
      const world = newWorld();
      await pass(world);
      const proxmox: Proxmox = {
        ...fakeProxmox(world),
        members: async () => {
          throw new Error("no route to host");
        },
      };
      await expect(pass(world, { proxmox, want: removing })).rejects.toThrow("no route");
      expect(world.connected).toBe(false);
    });

    it("finishes when killed after the destroy", async () => {
      const world = newWorld();
      await pass(world);
      const proxmox = withKill(fakeProxmox(world), () => world.vms.size === 0);
      await expect(pass(world, { proxmox, want: removing })).rejects.toBeInstanceOf(Killed);
      expect((await pass(world, { want: removing })).stage).toBe("removed");
      expect(world.forgotten).toBe(true);
    });
  });
});

describe("forgetBots", () => {
  function proxmoxPrinting(stdout: string, exitCode = 0) {
    const commands: string[][] = [];
    const proxmox = {
      exec: async (_vmid: number, command: string[]) => {
        commands.push(command);
        return { exitCode, stdout };
      },
    } as unknown as Proxmox;
    return { proxmox, commands };
  }

  it("passes the script and each id as separate arguments, so no id reaches a shell string", async () => {
    const { proxmox, commands } = proxmoxPrinting("a\nb\n");
    await expect(forgetBots({ proxmox, vmid: 201, script: "the script", botIds: ["a", "b"] })).resolves.toEqual(["a", "b"]);
    expect(commands).toEqual([["bash", "-c", "the script", "forget-bots", "a", "b"]]);
  });

  it("keeps a bot that the script did not finish, so one stuck bot holds back only itself", async () => {
    const { proxmox } = proxmoxPrinting("b\n", 1);
    await expect(forgetBots({ proxmox, vmid: 201, script: "s", botIds: ["a", "b"] })).resolves.toEqual(["b"]);
  });

  it("believes no id that it did not ask about, because a bot has root on that VM", async () => {
    const { proxmox } = proxmoxPrinting("someoneelse\n");
    await expect(forgetBots({ proxmox, vmid: 201, script: "s", botIds: ["a"] })).resolves.toEqual([]);
  });
});
