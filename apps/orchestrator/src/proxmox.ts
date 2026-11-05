import { request } from "node:https";

const TASK_POLL_MS = 1000;
const TASK_TIMEOUT_MS = 15 * 60 * 1000;
const EXEC_POLL_MS = 500;
const EXEC_TIMEOUT_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const POOL = "bots";
const IPSET = "ipfilter-net0";

export type Member = { vmid: number; running: boolean };
export type VmConfig = Record<string, string | number | undefined>;
export type FirewallOptions = Record<string, string | number | undefined>;
export type ExecResult = { exitCode: number; stdout: string };

// Everything the reconcile logic does to Proxmox, so that a test can kill it between any two calls.
export type Proxmox = {
  members: () => Promise<Member[]>;
  clone: (args: { template: number; vmid: number; name: string }) => Promise<void>;
  config: (vmid: number) => Promise<VmConfig>;
  setConfig: (vmid: number, fields: Record<string, string | number>) => Promise<void>;
  resizeDisk: (vmid: number, sizeGb: number) => Promise<void>;
  hasPendingChanges: (vmid: number) => Promise<boolean>;
  ipset: (vmid: number) => Promise<string[] | null>;
  createIpset: (vmid: number) => Promise<void>;
  addToIpset: (vmid: number, cidr: string) => Promise<void>;
  removeFromIpset: (vmid: number, cidr: string) => Promise<void>;
  firewallOptions: (vmid: number) => Promise<FirewallOptions>;
  setFirewallOptions: (vmid: number, options: Record<string, string | number>) => Promise<void>;
  start: (vmid: number) => Promise<void>;
  reboot: (vmid: number) => Promise<void>;
  stop: (vmid: number) => Promise<void>;
  destroy: (vmid: number) => Promise<void>;
  agentResponds: (vmid: number) => Promise<boolean>;
  exec: (vmid: number, command: string[]) => Promise<ExecResult>;
};

export class ProxmoxError extends Error {
  readonly status: number;
  constructor(args: { status: number; message: string }) {
    super(args.message);
    this.status = args.status;
  }
}

