// Runs in a user VM, as root, from the release's root. infra/proxmox/verify-desktop.sh runs it. It starts the real main.ts under a
// private unit, with a private state directory and a link on loopback, so a kill is a real kill, and no test cookie enters this
// VM's real jar. Exits 0 only if every check passes.
import { execFile } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { chown, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { WebSocket } from "ws";
import { webSocketConnector } from "../apps/computerd/src/browser.ts";
import { parseLiveSlots, type Slot } from "../apps/computerd/src/desktops.ts";
import type { Cookie } from "../apps/computerd/src/logins.ts";

// A release installs ws for computerd alone, so it resolves from there.
const { WebSocketServer } = createRequire(new URL("../apps/computerd/package.json", import.meta.url))("ws") as typeof import("ws");

const run = promisify(execFile);
const UNIT = "verify-logins-computerd";
const OVERALL_TIMEOUT_MS = 12 * 60 * 1000;
const FLUSH_WAIT_MS = 35_000;
const BOTS = { a: "verifyloginsa", b: "verifyloginsb", c: "verifyloginsc", d: "verifyloginsd" } as const;
const RETURN = 0xff0d;
const CENTER = [640, 400] as const;
const nonce = randomBytes(4).toString("hex");
const asUser = (label: string) => `${label}${nonce}`;

let failures = 0;
let passes = 0;

// Details never hold a cookie's value, because this prints to a log.
function check(ok: boolean, label: string, detail = ""): void {
  if (ok) {
    passes += 1;
    console.log(`ok    logins: ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL  logins: ${label}${detail === "" ? "" : ` [${detail}]`}`);
  }
}

function measure(label: string, startedAt: number): void {
  console.log(`measure  logins: ${label}: ${Math.round(performance.now() - startedAt)} ms`);
}

async function until(condition: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }
    await sleep(200);
  }
  return false;
}

const { stdout: liveAtStart } = await run("systemctl", ["list-units", "--plain", "--no-legend", "--no-pager", "computerd-xvfb@*"]);
if (parseLiveSlots(liveAtStart).length > 0) {
  console.log("FAIL  logins: a desktop is running, and a push reaches every running browser, so this would put test cookies in a bot's browser");
  process.exit(1);
}

setTimeout(() => {
  console.log(`FAIL  logins: the check did not finish in ${OVERALL_TIMEOUT_MS / 1000} seconds`);
  process.exit(1);
}, OVERALL_TIMEOUT_MS).unref();

const PAGE = (title: string, body: string) => `<!doctype html><title>${title}</title>${body}`;
const FILLS_THE_PAGE = "position:fixed;left:0;top:0;width:100%;height:100%;font-size:40px";
const DAY_SECONDS = 86_400;

function accountOf(header: string | undefined): string {
  const cookies = new Map((header ?? "").split("; ").map((pair) => pair.split("=") as [string, string]));
  const seen = ["persist", "sess", "__Host-token", "visible"].map((name) => `${name}=${cookies.get(name) ?? "none"}`);
  return seen.every((entry) => entry.endsWith("=none")) ? "signed out" : seen.join(" ");
}

const signedInAs = (user: string) => `persist=${user} sess=${user} __Host-token=${user} visible=${user}`;

