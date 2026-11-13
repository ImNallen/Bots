// Run as root on the control VM, from /opt/bots: node --env-file=.env.local scripts/verify-reconcile.ts
// Kills the real orchestrator at each provisioning stage, then at each stage of a reset, and requires a test computer to converge anyway.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { ConvexHttpClient } from "convex/browser";
import type { Identity } from "../apps/orchestrator/src/auth.ts";
import { parseConfig } from "../apps/orchestrator/src/config.ts";
import { createProxmox, ProxmoxError, type VmConfig } from "../apps/orchestrator/src/proxmox.ts";
import { addressFor, vmidFor } from "../apps/orchestrator/src/reconcile.ts";
import { createService } from "../apps/orchestrator/src/service.ts";
import { createTokenIssuer } from "../apps/orchestrator/src/tokens.ts";

const TEMPLATE_VMID = 9000;
const CONTROL_VMID = 110;
const KILL_STAGES = ["cloning", "configuring", "filtering", "starting", "updating", "making-token", "registering", "connecting"];
// A reset destroys the old VM before it clones the new one, so its first stage is the removal.
const RESET_KILL_STAGES = ["removing", ...KILL_STAGES];
const POLL_MS = 100;
const STAGE_TIMEOUT_MS = 5 * 60 * 1000;
const RESET_TIMEOUT_MS = 10 * 60 * 1000;
const EXEC_TIMEOUT_MS = 30 * 1000;
// Under /var/lib, because a tmpfs such as /tmp or /run is empty after any restart and says nothing about the disk.
const MARKER_PATH = "/var/lib/verify-reset-marker";

const config = parseConfig(process.env);
if (config.proxmox === null) {
  console.error("This machine has no PROXMOX_ settings. Run infra/proxmox/create-provisioner-token.sh on the host.");
  process.exit(2);
}
const issuer = await createTokenIssuer(config);
const service = createService({ url: config.convexUrl, issuer });
const proxmox = createProxmox({
  url: config.proxmox.url,
  node: config.proxmox.node,
  token: config.proxmox.token,
  caPem: await readFile(config.proxmox.caFile, "utf8"),
});

type PoolSnapshot = Map<number, { config: VmConfig; running: boolean }>;

