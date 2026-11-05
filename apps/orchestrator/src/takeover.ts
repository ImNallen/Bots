const POLL_MS = 1000;

// The state is in Convex, so a restarted runner pauses too. A failed read waits and asks again, because starting a tool
// while a person may be typing is the worse mistake. Only a lost lease or a cancel ends the wait early.
export async function waitWhileTakenOver(args: {
  until: () => Promise<number>;
  now: () => number;
  signals: AbortSignal[];
  onWait: () => void;
  pollMs?: number;
}): Promise<void> {
  const { until, now, signals, onWait, pollMs = POLL_MS } = args;
  let waiting = false;
  while (!signals.some((signal) => signal.aborted)) {
    let takenOver: boolean;
    try {
      takenOver = (await until()) > now();
    } catch {
      takenOver = true;
    }
    if (!takenOver) {
      return;
    }
    if (!waiting) {
      waiting = true;
      onWait();
    }
    // A take-over can last minutes, and a lease's signals outlive this wait, so each delay removes the listeners it added.
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        for (const signal of signals) {
          signal.removeEventListener("abort", finish);
        }
        resolve();
      };
      const timer = setTimeout(finish, pollMs);
      for (const signal of signals) {
        signal.addEventListener("abort", finish, { once: true });
      }
    });
  }
}