const sitePort = (): number => (site.address() as AddressInfo).port;
const site = createServer((request, response) => {
  const { pathname } = new URL(request.url as string, "http://localhost");
  const html = (body: string) => {
    response.setHeader("Content-Type", "text/html");
    response.end(body);
  };
  const toAccount = () => {
    response.statusCode = 303;
    response.setHeader("Location", "/account");
    response.end();
  };
  switch (pathname) {
    case "/signin":
      if (request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => (body += String(chunk)));
        request.on("end", () => {
          const user = new URLSearchParams(body).get("user") ?? "";
          response.setHeader("Set-Cookie", [
            `persist=${user}; Path=/; HttpOnly; Max-Age=${DAY_SECONDS}`,
            `sess=${user}; Path=/; HttpOnly`,
            `__Host-token=${user}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${DAY_SECONDS}`,
            `visible=${user}; Path=/; SameSite=Strict; Max-Age=${DAY_SECONDS}; Priority=High`,
          ]);
          toAccount();
        });
        return;
      }
      html(PAGE("sign in", `<form method=post action=/signin><input name=user autofocus style="${FILLS_THE_PAGE}"></form>`));
      return;
    case "/signout":
      if (request.method === "POST") {
        response.setHeader("Set-Cookie", [
          "persist=; Path=/; Max-Age=0",
          "sess=; Path=/; Max-Age=0",
          "__Host-token=; Path=/; Secure; Max-Age=0",
          "visible=; Path=/; Max-Age=0",
        ]);
        toAccount();
        return;
      }
      html(PAGE("sign out", `<form method=post action=/signout><button style="${FILLS_THE_PAGE}">sign out</button></form>`));
      return;
    case "/account":
      html(PAGE("account", `<p>${accountOf(request.headers.cookie)}</p>`));
      return;
    case "/account-text":
      response.end(accountOf(request.headers.cookie));
      return;
    case "/watch":
      html(
        PAGE(
          `loaded ${randomBytes(4).toString("hex")}`,
          `<button onclick="fetch('/account-text').then((r) => r.text()).then((t) => { document.getElementById('o').textContent = t })">check</button><p id=o>not checked</p>`,
        ),
      );
      return;
    case "/rotate":
      response.setHeader("Set-Cookie", [`persist=${asUser("rotated")}; Path=/; HttpOnly; Max-Age=${DAY_SECONDS}`]);
      toAccount();
      return;
    case "/embed":
      html(PAGE("embed", `<iframe src="http://localhost:${sitePort()}/partitioned"></iframe>`));
      return;
    case "/partitioned":
      response.setHeader("Set-Cookie", ["cut=partitioned; Path=/; Secure; SameSite=None; Partitioned"]);
      response.end("ok");
      return;
    default:
      response.statusCode = 404;
      response.end();
  }
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const at = (path: string) => `http://localhost:${sitePort()}${path}`;

type Viewer = {
  closed: Promise<void>;
  isClosed: () => boolean;
  type: (text: string) => Promise<void>;
  tap: (keysym: number) => Promise<void>;
  clickAt: (x: number, y: number) => Promise<void>;
  leave: () => void;
};

// Speaks RFB over the real relay, so what reaches the desktop came through computerd's take-over path.
function viewerOn(socket: WebSocket): { handshake: () => Promise<Viewer> } {
  let buffered = Buffer.alloc(0);
  let wake = () => {};
  let isClosed = false;
  const closed = new Promise<void>((resolve) =>
    socket.once("close", () => {
      isClosed = true;
      wake();
      resolve();
    }),
  );
  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      buffered = Buffer.concat([buffered, data]);
      wake();
    }
  });
  const read = async (count: number): Promise<Buffer> => {
    while (buffered.length < count) {
      if (isClosed) {
        throw new Error("the stream closed during its handshake");
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    const out = buffered.subarray(0, count);
    buffered = buffered.subarray(count);
    return out;
  };
  const tap = async (keysym: number) => {
    const message = Buffer.alloc(8);
    message[0] = 4;
    message.writeUInt32BE(keysym, 4);
    message[1] = 1;
    socket.send(Buffer.from(message));
    message[1] = 0;
    socket.send(Buffer.from(message));
    await sleep(40);
  };
  const pointer = (x: number, y: number, buttons: number) => {
    const message = Buffer.alloc(6);
    message[0] = 5;
    message[1] = buttons;
    message.writeUInt16BE(x, 2);
    message.writeUInt16BE(y, 4);
    socket.send(message);
  };
  return {
    handshake: async () => {
      await read(12);
      socket.send(Buffer.from("RFB 003.008\n"));
      await read((await read(1))[0] as number);
      socket.send(Buffer.from([1]));
      await read(4);
      socket.send(Buffer.from([1]));
      const init = await read(24);
      await read(init.readUInt32BE(20));
      return {
        closed,
        isClosed: () => isClosed,
        tap,
        leave: () => socket.close(),
        type: async (text) => {
          for (const character of text) {
            await tap(character.codePointAt(0) as number);
          }
        },
        clickAt: async (x, y) => {
          pointer(x, y, 0);
          await sleep(30);
          pointer(x, y, 1);
          await sleep(40);
          pointer(x, y, 0);
        },
      };
    },
  };
}

let computer: WebSocket | null = null;
let hellos = 0;
const results = new Map<string, (output: { outcome: string; output: string }) => void>();
const dials = new Map<string, (viewer: ReturnType<typeof viewerOn>) => void>();
const link = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise((resolve) => link.once("listening", resolve));
link.on("connection", (socket) => {
  socket.on("error", () => {});
  socket.once("message", (raw: Buffer) => {
    const hello = JSON.parse(raw.toString("utf8")) as { kind: string; streamId?: string };
    if (hello.kind === "streamHello") {
      const viewer = viewerOn(socket);
      socket.send(JSON.stringify({ kind: "welcome" }));
      dials.get(hello.streamId as string)?.(viewer);
      return;
    }
    computer = socket;
    hellos += 1;
    socket.send(JSON.stringify({ kind: "welcome" }));
    socket.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString("utf8")) as { kind: string; callId: string; result: { outcome: string; output: string } };
      if (message.kind === "toolResult") {
        results.get(message.callId)?.(message.result);
      }
    });
  });
});
// computerd drops a link that stays silent for 30 seconds.
setInterval(() => computer?.ping(), 10_000).unref();

