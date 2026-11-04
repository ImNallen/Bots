import type { StreamSnapshot } from "./mistral.ts";

export const STREAM_WRITE_INTERVAL_MS = 250;

export type StreamWriter = {
  update: (snapshot: StreamSnapshot) => void;
  flush: () => Promise<void>;
};

// One write at a time and only the newest snapshot, so a slow backend skips frames instead of queueing them.
export function createStreamWriter(args: {
  write: (snapshot: StreamSnapshot) => Promise<void>;
}): StreamWriter {
  let latest: StreamSnapshot | null = null;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let lastWriteAt = 0;

  function writeLatest(): void {
    timer = null;
    if (latest === null || inFlight !== null) {
      return;
    }
    const snapshot = latest;
    latest = null;
    lastWriteAt = Date.now();
    inFlight = args.write(snapshot).finally(() => {
      inFlight = null;
      schedule();
    });
  }

  function schedule(): void {
    if (timer !== null || inFlight !== null || latest === null) {
      return;
    }
    timer = setTimeout(writeLatest, Math.max(lastWriteAt + STREAM_WRITE_INTERVAL_MS - Date.now(), 0));
  }

  return {
    update(snapshot) {
      latest = snapshot;
      schedule();
    },
    async flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await inFlight;
      if (latest !== null) {
        const snapshot = latest;
        latest = null;
        lastWriteAt = Date.now();
        await args.write(snapshot);
      }
    },
  };
}
