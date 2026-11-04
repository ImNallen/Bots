import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { callIdToFileStem, toolResult, type ToolResult } from "@bots/protocol";

export type JournalEntry =
  | { kind: "absent" }
  | { kind: "started" }
  | { kind: "finished"; result: ToolResult };

const META_SUFFIX = ".meta.json";
const RESULT_SUFFIX = ".result.json";
const TEMP_SUFFIX = ".tmp";

// Two records make a call: meta is durable before the tool starts, and result is durable before anyone hears the answer.
export type Journal = {
  read: (callId: string) => Promise<JournalEntry>;
  markStarted: (args: { callId: string; botId: string; toolName: string }) => Promise<void>;
  finish: (args: { callId: string; result: ToolResult }) => Promise<void>;
  prune: (args: { now: number; maxAgeMs: number }) => Promise<number>;
};

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function openJournal(args: { dir: string }): Promise<Journal> {
  const { dir } = args;
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const pathFor = (callId: string, suffix: string) => join(dir, `${callIdToFileStem(callId)}${suffix}`);

  async function syncDirectory(): Promise<void> {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function writeDurably(path: string, content: string): Promise<void> {
    const handle = await open(path, "w", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  return {
    async read(callId) {
      let raw: string;
      try {
        raw = await readFile(pathFor(callId, RESULT_SUFFIX), "utf8");
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
        const started = await stat(pathFor(callId, META_SUFFIX)).then(
          () => true,
          (statError: unknown) => {
            if (isMissing(statError)) {
              return false;
            }
            throw statError;
          },
        );
        return started ? { kind: "started" } : { kind: "absent" };
      }
      return { kind: "finished", result: toolResult.parse(JSON.parse(raw)) };
    },

    async markStarted({ callId, botId, toolName }) {
      await writeDurably(
        pathFor(callId, META_SUFFIX),
        JSON.stringify({ callId, botId, toolName, startedAt: Date.now() }),
      );
      await syncDirectory();
    },

    async finish({ callId, result }) {
      const finalPath = pathFor(callId, RESULT_SUFFIX);
      const tempPath = `${finalPath}${TEMP_SUFFIX}`;
      await writeDurably(tempPath, JSON.stringify(result));
      await rename(tempPath, finalPath);
      await syncDirectory();
    },

    async prune({ now, maxAgeMs }) {
      let pruned = 0;
      for (const name of await readdir(dir)) {
        const path = join(dir, name);
        const { mtimeMs } = await stat(path);
        if (name.endsWith(TEMP_SUFFIX) || now - mtimeMs > maxAgeMs) {
          await rm(path, { force: true });
          pruned += 1;
        }
      }
      return pruned;
    },
  };
}
