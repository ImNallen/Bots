// Replays stored runs through historyOf and reports what each real model call sent against what this code would send for the same
// call, and how much of what it sent Mistral's prompt cache served. It prints counts only, never an event's text.
//
// Export the two tables from a deployment first, on the machine that holds its admin key, oldest first:
//   cd packages/convex
//   pnpm exec convex data runs --limit 8000 --order asc --format jsonl > <dir>/runs.jsonl
//   pnpm exec convex data runEvents --limit 8000 --order asc --format jsonl > <dir>/runEvents.jsonl
// Then:
//   node scripts/context-report.ts <dir>
import { readFileSync } from "node:fs";
import type { Doc } from "@bots/convex/dataModel";
import { historyOf, threadEventOf } from "../apps/orchestrator/src/history.ts";

type Run = Pick<Doc<"runs">, "_id" | "_creationTime" | "threadId" | "capability">;
type Event = Pick<Doc<"runEvents">, "runId" | "threadId" | "seq" | "body" | "_creationTime">;

const dir = process.argv[2];
if (dir === undefined) {
  console.error("usage: node scripts/context-report.ts <dir with runs.jsonl and runEvents.jsonl>");
  process.exit(2);
}

function rows<T>(name: string): T[] {
  return readFileSync(`${dir}/${name}.jsonl`, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

const runs = new Map(rows<Run>("runs").map((run) => [run._id, run]));
const events = rows<Event>("runEvents").filter((event) => runs.has(event.runId));

type Call = { runId: string; capability: Run["capability"]; real: number; cached: number | undefined; storedBytes: number; sentBytes: number };
const calls: Call[] = [];

for (const threadEvents of Map.groupBy(events, (event) => event.threadId).values()) {
  const created = (event: Event) => runs.get(event.runId)?._creationTime ?? 0;
  threadEvents.sort((a, b) => created(a) - created(b) || a.seq - b.seq);
  for (const [index, event] of threadEvents.entries()) {
    if (event.body.kind !== "assistantTurn") {
      continue;
    }
    const capability = runs.get(event.runId)?.capability ?? "full";
    const readByCall = threadEvents.slice(0, index).filter((seen) => capability === "full" || seen.runId === event.runId);
    const history = historyOf(readByCall.map(threadEventOf));
    const { promptTokens, cachedTokens } = event.body.usage;
    calls.push({ runId: event.runId, capability, real: promptTokens, cached: cachedTokens, storedBytes: history.storedBytes, sentBytes: history.sentBytes });
  }
}

function fit(points: readonly { x: number; y: number }[]) {
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const spread = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  const slope = spread === 0 ? 0 : points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / spread;
  const intercept = meanY - slope * meanX;
  const meanError = points.reduce((sum, point) => sum + Math.abs(point.y - (intercept + slope * point.x)), 0) / points.length;
  return { slope, intercept, meanError };
}

const whole = (value: number) => Math.round(value).toLocaleString("en-US");
const share = (part: number, total: number) => (total === 0 ? "n/a" : `${((100 * part) / total).toFixed(1)}%`);
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

for (const capability of ["full", "readOnly"] as const) {
  const mine = calls.filter((call) => call.capability === capability);
  if (mine.length === 0) {
    continue;
  }
  const line = fit(mine.map((call) => ({ x: call.storedBytes, y: call.real })));
  const now = (call: Call) => Math.max(call.real - (call.storedBytes - call.sentBytes) * line.slope, 0);
  const realSum = sum(mine.map((call) => call.real));
  const nowSum = sum(mine.map(now));
  const counted = mine.flatMap((call) => (call.cached === undefined ? [] : [{ cached: call.cached, real: call.real }]));
  const countedSum = sum(counted.map((call) => call.real));
  console.log(`\n${capability === "full" ? "Chat runs" : "Routine runs"}: ${mine.length} model calls in ${new Set(mine.map((call) => call.runId)).size} runs`);
  console.log(`  fit: prompt tokens = ${whole(line.intercept)} + stored bytes / ${line.slope === 0 ? "n/a" : (1 / line.slope).toFixed(2)}, mean error ${whole(line.meanError)} tokens`);
  console.log(`  prompt tokens, real:       sum ${whole(realSum).padStart(11)}   largest call ${whole(Math.max(...mine.map((call) => call.real))).padStart(8)}`);
  console.log(`  prompt tokens, this code:  sum ${whole(nowSum).padStart(11)}   largest call ${whole(Math.max(...mine.map(now))).padStart(8)}   (estimate, ${share(nowSum, realSum)} of real)`);
  console.log(`  prompt tokens, cached:     ${share(sum(counted.map((call) => call.cached)), countedSum)} of ${whole(countedSum)} in the ${counted.length} calls that reported a count`);
  console.log(`                             ${mine.length - counted.length} calls reported no count`);
  console.log("  each run: calls, real sum, estimated sum with this code");
  for (const [runId, runCalls] of Map.groupBy(mine, (call) => call.runId)) {
    console.log(`    ${runId.slice(-6)}  ${String(runCalls.length).padStart(3)}  ${whole(sum(runCalls.map((call) => call.real))).padStart(11)}  ${whole(sum(runCalls.map(now))).padStart(11)}`);
  }
}
