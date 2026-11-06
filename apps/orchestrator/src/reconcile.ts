import type { Proxmox, VmConfig } from "./proxmox.ts";

const TEMPLATE_VMID = 9000;
const VM_TAG = "bots-user";
const TOKEN_TIMEOUT_MS = 30 * 1000;
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
// Shorter than the fence in computers.ts, so computerd is back before a run can be claimed again.
const ACTIVATE_TIMEOUT_MS = 40 * 1000;
// A browser that ignores SIGTERM holds a stop for 10 seconds, and a VM has at most 8 of them.
const FORGET_TIMEOUT_MS = 2 * 60 * 1000;
// Longer than a VM takes to boot and connect, so a slow start is not mistaken for a broken computerd.
const REPAIR_AFTER_MS = 2 * 60 * 1000;
const FIREWALL_OPTIONS = {
  enable: 1,
  ipfilter: 1,
  macfilter: 1,
  policy_in: "DROP",
  policy_out: "ACCEPT",
  dhcp: 0,
  ndp: 0,
  radv: 0,
} as const;

// The VM makes its token, so only the hash ever leaves it. A rerun keeps the token.
const TOKEN_SCRIPT = `set -eu
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
env_file=/etc/computerd/env
if [ ! -f "$env_file" ]; then
  umask 077
  mkdir -p /etc/computerd
  token=$(head -c 32 /dev/urandom | base64 --wrap=0 | tr '+/' '-_' | tr -d '=')
  printf 'COMPUTER_LINK_URL=%s\\nCOMPUTER_TOKEN=%s\\n' "$1" "$token" > "$env_file.tmp"
  mv "$env_file.tmp" "$env_file"
fi
systemctl start computerd
sed -n 's/^COMPUTER_TOKEN=//p' "$env_file" | tr -d '\\n' | sha256sum | cut -d' ' -f1
`;

export type DesiredVm = {
  slot: number;
  cores: number;
  memoryMb: number;
  diskGb: number;
  removing: boolean;
};

export type Stage =
  | "cloning"
  | "configuring"
  | "filtering"
  | "starting"
  | "restarting"
  | "waiting-for-lock"
  | "waiting-for-agent"
  | "updating"
  | "repairing"
  | "making-token"
  | "registering"
  | "connecting"
  | "ready"
  | "removing"
  | "removed";

export function vmidFor(slot: number): number {
  return 200 + slot;
}

export function addressFor(slot: number): string {
  return `10.77.0.${20 + slot}`;
}

function nameFor(vmid: number): string {
  return `bots-user-${vmid}`;
}

function diskSizeGb(config: VmConfig): number {
  const match = /size=(\d+)([GT])/.exec(String(config.scsi0 ?? ""));
  if (match === null) {
    throw new Error(`VM config has no readable scsi0 size: ${String(config.scsi0)}`);
  }
  return Number(match[1]) * (match[2] === "T" ? 1024 : 1);
}

// A VM with the right number and the wrong name is someone else's, so nothing here may change it.
function assertOurs(vmid: number, config: VmConfig): void {
  if (config.name !== nameFor(vmid) || config.template === 1) {
    throw new Error(`VM ${vmid} is named ${String(config.name)}, so it is not this computer's VM`);
  }
}

