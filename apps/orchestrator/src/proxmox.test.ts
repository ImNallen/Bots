import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createProxmox } from "./proxmox.js";

const directory = mkdtempSync(join(tmpdir(), "bots-proxmox-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "key"), "-out", join(directory, "cert"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
let exists = false;
let audit = false;
let failure = false;
let name = "bots-user-201";
const server = createServer({ key: readFileSync(join(directory, "key")), cert: readFileSync(join(directory, "cert")) }, (req, res) => {
  const path = req.url ?? "";
  if (failure) { res.writeHead(503, "Unavailable").end(); return; }
  if (path.includes("/nextid")) {
    if (exists) { res.writeHead(400, "Parameter verification failed").end(); return; }
    res.end(JSON.stringify({ data: 201 })); return;
  }
  if (!audit) { res.writeHead(403, "Permission check failed").end(); return; }
  if (!exists) { res.writeHead(500, "configuration file 'nodes/node/qemu-server/201.conf' does not exist").end(); return; }
  res.end(JSON.stringify({ data: path.endsWith("/config") ? { name } : { status: "stopped" } }));
});
let proxmox: ReturnType<typeof createProxmox>;
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No listening port");
  proxmox = createProxmox({ url: `https://localhost:${address.port}`, node: "node", token: "test", caPem: readFileSync(join(directory, "cert"), "utf8") });
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(directory, { recursive: true });
});
it("distinguishes fresh and post-destroy absence from a hidden existing VM", async () => {
  expect(await proxmox.inspect(201)).toBeNull();
  exists = true;
  await expect(proxmox.inspect(201)).rejects.toMatchObject({ status: 403 });
  audit = true;
  expect((await proxmox.inspect(201))?.config.name).toBe("bots-user-201");
  name = "foreign";
  expect((await proxmox.inspect(201))?.config.name).toBe("foreign");
  exists = false;
  audit = false;
  expect(await proxmox.inspect(201)).toBeNull();
  audit = true;
  expect(await proxmox.inspect(201)).toBeNull();
  failure = true;
  await expect(proxmox.inspect(201)).rejects.toMatchObject({ status: 503 });
});