export function createProxmox(args: { url: string; node: string; token: string; caPem: string }): Proxmox {
  const base = new URL("/api2/json", args.url);
  const vmPath = (vmid: number) => `/nodes/${args.node}/qemu/${vmid}`;

  function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        `${base.href}${path}`,
        {
          method,
          ca: args.caPem,
          timeout: REQUEST_TIMEOUT_MS,
          headers: {
            Authorization: `PVEAPIToken=${args.token}`,
            ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              // Proxmox puts the reason in the status line. It names VMs and paths, never the token.
              reject(new ProxmoxError({ status, message: `${method} ${path}: ${status} ${res.statusMessage ?? ""}`.trim() }));
              return;
            }
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data: T };
            resolve(parsed.data);
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error(`${method} ${path}: timed out`)));
      req.on("error", reject);
      req.end(payload);
    });
  }

  async function waitForTask(upid: string | null): Promise<void> {
    if (upid === null) {
      return;
    }
    const deadline = Date.now() + TASK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const task = await call<{ status: string; exitstatus?: string }>(
        "GET",
        `/nodes/${args.node}/tasks/${encodeURIComponent(upid)}/status`,
      );
      if (task.status === "stopped") {
        if (task.exitstatus !== "OK") {
          throw new Error(`task ${upid} ended with: ${task.exitstatus ?? "no status"}`);
        }
        return;
      }
      await new Promise((done) => setTimeout(done, TASK_POLL_MS));
    }
    throw new Error(`task ${upid} did not end in ${TASK_TIMEOUT_MS / 1000} seconds`);
  }

  return {
    members: async () => {
      const pool = await call<{ members: Array<{ type: string; vmid?: number; status?: string }> }>("GET", `/pools/${POOL}`);
      return pool.members.flatMap((member) =>
        member.type === "qemu" && member.vmid !== undefined
          ? [{ vmid: member.vmid, running: member.status === "running" }]
          : [],
      );
    },
    clone: async ({ template, vmid, name }) => {
      await waitForTask(
        await call<string>("POST", `${vmPath(template)}/clone`, { newid: vmid, name, full: 1, pool: POOL }),
      );
    },
    config: (vmid) => call<VmConfig>("GET", `${vmPath(vmid)}/config`),
    setConfig: async (vmid, fields) => {
      await call<null>("PUT", `${vmPath(vmid)}/config`, fields);
    },
    resizeDisk: async (vmid, sizeGb) => {
      await waitForTask(await call<string | null>("PUT", `${vmPath(vmid)}/resize`, { disk: "scsi0", size: `${sizeGb}G` }));
    },
    hasPendingChanges: async (vmid) => {
      const rows = await call<Array<{ pending?: unknown; delete?: unknown }>>("GET", `${vmPath(vmid)}/pending`);
      return rows.some((row) => row.pending !== undefined || row.delete !== undefined);
    },
    ipset: async (vmid) => {
      try {
        const rows = await call<Array<{ cidr: string }>>("GET", `${vmPath(vmid)}/firewall/ipset/${IPSET}`);
        return rows.map((row) => row.cidr);
      } catch (error) {
        // Proxmox answers a missing set with 500 and a "no such IPSet" reason.
        if (error instanceof ProxmoxError && /no such ipset/i.test(error.message)) {
          return null;
        }
        throw error;
      }
    },
    createIpset: async (vmid) => {
      await call<null>("POST", `${vmPath(vmid)}/firewall/ipset`, { name: IPSET });
    },
    addToIpset: async (vmid, cidr) => {
      await call<null>("POST", `${vmPath(vmid)}/firewall/ipset/${IPSET}`, { cidr });
    },
    removeFromIpset: async (vmid, cidr) => {
      await call<null>("DELETE", `${vmPath(vmid)}/firewall/ipset/${IPSET}/${encodeURIComponent(cidr)}`);
    },
    firewallOptions: (vmid) => call<FirewallOptions>("GET", `${vmPath(vmid)}/firewall/options`),
    setFirewallOptions: async (vmid, options) => {
      await call<null>("PUT", `${vmPath(vmid)}/firewall/options`, options);
    },
    start: async (vmid) => {
      await waitForTask(await call<string>("POST", `${vmPath(vmid)}/status/start`, {}));
    },
    reboot: async (vmid) => {
      await waitForTask(await call<string>("POST", `${vmPath(vmid)}/status/reboot`, {}));
    },
    stop: async (vmid) => {
      await waitForTask(await call<string>("POST", `${vmPath(vmid)}/status/stop`, {}));
    },
    destroy: async (vmid) => {
      await waitForTask(await call<string>("DELETE", `${vmPath(vmid)}?purge=1&destroy-unreferenced-disks=1`));
    },
    agentResponds: async (vmid) => {
      try {
        await call<unknown>("POST", `${vmPath(vmid)}/agent/ping`, {});
        return true;
      } catch (error) {
        if (error instanceof ProxmoxError && error.status === 500) {
          return false;
        }
        throw error;
      }
    },
    exec: async (vmid, command) => {
      const { pid } = await call<{ pid: number }>("POST", `${vmPath(vmid)}/agent/exec`, { command });
      const deadline = Date.now() + EXEC_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const status = await call<{ exited: number; exitcode?: number; "out-data"?: string }>(
          "GET",
          `${vmPath(vmid)}/agent/exec-status?pid=${pid}`,
        );
        if (status.exited === 1) {
          return { exitCode: status.exitcode ?? -1, stdout: status["out-data"] ?? "" };
        }
        await new Promise((done) => setTimeout(done, EXEC_POLL_MS));
      }
      throw new Error(`a command in VM ${vmid} did not end in ${EXEC_TIMEOUT_MS / 1000} seconds`);
    },
  };
}