async function converge(args: {
  proxmox: Proxmox;
  vmid: number;
  address: string;
  desired: DesiredVm;
  report: (stage: Stage) => Promise<void>;
}): Promise<void> {
  const { proxmox, vmid, address, desired, report } = args;

  const config = await proxmox.config(vmid);
  const ipconfig0 = `ip=${address}/24,gw=10.77.0.1`;
  const wanted: Record<string, string | number> = {
    tags: VM_TAG,
    cores: desired.cores,
    memory: desired.memoryMb,
    balloon: 0,
    // No startup order, because setting one needs Sys.Modify on the whole host. Proxmox starts VMs with no order after VM 110.
    onboot: 1,
    ipconfig0,
  };
  const changes = Object.fromEntries(Object.entries(wanted).filter(([key, value]) => String(config[key]) !== String(value)));
  const growDisk = diskSizeGb(config) < desired.diskGb;
  if (Object.keys(changes).length > 0 || growDisk) {
    await report("configuring");
  }
  if (Object.keys(changes).length > 0) {
    await proxmox.setConfig(vmid, changes);
  }
  if (growDisk) {
    await proxmox.resizeDisk(vmid, desired.diskGb);
  }

  const net0 = String(config.net0 ?? "");
  if (!net0.includes("bridge=botsvms") || !net0.includes("firewall=1")) {
    throw new Error(`VM ${vmid} has the wrong network, so it must not start: ${net0.replace(/=[0-9A-Fa-f:]{17}/, "")}`);
  }
  const entries = await proxmox.ipset(vmid);
  const options = await proxmox.firewallOptions(vmid);
  const optionsHold = Object.entries(FIREWALL_OPTIONS).every(([key, value]) => String(options[key]) === String(value));
  if (optionsHold && entries?.length === 1 && entries[0] === address) {
    return;
  }
  await report("filtering");
  if (entries === null) {
    await proxmox.createIpset(vmid);
  }
  for (const cidr of entries ?? []) {
    if (cidr !== address) {
      await proxmox.removeFromIpset(vmid, cidr);
    }
  }
  if (!entries?.includes(address)) {
    await proxmox.addToIpset(vmid, address);
  }
  if (!optionsHold) {
    await proxmox.setFirewallOptions(vmid, { ...FIREWALL_OPTIONS });
  }
}

async function assertFiltersHold(proxmox: Proxmox, vmid: number, address: string): Promise<void> {
  const entries = await proxmox.ipset(vmid);
  const options = await proxmox.firewallOptions(vmid);
  if (entries?.length !== 1 || entries[0] !== address || options.enable !== 1 || options.ipfilter !== 1 || options.macfilter !== 1) {
    throw new Error(`VM ${vmid} does not hold its firewall filters, so it must not start`);
  }
}

// Through the guest agent, so a bot's files go even from a VM whose computerd is older than this code.
// Returns the bots that are gone. A bot has root on that VM, so its answer can only ever name a bot that was asked about.
export async function forgetBots<T extends string>(args: { proxmox: Proxmox; vmid: number; script: string; botIds: T[] }): Promise<T[]> {
  const { proxmox, vmid, script, botIds } = args;
  const { stdout } = await proxmox.exec(vmid, ["bash", "-c", script, "forget-bots", ...botIds], FORGET_TIMEOUT_MS);
  const finished = new Set(stdout.split("\n"));
  return botIds.filter((botId) => finished.has(botId));
}

