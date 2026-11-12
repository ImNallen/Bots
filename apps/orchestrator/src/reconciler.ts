import { api } from "@bots/convex";
import type { Link } from "./link.ts";
import type { LogFields } from "./log.ts";
import type { Proxmox } from "./proxmox.ts";
import { forgetBots, reconcileVm, vmidFor } from "./reconcile.ts";
import type { Service } from "./service.ts";

const INTERVAL_MS = 15_000;
const MAX_DETAIL_CHARS = 500;

// One pass runs at a time, and a failure on one computer leaves the others to converge. Every failure retries on the next pass.
export function startReconciler(args: {
  service: Service;
  link: Link;
  proxmox: Proxmox;
  linkUrl: string;
  install: { commit: string; script: string };
  forgetScript: string;
  log: (fields: LogFields) => void;
}): void {
  const { service, link, proxmox, linkUrl, install, forgetScript, log } = args;

  async function pass(): Promise<void> {
    const computers = await service.query(api.computers.desiredVms, {});
    for (const computer of computers) {
      const { computerId, ownerId, tokenHash, desiredVm, observedVm, computerdCommit, hasActiveRun, removedBots } = computer;
      const generation = desiredVm.generation ?? 0;
      const captured = { computerId, generation };
      const check = async () => { await service.query(api.computers.checkGeneration, { ...captured, removing: desiredVm.removing }); };
      const guarded = new Proxy(proxmox, {
        get(target, key, receiver) {
          const value: unknown = Reflect.get(target, key, receiver);
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            await check();
            const result: unknown = await value.apply(target, args);
            await check();
            return result;
          };
        },
      });
      let reported = observedVm?.stage;
      const record = async (stage: string, detail?: string) => {
        if (stage !== reported || detail !== undefined) {
          log({ level: detail === undefined ? "info" : "warn", event: "vm-stage", computerId, vmid: vmidFor(desiredVm.slot), stage, detail });
          reported = stage;
          await service.mutation(api.computers.recordObservedVm, { ...captured, stage, detail });
        }
      };
      try {
        await check();
        if (!link.isConnected(ownerId, generation)) link.disconnect(ownerId);
        const stage = await reconcileVm({
          proxmox: guarded,
          desired: desiredVm,
          linkUrl,
          tokenHash,
          install,
          installedCommit: computerdCommit,
          observed: observedVm,
          now: Date.now(),
          busy: hasActiveRun,
          report: record,
          fence: async () => (await service.mutation(api.computers.fenceForUpdate, captured)).fenced,
          releaseFence: async () => {
            await service.mutation(api.computers.releaseUpdateFence, captured);
          },
          recordCommit: async (commit) => {
            await service.mutation(api.computers.recordComputerdCommit, { ...captured, commit });
          },
          recordToken: async (hash) => {
            await service.mutation(api.computers.recordVmToken, { ...captured, tokenHash: hash });
          },
          forget: async () => {
            await service.mutation(api.computers.forgetVm, captured);
          },
          isConnected: () => link.isConnected(ownerId, generation),
          disconnect: () => link.disconnect(ownerId),
        });
        if (stage === "ready" && link.isConnected(ownerId, generation)) await service.mutation(api.computers.completeReset, captured);
      } catch (error) {
        const detail = (error instanceof Error ? error.message : "unknown error").slice(0, MAX_DETAIL_CHARS);
        await record("failed", detail).catch((reportError: unknown) => {
          log({ level: "error", event: "vm-report-failed", computerId, message: String(reportError) });
        });
      }
      // Apart from the stage, because a VM that cannot do this still runs its bots. The rows stay, so the next pass tries again.
      if (removedBots.length > 0 && reported === "ready") {
        try {
          const forgotten = await forgetBots({ proxmox: guarded, vmid: vmidFor(desiredVm.slot), script: forgetScript, botIds: removedBots });
          await service.mutation(api.bots.recordForgotten, { ownerId, generation, botIds: forgotten });
          log({ level: "info", event: "bots-forgotten", computerId, count: forgotten.length });
          const stuck = removedBots.filter((botId) => !forgotten.includes(botId));
          if (stuck.length > 0) {
            log({ level: "warn", event: "bots-forget-stuck", computerId, botIds: stuck });
          }
        } catch (error) {
          log({ level: "warn", event: "bots-forget-failed", computerId, message: error instanceof Error ? error.message : "unknown error" });
        }
      }
    }
  }

  function schedule(): void {
    setTimeout(() => {
      pass()
        .catch((error: unknown) => {
          log({ level: "error", event: "reconcile-pass-failed", message: error instanceof Error ? error.message : "unknown error" });
        })
        .finally(schedule);
    }, INTERVAL_MS);
  }

  schedule();
}
