// Run as root on the control VM, from /opt/bots: node --env-file=.env.local scripts/verify-reconcile.ts
// Kills the real orchestrator at each provisioning stage and requires a test computer to converge anyway.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { parseConfig } from "../apps/orchestrator/src/config.ts";
import { createProxmox, ProxmoxError } from "../apps/orchestrator/src/proxmox.ts";
import { addressFor, vmidFor } from "../apps/orchestrator/src/reconcile.ts";
import { createService } from "../apps/orchestrator/src/service.ts";
import { createTokenIssuer } from "../apps/orchestrator/src/tokens.ts";

const TEMPLATE_VMID = 9000;
const CONTROL_VMID = 110;
const KILL_STAGES = ["cloning", "configuring", "filtering", "starting", "updating", "making-token", "registering", "connecting"];
const POLL_MS = 100;
const STAGE_TIMEOUT_MS = 5 * 60 * 1000;

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

let failures = 0;
function report(ok: boolean, name: string, detail = ""): void {
  failures += ok ? 0 : 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail === "" ? "" : `: ${detail}`}`);
}

async function computerOf(computerId: Id<"computers">) {
  const computers = await service.query(api.computers.desiredVms, {});
  return computers.find((computer) => computer.computerId === computerId);
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

async function scenario(killStage: string): Promise<void> {
  const login = `verify-reconcile-${randomBytes(4).toString("hex")}@example.invalid`;
  const ownerSubject = `tailscale:${login}`;
  const { computerId, slot } = await service.mutation(api.computers.declareVm, {
    ownerSubject,
    email: login,
    displayName: login,
    cores: 1,
    memoryMb: 1024,
    diskGb: 10,
  });
  const vmid = vmidFor(slot);
  const order = [...KILL_STAGES, "ready"];
  try {
    await killAndConverge({ computerId, slot, vmid, killStage, order });
  } finally {
    await removeAndConfirm({ computerId, ownerSubject, vmid });
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
  const killedAt = await waitForStage(computerId, (stage) => stage !== undefined && order.indexOf(stage) >= order.indexOf(killStage));
  killOrchestrator();
  await waitForStage(computerId, (stage) => stage === "ready");

  const vmConfig = await proxmox.config(vmid);
  const entries = await proxmox.ipset(vmid);
  const options = await proxmox.firewallOptions(vmid);
  const running = (await proxmox.members()).find((member) => member.vmid === vmid)?.running === true;
  const problems = [
    running ? "" : "not running",
    vmConfig.tags === "bots-user" ? "" : `tags ${String(vmConfig.tags)}`,
    Number(vmConfig.cores) === 1 ? "" : `cores ${String(vmConfig.cores)}`,
    Number(vmConfig.memory) === 1024 ? "" : `memory ${String(vmConfig.memory)}`,
    String(vmConfig.scsi0).includes("size=10G") ? "" : `disk ${String(vmConfig.scsi0)}`,
    String(vmConfig.net0).includes("bridge=botsvms") && String(vmConfig.net0).includes("firewall=1") ? "" : "network",
    entries?.length === 1 && entries[0] === addressFor(slot) ? "" : `address filter ${String(entries)}`,
    options.enable === 1 && options.ipfilter === 1 && options.macfilter === 1 ? "" : `firewall ${JSON.stringify(options)}`,
  ].filter((problem) => problem !== "");
  report(problems.length === 0, `killed at ${killedAt}, asked for ${killStage}: VM ${vmid} converged with its filters and connected`, problems.join(", "));
}

async function removeAndConfirm(args: { computerId: Id<"computers">; ownerSubject: string; vmid: number }): Promise<void> {
  const { computerId, ownerSubject, vmid } = args;
  await service.mutation(api.computers.removeVm, { ownerSubject });
  const deadline = Date.now() + STAGE_TIMEOUT_MS;
  while ((await computerOf(computerId)) !== undefined && Date.now() < deadline) {
    await sleep(1000);
  }
  const gone = (await computerOf(computerId)) === undefined && !(await proxmox.members()).some((member) => member.vmid === vmid);
  report(gone, `VM ${vmid} and its computer are gone after removal`);
}

await assertNoStrayVms();

await assert.rejects(proxmox.config(CONTROL_VMID), (error: unknown) => error instanceof ProxmoxError && error.status === 403);
report(true, `the token gets 403 on VM ${CONTROL_VMID}`);

for (const stage of KILL_STAGES) {
  try {
    await scenario(stage);
  } catch (error) {
    report(false, `the scenario for ${stage} stopped`, error instanceof Error ? error.message : "unknown error");
  }
}

console.log(failures === 0 ? "verify:reconcile passed" : `verify:reconcile failed with ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
