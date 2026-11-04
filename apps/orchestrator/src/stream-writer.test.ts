import { describe, expect, it } from "vitest";
import { STREAM_WRITE_INTERVAL_MS, createStreamWriter } from "./stream-writer.ts";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("createStreamWriter", () => {
  it("writes at most once per interval, skips stale snapshots, and flushes the newest", async () => {
    const writes: { text: string; at: number }[] = [];
    const writer = createStreamWriter({
      write: async ({ text }) => {
        writes.push({ text, at: Date.now() });
      },
    });
    for (let index = 0; index < 60; index += 1) {
      writer.update({ text: `t${index}` });
      await sleep(10);
    }
    writer.update({ text: "last" });
    await writer.flush();
    expect(writes.at(-1)?.text).toBe("last");
    expect(writes.length).toBeLessThan(10);
    for (const [index, write] of writes.slice(1, -1).entries()) {
      expect(write.at - (writes[index]?.at ?? 0)).toBeGreaterThanOrEqual(STREAM_WRITE_INTERVAL_MS - 5);
    }
  });

  it("never runs two writes at once, and flush waits for the one in flight", async () => {
    let running = 0;
    let peak = 0;
    const seen: string[] = [];
    const writer = createStreamWriter({
      write: async ({ text }) => {
        running += 1;
        peak = Math.max(peak, running);
        await sleep(40);
        seen.push(text);
        running -= 1;
      },
    });
    writer.update({ text: "a" });
    await sleep(5);
    writer.update({ text: "b" });
    await writer.flush();
    expect(peak).toBe(1);
    expect(seen).toEqual(["a", "b"]);
    await sleep(STREAM_WRITE_INTERVAL_MS + 50);
    expect(seen).toEqual(["a", "b"]);
  });
});
