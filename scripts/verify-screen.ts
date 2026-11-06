import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { api } from "@bots/convex";
import { ConvexHttpClient } from "convex/browser";
import { WebSocket } from "ws";

const CONVEX_PORT = 8443;
const OVERALL_TIMEOUT_MS = 60_000;

setTimeout(() => {
  console.log(`FAIL  the check did not finish in ${OVERALL_TIMEOUT_MS / 1000} seconds`);
  process.exit(1);
}, OVERALL_TIMEOUT_MS).unref();
const [origin] = process.argv.slice(2);
if (origin === undefined || !URL.canParse(origin)) {
  console.error("usage: pnpm verify:screen https://<machine>.<tailnet>.ts.net");
  process.exit(2);
}
const wsOrigin = origin.replace(/^http/, "ws");

let failures = 0;
function report(ok: boolean, name: string, detail = ""): void {
  failures += ok ? 0 : 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail === "" ? "" : `: ${detail}`}`);
}

const response = await fetch(`${origin}/auth/token`);
assert.equal(response.status, 200);
const { token } = (await response.json()) as { token: string };
const client = new ConvexHttpClient(`https://${new URL(origin).hostname}:${CONVEX_PORT}`);
client.setAuth(token);
await client.mutation(api.users.ensureCurrent, {});
const botId = await client.mutation(api.bots.create, { name: `verify-screen-${randomBytes(4).toString("hex")}` });

function rejectedWith(args: { path: string; headers: Record<string, string> }): Promise<number | "connected"> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${wsOrigin}${args.path}`, { headers: args.headers });
    socket.once("open", () => {
      socket.close();
      resolve("connected");
    });
    socket.once("unexpected-response", (_request, res) => resolve(res.statusCode ?? 0));
    socket.once("error", () => {});
  });
}

const path = `/screens/${botId}`;
const crossSite = await rejectedWith({ path, headers: { Origin: "https://evil.example" } });
report(crossSite === 403, "a page from another site cannot open the screen, even with this device's identity", String(crossSite));
const noOrigin = await rejectedWith({ path, headers: {} });
report(noOrigin === 403, "a client with no origin cannot open the screen", String(noOrigin));
const stranger = await rejectedWith({ path: "/screens/jd7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa", headers: { Origin: origin } });
report(stranger === 403, "a bot this user does not own cannot be opened", String(stranger));

function rfbSession(): Promise<{ width: number; height: number; name: string; socket: WebSocket; read: (n: number) => Promise<Buffer> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsOrigin}${path}`, { headers: { Origin: origin as string } });
    let buffer = Buffer.alloc(0);
    const waiters: Array<{ n: number; done: (value: Buffer) => void }> = [];
    const pump = () => {
      while (waiters.length > 0 && buffer.length >= (waiters[0] as { n: number }).n) {
        const waiter = waiters.shift() as { n: number; done: (value: Buffer) => void };
        const out = buffer.subarray(0, waiter.n);
        buffer = buffer.subarray(waiter.n);
        waiter.done(Buffer.from(out));
      }
    };
    socket.on("message", (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      pump();
    });
    socket.on("error", reject);
    socket.on("close", (code) => reject(new Error(`the stream closed with ${code}`)));
    const read = (n: number) => new Promise<Buffer>((done) => { waiters.push({ n, done }); pump(); });
    socket.once("open", () => {
      (async () => {
        const version = (await read(12)).toString();
        assert.match(version, /^RFB 003\./);
        socket.send(Buffer.from("RFB 003.008\n"));
        const count = (await read(1))[0] as number;
        const types = await read(count);
        assert.ok(types.includes(1), "the stream must need no password inside the authenticated relay");
        socket.send(Buffer.from([1]));
        assert.equal((await read(4)).readUInt32BE(0), 0);
        socket.send(Buffer.from([1]));
        const init = await read(24);
        const nameLength = init.readUInt32BE(20);
        const name = (await read(nameLength)).toString();
        resolve({ width: init.readUInt16BE(0), height: init.readUInt16BE(2), name, socket, read });
      })().catch(reject);
    });
  });
}

const session = await rfbSession();
report(session.width === 1280 && session.height === 800, "the owner gets a 1280x800 stream through tailscale serve and the link", `${session.width}x${session.height} "${session.name.slice(0, 30)}"`);

const setEncodings = Buffer.alloc(8);
setEncodings[0] = 2;
setEncodings.writeUInt16BE(1, 2);
session.socket.send(setEncodings);
const request = Buffer.alloc(10);
request[0] = 3;
request.writeUInt16BE(1280, 6);
request.writeUInt16BE(800, 8);
session.socket.send(request);
const started = Date.now();
const header = await Promise.race([session.read(4), sleep(15_000).then(() => null)]);
report(header !== null && header[0] === 0, "a frame update arrives over the stream", header === null ? "none in 15 s" : `in ${Date.now() - started} ms`);
session.socket.removeAllListeners("close");
session.socket.close();

// A viewer that sends a malformed frame must end only itself, because the orchestrator serves every user.
const attacker = new WebSocket(`${wsOrigin}${path}`, { headers: { Origin: origin } });
await new Promise((resolve, reject) => {
  attacker.once("open", resolve);
  attacker.once("error", reject);
});
attacker.on("error", () => {});
(attacker as unknown as { _socket: { write: (data: Buffer) => void } })._socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff]));
await sleep(1500);
const health = await fetch(`${origin}/healthz`);
const after = await rfbSession();
report(health.status === 200 && after.width === 1280, "a malformed frame from one viewer leaves the orchestrator serving others", `healthz ${health.status}`);
after.socket.removeAllListeners("close");
after.socket.close();

// A failed run keeps its bot, so its screen can still be looked at.
if (failures === 0) {
  await client.mutation(api.bots.remove, { botId });
}

console.log(failures === 0 ? "verify:screen passed" : `verify:screen failed with ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
