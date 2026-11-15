import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNS_URL =
  "https://api.github.com/repos/ImNallen/Bots/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=1";
const MARKER = ".deployed-commit";

export type Green = {
  commit: string;
  onMain: boolean;
  deployedContains: boolean;
  changed: readonly string[];
};

export type Inputs = {
  deployed: string | null;
  tip: string;
  green: Green | null;
};

export type Decision =
  | { kind: "deploy"; commit: string }
  | { kind: "up-to-date" }
  | { kind: "wait"; reason: string }
  | { kind: "skip"; commit: string; reason: string };

const isDocs = (path: string) => path.startsWith("docs/") || path.endsWith(".md");
const short = (commit: string) => commit.slice(0, 7);

export function decide({ deployed, tip, green }: Inputs): Decision {
  if (deployed === tip) return { kind: "up-to-date" };
  if (green === null) return { kind: "wait", reason: "main has no successful CI run" };
  if (!green.onMain) return { kind: "wait", reason: `green ${short(green.commit)} is not on main` };
  if (deployed === null) return { kind: "deploy", commit: green.commit };
  if (green.deployedContains) return { kind: "wait", reason: `no green commit is newer than ${short(deployed)}` };
  if (green.changed.every(isDocs)) return { kind: "skip", commit: green.commit, reason: "only docs changed" };
  return { kind: "deploy", commit: green.commit };
}

function run(args: string[]) {
  return spawnSync("git", args, { encoding: "utf8" });
}

function git(...args: string[]): string {
  const result = run(args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function isAncestor(ancestor: string, descendant: string): boolean {
  const { status, stderr } = run(["merge-base", "--is-ancestor", ancestor, descendant]);
  if (status === 0 || status === 1) return status === 0;
  throw new Error(`git merge-base failed: ${stderr.trim()}`);
}

function parseCommit(value: unknown, source: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) throw new Error(`${source} is not a commit: ${String(value)}`);
  return value;
}

function readMarker(): string | null {
  try {
    return parseCommit(readFileSync(MARKER, "utf8").trim(), MARKER);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function writeMarker(commit: string) {
  writeFileSync(`${MARKER}.tmp`, `${commit}\n`);
  renameSync(`${MARKER}.tmp`, MARKER);
}

async function newestGreen(): Promise<string | null> {
  const response = await fetch(RUNS_URL, {
    headers: { accept: "application/vnd.github+json", "user-agent": "bots-deploy" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as { workflow_runs?: { head_sha?: unknown }[] };
  const latest = body.workflow_runs?.[0];
  return latest === undefined ? null : parseCommit(latest.head_sha, "head_sha");
}

async function gather(): Promise<Inputs> {
  const deployed = readMarker();
  const remoteTip = parseCommit(git("ls-remote", "origin", "refs/heads/main").split("\t")[0], "origin main");
  // An idle VM makes no API call, because GitHub allows 60 anonymous calls an hour per IP.
  if (remoteTip === deployed) return { deployed, tip: remoteTip, green: null };

  const commit = await newestGreen();
  git("fetch", "--quiet", "origin");
  const tip = git("rev-parse", "origin/main").trim();
  if (commit === null) return { deployed, tip, green: null };
  if (run(["cat-file", "-e", `${commit}^{commit}`]).status !== 0) {
    return { deployed, tip, green: { commit, onMain: false, deployedContains: false, changed: [] } };
  }
  return {
    deployed,
    tip,
    green: {
      commit,
      onMain: isAncestor(commit, tip),
      deployedContains: deployed !== null && isAncestor(commit, deployed),
      changed: deployed === null ? [] : git("diff", "--name-only", deployed, commit).split("\n").filter(Boolean),
    },
  };
}

function describe(decision: Decision): string {
  switch (decision.kind) {
    case "deploy":
      return `deploy ${short(decision.commit)}`;
    case "up-to-date":
      return "up to date";
    case "wait":
      return `wait, ${decision.reason}`;
    case "skip":
      return `skip ${short(decision.commit)}, ${decision.reason}`;
  }
}

function deploy(commit: string) {
  const dir = mkdtempSync(join(tmpdir(), "bots-deploy-"));
  try {
    const script = join(dir, "deploy.sh");
    writeFileSync(script, git("show", `${commit}:infra/control-vm/deploy.sh`));
    const { status } = spawnSync("bash", [script, "main", commit], { stdio: "inherit" });
    if (status !== 0) throw new Error(`deploy.sh exited with ${status} for ${short(commit)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const inputs = await gather();
  const decision = decide(inputs);
  const deployed = inputs.deployed === null ? "nothing" : short(inputs.deployed);
  const green = inputs.green === null ? "" : `, green ${short(inputs.green.commit)}`;
  console.log(`${describe(decision)} (deployed ${deployed}, main ${short(inputs.tip)}${green})`);
  if (!process.argv.includes("--dry-run")) {
    if (decision.kind === "deploy") deploy(decision.commit);
    if (decision.kind === "skip") writeMarker(decision.commit);
  }
}