export async function reconcileVm(args: {
  proxmox: Proxmox;
  desired: DesiredVm;
  linkUrl: string;
  tokenHash: string | undefined;
  install: { commit: string; script: string };
  installedCommit: string | undefined;
  observed: { stage: string; at: number } | undefined;
  now: number;
  busy: boolean;
  report: (stage: Stage) => Promise<void>;
  recordToken: (tokenHash: string) => Promise<void>;
  recordCommit: (commit: string) => Promise<void>;
  fence: () => Promise<boolean>;
  releaseFence: () => Promise<void>;
  forget: () => Promise<void>;
  isConnected: () => boolean;
  disconnect: () => void;
}): Promise<Stage> {
  const { proxmox, desired, linkUrl, tokenHash, install, installedCommit, observed, now, busy } = args;
  const { report, recordToken, recordCommit, fence, releaseFence, forget, isConnected, disconnect } = args;
  const vmid = vmidFor(desired.slot);
  const address = addressFor(desired.slot);

  async function stopAt(stage: Stage): Promise<Stage> {
    await report(stage);
    return stage;
  }

  // This comes before any call that can fail or wait, so a locked VM or a Proxmox outage cannot keep a removed computer working.
  if (desired.removing) {
    disconnect();
  }

  let member = (await proxmox.members()).find((entry) => entry.vmid === vmid);

  if (desired.removing) {
    await report("removing");
    if (member !== undefined) {
      const config = await proxmox.config(vmid);
      assertOurs(vmid, config);
      if (config.lock !== undefined) {
        return stopAt("waiting-for-lock");
      }
      if (member.running) {
        await proxmox.stop(vmid);
      }
      await proxmox.destroy(vmid);
    }
    await forget();
    return "removed";
  }

  if (member === undefined) {
    await report("cloning");
    // A clone that outlived a killed orchestrator holds this VMID, so this fails and the next pass finds the finished VM.
    await proxmox.clone({ template: TEMPLATE_VMID, vmid, name: nameFor(vmid) });
    member = { vmid, running: false };
  }

  const config = await proxmox.config(vmid);
  assertOurs(vmid, config);
  // A lock is a normal state, because a backup, a clone, or a resize holds one. The next pass tries again.
  if (config.lock !== undefined) {
    return stopAt("waiting-for-lock");
  }

  await converge({ proxmox, vmid, address, desired, report });
  await assertFiltersHold(proxmox, vmid, address);

  if (!member.running) {
    await report("starting");
    await proxmox.start(vmid);
  } else if (await proxmox.hasPendingChanges(vmid)) {
    await report("restarting");
    await proxmox.reboot(vmid);
  }

  const needsUpdate = installedCommit !== install.commit;
  // A connected computer proved its token to the link, so a VM on the right version has nothing to do on this pass.
  if (tokenHash !== undefined && isConnected() && !needsUpdate) {
    return stopAt("ready");
  }
  // An update restarts computerd, which interrupts a running tool. The computer works meanwhile, so this waits for a quiet pass.
  if (isConnected() && busy) {
    return stopAt("ready");
  }
  // Changing the stage here would restart this clock on every pass, so a disconnected VM runs nothing until the clock runs out.
  const repairDue = !isConnected() && observed?.stage === "connecting" && now - observed.at > REPAIR_AFTER_MS;
  if (tokenHash !== undefined && !isConnected() && !needsUpdate && !repairDue) {
    return stopAt("connecting");
  }

  if (!(await proxmox.agentResponds(vmid))) {
    return stopAt("waiting-for-agent");
  }

  async function runInstall(mode: "build" | "activate" | "force", timeoutMs: number): Promise<void> {
    const installed = await proxmox.exec(
      vmid,
      ["bash", "-c", install.script, "install-computerd", install.commit, mode],
      timeoutMs,
    );
    const lastLine = installed.stdout.trim().split("\n").at(-1);
    if (installed.exitCode !== 0 || lastLine !== install.commit) {
      throw new Error(`VM ${vmid} could not ${mode} computerd ${install.commit}, and the script exited with ${installed.exitCode}`);
    }
  }

  if (needsUpdate) {
    await report("updating");
    await runInstall("build", BUILD_TIMEOUT_MS);
    // A run may have started during the build. Only the fence makes it safe to restart, and the built release keeps for the next pass.
    if (!(await fence())) {
      return stopAt(isConnected() ? "ready" : "connecting");
    }
    try {
      await runInstall("activate", ACTIVATE_TIMEOUT_MS);
      await recordCommit(install.commit);
    } finally {
      await releaseFence();
    }
  } else if (repairDue) {
    // A user has no SSH, and a bot cannot help once computerd is down, so only this can bring a broken computer back.
    await report("repairing");
    await runInstall("force", BUILD_TIMEOUT_MS);
  }

  await report("making-token");
  const result = await proxmox.exec(vmid, ["bash", "-c", TOKEN_SCRIPT, "make-token", linkUrl], TOKEN_TIMEOUT_MS);
  const hash = result.stdout.trim();
  if (result.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`VM ${vmid} could not make its token, and the script exited with ${result.exitCode}`);
  }

  if (hash !== tokenHash) {
    await report("registering");
    await recordToken(hash);
  }

  return stopAt(isConnected() ? "ready" : "connecting");
}
