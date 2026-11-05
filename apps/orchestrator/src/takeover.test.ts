import { describe, expect, it } from "vitest";
import { waitWhileTakenOver } from "./takeover.ts";

function run(args: { until: () => Promise<number>; signals?: AbortSignal[]; now?: () => number }) {
  const waits: number[] = [];
  const done = waitWhileTakenOver({
    until: args.until,
    now: args.now ?? (() => 1000),
    signals: args.signals ?? [],
    onWait: () => waits.push(1),
    pollMs: 1,
  });
  return { done, waits };
}

describe("waitWhileTakenOver", () => {
  it("does not wait when nobody has taken over", async () => {
    const { done, waits } = run({ until: async () => 0 });
    await done;
    expect(waits).toEqual([]);
  });

  it("does not wait for a take-over that has expired", async () => {
    const { done, waits } = run({ until: async () => 999 });
    await done;
    expect(waits).toEqual([]);
  });

  it("waits until the owner releases, and reports the wait once", async () => {
    let answers = 0;
    const { done, waits } = run({
      until: async () => {
        answers += 1;
        return answers < 4 ? 5000 : 0;
      },
    });
    await done;
    expect(answers).toBe(4);
    expect(waits).toEqual([1]);
  });

  it("waits until a take-over expires, so a forgotten one cannot strand the bot", async () => {
    let time = 1000;
    let answers = 0;
    await waitWhileTakenOver({
      until: async () => {
        answers += 1;
        time += 100;
        return 1250;
      },
      now: () => time,
      signals: [],
      onWait: () => {},
      pollMs: 1,
    }).then(() => expect(answers).toBeGreaterThan(1));
  });

  it("keeps waiting when the state cannot be read, because a person may be typing", async () => {
    let answers = 0;
    const { done, waits } = run({
      until: async () => {
        answers += 1;
        if (answers < 3) {
          throw new Error("convex is down");
        }
        return 0;
      },
    });
    await done;
    expect(answers).toBe(3);
    expect(waits).toEqual([1]);
  });

  it("ends the wait when the run is cancelled", async () => {
    const cancel = new AbortController();
    const { done } = run({ until: async () => 5000, signals: [cancel.signal] });
    setTimeout(() => cancel.abort(), 5);
    await done;
  });

  it("does not ask at all when the run is already cancelled", async () => {
    const cancel = new AbortController();
    cancel.abort();
    let answers = 0;
    await run({
      until: async () => {
        answers += 1;
        return 5000;
      },
      signals: [cancel.signal],
    }).done;
    expect(answers).toBe(0);
  });
});
