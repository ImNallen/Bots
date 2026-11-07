import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Link } from "./link.ts";
import { startRunner } from "./runner.ts";
import type { Service } from "./service.ts";

const POLL_MS = 5000;
const SPIN_LIMIT = 1000;

const UNAVAILABLE = { kind: "unavailable" };
const CLAIMED = { kind: "claimed", leaseToken: "t", threadId: "thread", botId: "bot", ownerId: "owner", cancelRequested: false, nextSeq: 0 };

function world() {
  const claims: string[] = [];
  let answer: (runId: string) => Promise<unknown> = async () => UNAVAILABLE;
  let polled: string[] = [];
  let listUpdate: (ids: string[]) => void = () => {};
  const service = {
    mutation: (fn: never, args: { runId: string }) => {
      expect(getFunctionName(fn)).toBe(getFunctionName(api.runs.claim));
      claims.push(args.runId);
      return claims.length > SPIN_LIMIT ? new Promise(() => {}) : answer(args.runId);
    },
    query: (fn: never) =>
      getFunctionName(fn) === getFunctionName(api.runs.listClaimable) ? Promise.resolve(polled) : Promise.reject(new Error("the attempt ends here")),
    subscribe: (_fn: never, _args: never, onUpdate: (ids: string[]) => void) => {
      listUpdate = onUpdate;
      return () => {};
    },
  } as unknown as Service;
  startRunner({ service, link: {} as Link, masterKey: Buffer.alloc(32), mistral: { baseUrl: "http://127.0.0.1:1", model: "m" }, ownerScope: "owner" as Id<"users">, log: () => {} });
  return {
    claims,
    answerWith: (next: typeof answer) => {
      answer = next;
    },
    queue: (ids: string[]) => {
      polled = ids;
      listUpdate(ids);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the runner's claims", () => {
  it("asks once for a refused run, and asks again only at each poll", async () => {
    const { claims, queue } = world();
    queue(["fenced"]);
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(claims).toEqual(["fenced"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(claims).toEqual(["fenced", "fenced"]);
    await vi.advanceTimersByTimeAsync(POLL_MS * 11);
    expect(claims).toHaveLength(13);
  });

  it("does not let two refused runs set each other off", async () => {
    const { claims, queue } = world();
    queue(["first", "second"]);
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(claims).toEqual(["first", "second"]);
  });

  it("asks again when the list changes", async () => {
    const { claims, queue } = world();
    queue(["fenced"]);
    await vi.advanceTimersByTimeAsync(1);
    queue(["fenced", "new"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(claims).toEqual(["fenced", "fenced", "new"]);
  });

  it("claims a run at the first poll after the fence ends", async () => {
    const { claims, queue, answerWith } = world();
    queue(["fenced"]);
    await vi.advanceTimersByTimeAsync(POLL_MS / 2);
    const won: string[] = [];
    answerWith(async (runId) => {
      won.push(runId);
      return won.length === 1 ? CLAIMED : UNAVAILABLE;
    });
    await vi.advanceTimersByTimeAsync(POLL_MS / 2);
    expect(won[0]).toBe("fenced");
    expect(claims[1]).toBe("fenced");
  });

  it("does not spin when the claim itself fails", async () => {
    const { claims, queue, answerWith } = world();
    answerWith(() => Promise.reject(new Error("the backend is down")));
    queue(["run"]);
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(claims).toEqual(["run"]);
  });

  it("reaches a run beyond the slots that refused runs held for a moment", async () => {
    const { claims, queue } = world();
    const ids = Array.from({ length: 9 }, (_, index) => `run${index}`);
    queue(ids);
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(claims).toEqual(ids);
  });

  it("gives a freed slot to the next queued run when a claimed run ends", async () => {
    const { claims, queue, answerWith } = world();
    const seen = new Set<string>();
    answerWith(async (runId) => {
      const first = !seen.has(runId);
      seen.add(runId);
      return first ? CLAIMED : UNAVAILABLE;
    });
    const ids = Array.from({ length: 9 }, (_, index) => `run${index}`);
    queue(ids);
    await vi.advanceTimersByTimeAsync(1);
    expect(claims.slice(0, 8)).toEqual(ids.slice(0, 8));
    expect(claims).toContain("run8");
  });
});