let failures = 0;
function report(ok: boolean, name: string, detail = ""): void {
  failures += ok ? 0 : 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail === "" ? "" : `: ${detail}`}`);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

async function computerOf(computerId: Id<"computers">) {
  const computers = await service.query(api.computers.desiredVms, {});
  return computers.find((computer) => computer.computerId === computerId);
}

// A user token lasts 60 minutes and a run can last longer, so every call as the owner signs its own.
async function asOwner(owner: Identity): Promise<ConvexHttpClient> {
  const client = new ConvexHttpClient(config.convexUrl);
  client.setAuth((await issuer.forUser(owner)).token);
  return client;
}

function killOrchestrator(): void {
  execFileSync("systemctl", ["kill", "--signal=KILL", "bots-orchestrator"]);
}

// A VM in the pool with no computer would be adopted by the next computer that takes its slot, and removal would destroy it.
async function assertNoStrayVms(): Promise<void> {
  const computers = await service.query(api.computers.desiredVms, {});
  const expected = new Set(computers.map((computer) => vmidFor(computer.desiredVm.slot)));
  const stray = (await proxmox.members()).filter((member) => member.vmid !== TEMPLATE_VMID && !expected.has(member.vmid));
  if (stray.length > 0) {
    console.error(`The pool holds VMs with no computer: ${stray.map((vm) => vm.vmid).join(", ")}. Declare their owners first.`);
    process.exit(2);
  }
}

async function poolSnapshot(): Promise<PoolSnapshot> {
  const snapshot: PoolSnapshot = new Map();
  for (const { vmid, running } of await proxmox.members()) {
    snapshot.set(vmid, { config: await proxmox.config(vmid), running });
  }
  return snapshot;
}

function poolChanges(before: PoolSnapshot, after: PoolSnapshot): string[] {
  const vmids = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b);
  return vmids.flatMap((vmid) => {
    const was = before.get(vmid);
    const is = after.get(vmid);
    if (was === undefined) return [`VM ${vmid} appeared`];
    if (is === undefined) return [`VM ${vmid} is gone`];
    const keys = [...new Set([...Object.keys(was.config), ...Object.keys(is.config)])];
    const changed = keys.filter((key) => !isDeepStrictEqual(was.config[key], is.config[key]));
    return [
      was.running === is.running ? "" : `VM ${vmid} ${is.running ? "started" : "stopped"}`,
      changed.length === 0 ? "" : `VM ${vmid} config changed in ${changed.join(" and ")}`,
    ].filter((change) => change !== "");
  });
}

async function waitForStage(computerId: Id<"computers">, wanted: (stage: string | undefined) => boolean): Promise<string | undefined> {
  const deadline = Date.now() + STAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const stage = (await computerOf(computerId))?.observedVm?.stage;
    if (wanted(stage)) {
      return stage;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`computer ${computerId} did not reach the stage in ${STAGE_TIMEOUT_MS / 1000} seconds`);
}

async function killAt(args: { computerId: Id<"computers">; killStage: string; order: string[] }): Promise<string | undefined> {
  const { computerId, killStage, order } = args;
  const killedAt = await waitForStage(computerId, (stage) => stage !== undefined && order.indexOf(stage) >= order.indexOf(killStage));
  killOrchestrator();
  return killedAt;
}

async function waitForAvailable(owner: Identity): Promise<void> {
  const deadline = Date.now() + RESET_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    const current = await (await asOwner(owner)).query(api.computers.current, {});
    if (current.kind === "available") {
      return;
    }
    last = current.kind === "resetting" ? `${current.stage}${current.detail === undefined ? "" : ` (${current.detail})`}` : current.kind;
    await sleep(1000);
  }
  throw new Error(`the reset did not finish in ${RESET_TIMEOUT_MS / 1000} seconds, and its last stage was ${last}`);
}

async function declareTestVm() {
  const login = `verify-reconcile-${randomBytes(4).toString("hex")}@example.invalid`;
  const owner: Identity = { subject: `tailscale:${login}`, email: login, displayName: login };
  const { computerId, slot } = await service.mutation(api.computers.declareVm, {
    ownerSubject: owner.subject,
    email: login,
    displayName: login,
    cores: 1,
    memoryMb: 1024,
    diskGb: 10,
  });
  return { computerId, slot, vmid: vmidFor(slot), owner };
}

async function vmProblems(args: { vmid: number; slot: number }): Promise<string[]> {
  const { vmid, slot } = args;
  const vmConfig = await proxmox.config(vmid);
  const entries = await proxmox.ipset(vmid);
  const options = await proxmox.firewallOptions(vmid);
  const running = (await proxmox.members()).find((member) => member.vmid === vmid)?.running === true;
  return [
    running ? "" : "not running",
    vmConfig.tags === "bots-user" ? "" : `tags ${String(vmConfig.tags)}`,
    Number(vmConfig.cores) === 1 ? "" : `cores ${String(vmConfig.cores)}`,
    Number(vmConfig.memory) === 1024 ? "" : `memory ${String(vmConfig.memory)}`,
    String(vmConfig.scsi0).includes("size=10G") ? "" : `disk ${String(vmConfig.scsi0)}`,
    String(vmConfig.net0).includes("bridge=botsvms") && String(vmConfig.net0).includes("firewall=1") ? "" : "network",
    entries?.length === 1 && entries[0] === addressFor(slot) ? "" : `address filter ${String(entries)}`,
    options.enable === 1 && options.ipfilter === 1 && options.macfilter === 1 ? "" : `firewall ${JSON.stringify(options)}`,
  ].filter((problem) => problem !== "");
}

async function scenario(killStage: string): Promise<void> {
  const { computerId, slot, vmid, owner } = await declareTestVm();
  const order = [...KILL_STAGES, "ready"];
  try {
    await killAndConverge({ computerId, slot, vmid, killStage, order });
  } finally {
    await removeAndConfirm({ computerId, ownerSubject: owner.subject, vmid });
  }
}

async function killAndConverge(args: {
  computerId: Id<"computers">;
  slot: number;
  vmid: number;
  killStage: string;
  order: string[];
}): Promise<void> {
  const { computerId, slot, vmid, killStage, order } = args;
  const killedAt = await killAt({ computerId, killStage, order });
  await waitForStage(computerId, (stage) => stage === "ready");
  const problems = await vmProblems({ vmid, slot });
  report(problems.length === 0, `killed at ${killedAt}, asked for ${killStage}: VM ${vmid} converged with its filters and connected`, problems.join(", "));
}

// One computer takes every reset, because a provisioning takes minutes and a reset of a reset computer is a case of its own.
async function resetScenario(): Promise<void> {
  const { computerId, slot, vmid, owner } = await declareTestVm();
  try {
    await waitForStage(computerId, (stage) => stage === "ready");
    const problems = await vmProblems({ vmid, slot });
    report(problems.length === 0, `VM ${vmid} converged with no kill, before its resets`, problems.join(", "));
    if (problems.length > 0) {
      return;
    }
    for (const [index, killStage] of RESET_KILL_STAGES.entries()) {
      const generation = index + 1;
      try {
        // The next reset would start from a broken computer, so the first failure ends the resets.
        if (!(await resetAndConverge({ computerId, owner, slot, vmid, killStage, generation }))) {
          return;
        }
      } catch (error) {
        report(false, `reset ${generation} of VM ${vmid}, asked for ${killStage}, stopped`, reasonOf(error));
        return;
      }
    }
  } finally {
    await removeAndConfirm({ computerId, ownerSubject: owner.subject, vmid });
  }
}

async function resetAndConverge(args: {
  computerId: Id<"computers">;
  owner: Identity;
  slot: number;
  vmid: number;
  killStage: string;
  generation: number;
}): Promise<boolean> {
  const { computerId, owner, slot, vmid, killStage, generation } = args;
  const marker = randomBytes(16).toString("hex");
  const written = await proxmox.exec(
    vmid,
    ["bash", "-c", `printf %s "$1" > ${MARKER_PATH} && sync && cat ${MARKER_PATH}`, "write-marker", marker],
    EXEC_TIMEOUT_MS,
  );
  assert(written.exitCode === 0 && written.stdout === marker, `the old disk did not keep the marker file ${MARKER_PATH}`);
  const oldHash = (await computerOf(computerId))?.tokenHash;
  assert(oldHash !== undefined, "the computer had no token before the reset");

  await (await asOwner(owner)).mutation(api.computers.reset, {});
  const requested = await (await asOwner(owner)).query(api.computers.current, {});
  const revoked = await computerOf(computerId);

  const killedAt = await killAt({ computerId, killStage, order: [...RESET_KILL_STAGES, "ready"] });
  await waitForAvailable(owner);

  const computer = await computerOf(computerId);
  const name = (await proxmox.config(vmid)).name;
  const probe = await proxmox.exec(vmid, ["bash", "-c", `if [ -e ${MARKER_PATH} ]; then echo present; else echo absent; fi`], EXEC_TIMEOUT_MS);
  const oldHolder = await service.query(api.computers.byTokenHash, { tokenHash: oldHash });
  const problems = [
    requested.kind === "resetting" ? "" : `${requested.kind} right after the request`,
    revoked !== undefined && revoked.tokenHash === undefined ? "" : "token not revoked right after the request",
    // Written out here, not imported, so the expected name does not come from the code under test.
    name === `bots-user-${vmid}-g${generation}` ? "" : `name ${String(name)}`,
    computer?.desiredVm.generation === generation ? "" : `generation ${String(computer?.desiredVm.generation)}`,
    computer?.desiredVm.slot === slot ? "" : `slot ${String(computer?.desiredVm.slot)}`,
    probe.exitCode === 0 && probe.stdout.trim() === "absent" ? "" : `marker file ${probe.stdout.trim() || "not checked"} on the new disk`,
    computer?.tokenHash !== undefined && computer.tokenHash !== oldHash ? "" : "no new token",
    oldHolder === null ? "" : "the old token still finds a computer",
    ...(await vmProblems({ vmid, slot })),
  ].filter((problem) => problem !== "");
  report(
    problems.length === 0,
    `reset ${generation}, killed at ${killedAt}, asked for ${killStage}: VM ${vmid} came back on a new disk with a new token and its filters`,
    problems.join(", "),
  );
  return problems.length === 0;
}

async function removeAndConfirm(args: { computerId: Id<"computers">; ownerSubject: string; vmid: number }): Promise<void> {
  const { computerId, ownerSubject, vmid } = args;
  try {
    await service.mutation(api.computers.removeVm, { ownerSubject });
  } catch (error) {
    // Convex refuses to remove a computer whose reset is pending, and nothing here may force it.
    report(
      false,
      `VM ${vmid} and its computer could not be removed. Run computers:removeVm for ${ownerSubject} when its reset ends, as infra/control-vm/README.md describes`,
      reasonOf(error),
    );
    return;
  }
  const deadline = Date.now() + STAGE_TIMEOUT_MS;
  while ((await computerOf(computerId)) !== undefined && Date.now() < deadline) {
    await sleep(1000);
  }
  const gone = (await computerOf(computerId)) === undefined && !(await proxmox.members()).some((member) => member.vmid === vmid);
  report(gone, `VM ${vmid} and its computer are gone after removal`);
}

await assertNoStrayVms();
const poolAtStart = await poolSnapshot();

await assert.rejects(proxmox.config(CONTROL_VMID), (error: unknown) => error instanceof ProxmoxError && error.status === 403);
report(true, `the token gets 403 on VM ${CONTROL_VMID}`);

for (const stage of KILL_STAGES) {
  try {
    await scenario(stage);
  } catch (error) {
    report(false, `the scenario for ${stage} stopped`, reasonOf(error));
  }
}

try {
  await resetScenario();
} catch (error) {
  report(false, "the reset scenario stopped", reasonOf(error));
}

try {
  const changes = poolChanges(poolAtStart, await poolSnapshot());
  report(changes.length === 0, `the ${poolAtStart.size} VMs that the pool held at the start are unchanged`, changes.join(", "));
} catch (error) {
  report(false, "the pool could not be read again", reasonOf(error));
}

console.log(failures === 0 ? "verify:reconcile passed" : `verify:reconcile failed with ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
