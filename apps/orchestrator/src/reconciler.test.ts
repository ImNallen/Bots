import { getFunctionName } from "convex/server";
import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startReconciler } from "./reconciler.ts";
import type { Proxmox } from "./proxmox.ts";

const computerId = "computer" as Id<"computers">;
const ownerId = "owner" as Id<"users">;
const desiredVm = { slot: 1, generation: 1, removing: false, cores: 2, memoryMb: 2048, diskGb: 32 };
const commit = "c".repeat(40);
const config = { name: "bots-user-201-g1", cores: 2, memory: 2048, balloon: 0, onboot: 1, ipconfig0: "ip=10.77.0.21/24,gw=10.77.0.1", tags: "bots-user", net0: "bridge=botsvms,firewall=1", scsi0: "disk,size=32G" };
const firewall = { enable: 1, ipfilter: 1, macfilter: 1, policy_in: "DROP", policy_out: "ACCEPT", dhcp: 0, ndp: 0, radv: 0 };

function fixture() {
  const query = vi.fn().mockResolvedValue([{ computerId, ownerId, desiredVm, observedVm: { stage: "connecting", at: Date.now() }, tokenHash: "hash", computerdCommit: commit, hasActiveRun: false, removedBots: [] }]);
  const mutation = vi.fn().mockResolvedValue(null);
  const proxmox: Proxmox = {
    inspect: vi.fn().mockResolvedValue({ config, running: true }), config: vi.fn().mockResolvedValue(config),
    ipset: vi.fn().mockResolvedValue(["10.77.0.21"]), firewallOptions: vi.fn().mockResolvedValue(firewall),
    hasPendingChanges: vi.fn().mockResolvedValue(false), members: vi.fn().mockResolvedValue([]),
    clone: vi.fn(), setConfig: vi.fn(), resizeDisk: vi.fn(), createIpset: vi.fn(), addToIpset: vi.fn(), removeFromIpset: vi.fn(), setFirewallOptions: vi.fn(), start: vi.fn(), reboot: vi.fn(), stop: vi.fn(), destroy: vi.fn(), agentResponds: vi.fn(), exec: vi.fn(),
  };
  let connected = false;
  startReconciler({
    service: { query, mutation, subscribe: vi.fn() },
    link: { isConnected: (_owner, generation) => connected && generation === 1, disconnect: vi.fn(), openStream: vi.fn(), call: vi.fn(), sendBrowsingEnd: vi.fn() },
    proxmox, linkUrl: "ws://local", install: { commit, script: "unused" }, forgetScript: "unused", log: vi.fn(),
  });
  return { query, mutation, proxmox, connect: () => { connected = true; } };
}

afterEach(() => vi.useRealTimers());

describe("reset reconciliation fencing", () => {
  it("keeps reset pending after a token exists and completes only when the expected incarnation connects", async () => {
    vi.useFakeTimers();
    const test = fixture();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(test.mutation.mock.calls.some(([fn]) => getFunctionName(fn) === getFunctionName(api.computers.completeReset))).toBe(false);
    test.connect();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(test.mutation).toHaveBeenCalledWith(api.computers.completeReset, { computerId, generation: 1 });
    expect(test.proxmox.destroy).not.toHaveBeenCalled();
  });
  it("aborts before external work when a captured generation becomes stale", async () => {
    vi.useFakeTimers();
    const test = fixture();
    test.query.mockResolvedValueOnce(await test.query()).mockRejectedValueOnce(new Error("Stale computer generation"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(test.proxmox.inspect).not.toHaveBeenCalled();
    expect(test.proxmox.destroy).not.toHaveBeenCalled();
  });
  it("checks freshness after a wait before making the next external call", async () => {
    vi.useFakeTimers();
    const test = fixture();
    vi.mocked(test.proxmox.inspect).mockImplementation(async () => {
      test.query.mockRejectedValue(new Error("Stale computer generation"));
      return { config, running: true };
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(test.proxmox.inspect).toHaveBeenCalledOnce();
    expect(test.proxmox.config).not.toHaveBeenCalled();
    expect(test.proxmox.destroy).not.toHaveBeenCalled();
  });
});