let calls = 0;
async function browse(botId: string, tool: { name: string; args: Record<string, unknown> }): Promise<{ outcome: string; output: string }> {
  calls += 1;
  const callId = `verifylogins:${randomBytes(4).toString("hex")}${calls}`;
  const answer = new Promise<{ outcome: string; output: string }>((resolve) => results.set(callId, resolve));
  computer?.send(JSON.stringify({ kind: "toolCall", callId, botId, tool }));
  return Promise.race([
    answer,
    sleep(120_000).then(() => ({ outcome: "timeout", output: "no answer from computerd in 120 seconds" })),
  ]);
}
const open = (botId: string, path: string) => browse(botId, { name: "browser_navigate", args: { url: at(path) } });
const slotOf = (output: string): Slot => Number(/^Screen (\d)/.exec(output)?.[1]) as Slot;
const cdpOf = (slot: Slot) => 9300 + slot;
const titleOf = (output: string) => /^Title: (.*)$/m.exec(output)?.[1] ?? "";

async function cookiesAt(slot: Slot): Promise<Cookie[]> {
  const client = await webSocketConnector(cdpOf(slot));
  try {
    return (await client.send("Storage.getCookies")).cookies as Cookie[];
  } finally {
    client.close();
  }
}
const valueIn = (cookies: Cookie[], name: string) => cookies.find((cookie) => cookie.name === name)?.value;
const stopDesktop = (slot: Slot) => run("systemctl", ["stop", "--quiet", `computerd-xvfb@${slot}.service`]);

async function takeOver(botId: string): Promise<Viewer> {
  const streamId = `verify${randomInt(1_000_000_000)}`;
  const dialed = new Promise<ReturnType<typeof viewerOn>>((resolve) => dials.set(streamId, resolve));
  computer?.send(JSON.stringify({ kind: "screenOpen", streamId, botId, mode: "control" }));
  return (await dialed).handshake();
}

async function typeLogin(viewer: Viewer, user: string): Promise<void> {
  await viewer.clickAt(...CENTER);
  await sleep(1000);
  await viewer.type(user);
  await viewer.tap(RETURN);
  await sleep(1500);
}

const COMPARED = ["value", "domain", "path", "httpOnly", "secure", "session", "sameSite", "priority", "sourceScheme", "sourcePort"] as const;
function differences(from: Cookie, to: Cookie | undefined): string[] {
  if (to === undefined) {
    return ["absent"];
  }
  const fields: string[] = COMPARED.filter((field) => from[field] !== to[field]);
  if (JSON.stringify(from.partitionKey) !== JSON.stringify(to.partitionKey)) {
    fields.push("partitionKey");
  }
  if (Math.abs(from.expires - to.expires) > 2) {
    fields.push("expires");
  }
  return fields;
}

