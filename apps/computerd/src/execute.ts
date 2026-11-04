import { spawn } from "node:child_process";
import { WORKSPACE_ROOT, createOutputCollector, type ToolInvocation, type ToolResult } from "@bots/protocol";
import type { ExecuteTool } from "./calls.ts";

const FILE_TOOL_TIMEOUT_SECONDS = 60;
// Output printed just before the exit is still in the pipe, but a surviving background child may hold the pipe open forever.
const DRAIN_AFTER_EXIT_MS = 250;
const EXIT_AFTER_KILL_MS = 5000;

// The workspace is created on demand and the path never touches a shell string, so a path needs no quoting.
const PREPARE = 'mkdir -p -- "$1" && cd -- "$1"';

const SCRIPTS: Record<ToolInvocation["name"], string> = {
  shell: `${PREPARE} && exec bash -c "$2"`,
  read_file: `${PREPARE} && exec cat -- "$2"`,
  write_file: `${PREPARE} && mkdir -p -- "$(dirname -- "$2")" && exec cat > "$2"`,
};

type Plan = { operand: string; stdin: string | null; timeoutSeconds: number };

function planFor(tool: ToolInvocation): Plan {
  switch (tool.name) {
    case "shell":
      return { operand: tool.args.command, stdin: null, timeoutSeconds: tool.args.timeoutSeconds };
    case "read_file":
      return { operand: tool.args.path, stdin: null, timeoutSeconds: FILE_TOOL_TIMEOUT_SECONDS };
    case "write_file":
      return { operand: tool.args.path, stdin: tool.args.content, timeoutSeconds: FILE_TOOL_TIMEOUT_SECONDS };
  }
}

function asAgent(argv: string[]): string[] {
  return ["-n", "-H", "-u", "agent", "--", ...argv];
}

// computerd cannot signal a process owned by agent, so the kill itself crosses sudo. The negative pid names the group.
function killGroup(pgid: number): void {
  const killer = spawn("sudo", asAgent(["bash", "-c", 'kill -KILL -- "-$1"', "kill", String(pgid)]), {
    stdio: "ignore",
  });
  killer.on("error", () => {});
}

export const executeTool: ExecuteTool = async ({ botId, tool, signal }) => {
  if (signal.aborted) {
    return { outcome: "cancelled", output: "The call was cancelled before it started.", truncated: false };
  }
  const plan = planFor(tool);
  const workspace = `${WORKSPACE_ROOT}/${botId}`;
  const collector = createOutputCollector();
  // detached makes the child the leader of a new process group, which every descendant joins by default.
  const child = spawn(
    "sudo",
    asAgent(["bash", "-c", SCRIPTS[tool.name], "computerd-tool", workspace, plan.operand]),
    { detached: true, stdio: [plan.stdin === null ? "ignore" : "pipe", "pipe", "pipe"] },
  );
  child.stdout?.on("data", collector.add);
  child.stderr?.on("data", collector.add);
  child.stdin?.on("error", () => {});
  child.stdin?.end(plan.stdin);

  let stopped: "timeout" | "cancelled" | null = null;
  let forceExit: NodeJS.Timeout | undefined;
  const { promise: exited, resolve: resolveExited } = Promise.withResolvers<number | null>();
  function stop(reason: "timeout" | "cancelled"): void {
    if (stopped !== null || child.pid === undefined) {
      return;
    }
    stopped = reason;
    killGroup(child.pid);
    forceExit = setTimeout(() => resolveExited(null), EXIT_AFTER_KILL_MS);
  }
  child.on("error", () => resolveExited(null));
  child.on("exit", (code) => resolveExited(code));
  const timeout = setTimeout(() => stop("timeout"), plan.timeoutSeconds * 1000);
  const onAbort = () => stop("cancelled");
  signal.addEventListener("abort", onAbort, { once: true });

  const exitCode = await exited;
  clearTimeout(timeout);
  clearTimeout(forceExit);
  signal.removeEventListener("abort", onAbort);
  await new Promise<void>((done) => {
    const drained = setTimeout(done, DRAIN_AFTER_EXIT_MS);
    child.once("close", () => {
      clearTimeout(drained);
      done();
    });
  });
  child.stdout?.destroy();
  child.stderr?.destroy();

  return resultFor({ tool, stopped, exitCode, collected: collector.finish() });
};

function resultFor(args: {
  tool: ToolInvocation;
  stopped: "timeout" | "cancelled" | null;
  exitCode: number | null;
  collected: { output: string; truncated: boolean };
}): ToolResult {
  const { tool, stopped, exitCode, collected } = args;
  const code = exitCode === null ? {} : { exitCode };
  if (stopped !== null) {
    return { outcome: stopped, ...collected, ...code };
  }
  if (exitCode !== 0) {
    return { outcome: "error", ...collected, ...code };
  }
  if (tool.name === "write_file") {
    const size = Buffer.byteLength(tool.args.content, "utf8");
    return { outcome: "ok", output: `Wrote ${size} bytes to ${tool.args.path}.`, truncated: false, ...code };
  }
  return { outcome: "ok", ...collected, ...code };
}