const state = await mkdtemp("/var/lib/verify-logins-");
const { stdout: computerdUser } = await run("id", ["-u", "computerd"]);
const { stdout: computerdGroup } = await run("id", ["-g", "computerd"]);
await chown(state, Number(computerdUser), Number(computerdGroup));
const baselines = () => readdir(join(state, "takeovers")).catch(() => [] as string[]);

const usedSlots = new Set<Slot>();
async function cleanUp(): Promise<void> {
  await run("systemctl", ["stop", UNIT]).catch(() => {});
  await run("systemctl", ["reset-failed", UNIT]).catch(() => {});
  for (const slot of usedSlots) {
    await stopDesktop(slot).catch(() => {});
    await rm(`/run/computerd/desktop-${slot}.env`, { force: true });
  }
  for (const botId of Object.values(BOTS)) {
    await rm(`/home/browser/profiles/${botId}`, { recursive: true, force: true });
  }
  await rm(state, { recursive: true, force: true });
}

async function runChecks(): Promise<void> {
  const linkPort = (link.address() as AddressInfo).port;
  await run("systemd-run", [
    "--quiet",
    `--unit=${UNIT}`,
    "--property=User=computerd",
    `--property=WorkingDirectory=${process.cwd()}`,
    `--property=BindPaths=${state}:/var/lib/computerd`,
    `--property=Environment=COMPUTER_LINK_URL=ws://127.0.0.1:${linkPort}`,
    "--property=Environment=COMPUTER_TOKEN=verify",
    "--property=Restart=always",
    "--property=RestartSec=2",
    process.execPath,
    "apps/computerd/src/main.ts",
  ]);
  check(await until(() => hellos === 1, 30_000), "the real computerd connects to a link on loopback");

  const [firstA, firstB, firstC] = await Promise.all([open(BOTS.a, "/signin"), open(BOTS.b, "/watch"), open(BOTS.c, "/account")]);
  const [slotA, slotB, slotC] = [slotOf(firstA?.output ?? ""), slotOf(firstB?.output ?? ""), slotOf(firstC?.output ?? "")];
  for (const slot of [slotA, slotB, slotC]) {
    usedSlots.add(slot);
  }
  check(new Set([slotA, slotB, slotC]).size === 3, "three bots run on three screens", `${slotA} ${slotB} ${slotC}`);
  check(firstC?.output.includes("signed out") === true, "before any login, a bot is signed out");
  const loadedB = titleOf(firstB?.output ?? "");
  await stopDesktop(slotC);
  check(!(await webSocketConnector(cdpOf(slotC)).then(() => true, () => false)), "the third bot is stopped, with its profile");

  const firstUser = asUser("first");
  const firstViewer = await takeOver(BOTS.a);
  check((await baselines()).includes(`${BOTS.a}.json`), "a take-over records a baseline before the first key");
  const baselineStat = await stat(join(state, "takeovers", `${BOTS.a}.json`));
  check((baselineStat.mode & 0o777) === 0o600, "the baseline has mode 0600", (baselineStat.mode & 0o777).toString(8));
  check(
    await run("sudo", ["-n", "-u", "browser", "cat", join(state, "takeovers", `${BOTS.a}.json`)]).then(() => false, () => true),
    "the browser user cannot read the baseline",
  );
  await typeLogin(firstViewer, firstUser);
  check(
    valueIn(await cookiesAt(slotA), "persist") === firstUser,
    "a login typed through the input stream reaches the bot's page",
    `names ${(await cookiesAt(slotA)).map((cookie) => cookie.name).join()}`,
  );
  await open(BOTS.a, "/account");
  await browse(BOTS.a, { name: "browser_navigate", args: { url: `http://127.0.0.1:${sitePort()}/embed` } });
  const clientA = await webSocketConnector(cdpOf(slotA));
  await clientA.send("Storage.setCookies", {
    cookies: [{ name: "dotted", value: asUser("domain"), domain: ".verify-logins.test", path: "/", secure: true, httpOnly: true, expires: Math.floor(Date.now() / 1000) + DAY_SECONDS }],
  });
  clientA.close();
  check(valueIn(await cookiesAt(slotB), "persist") === undefined, "nothing moves during the take-over");

  const gaveBack = performance.now();
  firstViewer.leave();
  const reached = await until(async () => valueIn(await cookiesAt(slotB), "dotted") !== undefined, 15_000);
  check(reached, "after a give-back, a running bot has the login");
  measure("give-back until a running bot has the login", gaveBack);
  const [cookiesA, cookiesB] = [await cookiesAt(slotA), await cookiesAt(slotB)];
  for (const name of ["persist", "sess", "__Host-token", "visible", "cut", "dotted"]) {
    const from = cookiesA.find((cookie) => cookie.name === name);
    const fields = from === undefined ? ["absent from the source"] : differences(from, cookiesB.find((cookie) => cookie.name === name));
    check(fields.length === 0, `${name} reaches the other bot the same in every field`, fields.join());
  }
  check(cookiesB.find((cookie) => cookie.name === "persist")?.httpOnly === true, "an HttpOnly cookie arrives HttpOnly");
  check(cookiesB.find((cookie) => cookie.name === "sess")?.session === true, "a session cookie arrives as a session cookie");
  check(cookiesB.find((cookie) => cookie.name === "cut")?.partitionKey !== undefined, "a partitioned cookie keeps its partition");
  check(cookiesB.find((cookie) => cookie.name === "dotted")?.domain === ".verify-logins.test", "a domain cookie stays a domain cookie");
  check(cookiesB.some((cookie) => cookie.domain === "logins.bots.invalid"), "the running bot's browser has a cursor");
  check(await until(async () => (await baselines()).length === 0, 10_000), "the baseline is gone after the push");

  const refOf = (output: string, label: string) => Number(new RegExp(`\\[(\\d+)\\] [^\\n]*${label}`).exec(output)?.[1]);
  const afterPush = await browse(BOTS.b, { name: "browser_click", args: { ref: refOf(firstB?.output ?? "", "check") } });
  check(titleOf(afterPush.output) === loadedB, "the running bot's page did not reload");
  check(afterPush.output.includes(signedInAs(firstUser)), "the running bot's own page is signed in with no reload");

  const jarStat = await stat(join(state, "logins.json"));
  check((jarStat.mode & 0o777) === 0o600, "the jar has mode 0600", (jarStat.mode & 0o777).toString(8));
  check(await run("sudo", ["-n", "-u", "browser", "cat", join(state, "logins.json")]).then(() => false, () => true), "the browser user cannot read the jar");

  const startedC = performance.now();
  const stoppedBot = await open(BOTS.c, "/account");
  measure("a stopped bot's start and first page, with its catch-up", startedC);
  check(stoppedBot.output.includes(signedInAs(firstUser)), "a stopped bot is signed in when it starts");
  const startedD = performance.now();
  const newBot = await open(BOTS.d, "/account");
  measure("a new bot's copy, start, and first page, with its catch-up", startedD);
  const slotD = slotOf(newBot.output);
  usedSlots.add(slotD);
  check(newBot.output.includes(signedInAs(firstUser)), "a new bot is signed in on its first page");

  const fastPath = performance.now();
  for (let round = 0; round < 10; round += 1) {
    (await webSocketConnector(cdpOf(slotB))).close();
  }
  console.log(`measure  logins: the connection that every acquire makes to check its browser: ${Math.round((performance.now() - fastPath) / 10)} ms each`);

  await open(BOTS.a, "/signin");
  const secondUser = asUser("second");
  const secondViewer = await takeOver(BOTS.a);
  await typeLogin(secondViewer, secondUser);
  secondViewer.leave();
  check(await until(async () => valueIn(await cookiesAt(slotB), "persist") === secondUser, 15_000), "a second login replaces the first on a running bot");
  await sleep(5000);
  await stopDesktop(slotB);
  await run("systemctl", ["start", "--quiet", `computerd-desktop@${slotB}.target`]);
  const lostByStop = valueIn(await cookiesAt(slotB), "persist") !== secondUser;
  console.log(`measure  logins: a stop 5 s after a push lost that push from the profile: ${lostByStop}`);
  const backB = await open(BOTS.b, "/account");
  check(backB.output.includes(signedInAs(secondUser)), "a bot stopped 5 s after a push still has the login when it comes back");

  await open(BOTS.b, "/rotate");
  await sleep(FLUSH_WAIT_MS);
  await stopDesktop(slotB);
  const rotated = await open(BOTS.b, "/account");
  check(rotated.output.includes(`persist=${asUser("rotated")}`), "a cookie that a bot rotated survives its restart");
  check(rotated.output.includes(`sess=${secondUser}`), "the session cookie comes back around the rotated one");

  await open(BOTS.a, "/signout");
  const outViewer = await takeOver(BOTS.a);
  await outViewer.clickAt(...CENTER);
  await sleep(1500);
  outViewer.leave();
  const isOut = async (slot: Slot) => {
    const cookies = await cookiesAt(slot);
    return ["persist", "sess", "__Host-token", "visible"].every((name) => valueIn(cookies, name) === undefined);
  };
  check(await until(() => isOut(slotB), 15_000), "a log-out reaches a running bot");
  check(await until(() => isOut(slotD), 15_000), "a log-out reaches another running bot");
  await stopDesktop(slotC);
  const cAfter = await open(BOTS.c, "/account");
  check(cAfter.output.includes("signed out"), "a log-out reaches a stopped bot when it starts");
  await stopDesktop(slotB);
  const bAfter = await open(BOTS.b, "/account");
  check(bAfter.output.includes("signed out"), "a logged-out session cookie does not come back after a restart");

  await open(BOTS.a, "/signin");
  const thirdUser = asUser("third");
  const killed = await takeOver(BOTS.a);
  await typeLogin(killed, thirdUser);
  check((await baselines()).includes(`${BOTS.a}.json`), "the baseline exists when computerd is killed");
  const helloCount = hellos;
  const killedAt = performance.now();
  await run("systemctl", ["kill", "--signal=KILL", UNIT]);
  check(await until(() => hellos > helloCount, 30_000), "computerd comes back after a kill");
  check(await until(async () => valueIn(await cookiesAt(slotB), "persist") === thirdUser, 30_000), "a kill of computerd during a take-over still publishes the login");
  measure("kill until a running bot has the login", killedAt);
  check(await until(async () => (await baselines()).length === 0, 10_000), "the baseline is gone after the recovery");

  await open(BOTS.a, "/signin");
  const olderTab = await takeOver(BOTS.a);
  const fourthUser = asUser("fourth");
  await typeLogin(olderTab, fourthUser);
  const newerTab = await takeOver(BOTS.a);
  check(await until(() => olderTab.isClosed(), 10_000), "a newer tab ends the older tab's stream");
  await sleep(3000);
  check(valueIn(await cookiesAt(slotB), "persist") === thirdUser, "the older tab's close moves nothing while the newer tab is open");
  check((await baselines()).includes(`${BOTS.a}.json`), "the first baseline stays for the newer tab");
  newerTab.leave();
  check(await until(async () => valueIn(await cookiesAt(slotB), "persist") === fourthUser, 15_000), "the newer tab's give-back moves what the older tab typed");
  check(await until(async () => (await baselines()).length === 0, 10_000), "the baseline is gone after the newer tab gives back");

  const { stdout: journal } = await run("journalctl", ["-u", UNIT, "-o", "cat", "--no-pager"], { maxBuffer: 64 * 1024 * 1024 });
  check(journal.includes("logins-published"), "computerd logs that it published");
  check(!journal.includes(nonce), "computerd's log holds no cookie value");
  check(!/persist|__Host-token/.test(journal), "computerd's log holds no cookie name");
}

let status = 1;
try {
  await runChecks();
  status = failures === 0 ? 0 : 1;
} catch (error) {
  check(false, "the check ran to its end", error instanceof Error ? error.message : "unknown error");
} finally {
  await cleanUp();
}
console.log(`logins: passed ${passes}, failed ${failures}`);
process.exit(status);
