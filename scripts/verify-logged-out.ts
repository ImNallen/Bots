import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Browsing } from "@bots/protocol";
import { createBrowser, webSocketConnector, type Cdp, type CdpConnector } from "../apps/computerd/src/browser.ts";
import { createLogins, type Jar } from "../apps/computerd/src/logins.ts";

const CDP_PORT = Number(process.argv[2]);
if (!Number.isInteger(CDP_PORT) || process.getuid?.() !== 0) {
  console.error("Usage, as root, on a browser that nobody is using: node scripts/verify-logged-out.ts <CDP port>");
  process.exit(2);
}
const DOWNLOADS = "/home/browser/Downloads";
const BOT = "verifyloggedout";
const signal = new AbortController().signal;
const nonce = Date.now().toString(36);
let failures = 0;
let passes = 0;

function check(ok: boolean, label: string, detail = ""): void {
  if (ok) {
    passes += 1;
    console.log(`ok    logged out: ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL  logged out: ${label}${detail === "" ? "" : ` [${detail.slice(0, 400)}]`}`);
  }
}

const seen: { path: string; cookie: string | undefined }[] = [];
const respond: RequestListener = (request, response) => {
  const path = request.url ?? "/";
  seen.push({ path, cookie: request.headers.cookie });
  const page = (body: string, headers: Record<string, string> = {}) => {
    response.writeHead(200, { "Content-Type": "text/html", ...headers });
    response.end(`<!doctype html>${body}`);
  };
  if (path.startsWith("/login")) {
    page("<title>logged in</title>", { "Set-Cookie": `session=${new URL(path, "http://x").searchParams.get("as")}; Path=/; Max-Age=3600; HttpOnly` });
  } else if (path === "/whoami") {
    page(`<title>whoami</title><p>cookies: ${request.headers.cookie ?? "none"}</p>`);
  } else if (path === "/mine") {
    page("<title>the bot's own page</title>");
  } else if (path === "/alert") {
    page("<title>before</title><script>alert('stop');document.title='alert returned'</script>");
  } else if (path === "/popup") {
    page("<title>opener</title><button style='position:fixed;left:0;top:0;width:200px;height:200px' onclick=\"window.open('/alert')\">go</button>");
  } else if (path === "/spin") {
    page("<title>spin</title><script>while(true){}</script>");
  } else if (path === "/links") {
    page(`<title>links</title><a href="/a?x=1">relative</a><a href="javascript:alert(1)">script</a><a href="mailto:x@example.com">mail</a><a href="/${"l".repeat(400)}">long</a>`);
  } else if (path === "/scripted-download") {
    page(`<title>scripted</title><a id="x" href="/file/scripted-${nonce}.bin" download></a><script>document.getElementById("x").click()</script>`);
  } else if (path.startsWith("/file")) {
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${path.slice("/file/".length)}"` });
    response.end("a file");
  } else {
    response.writeHead(204);
    response.end();
  }
};
const server = createServer(respond);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const SITE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const desktops = { acquire: async () => ({ slot: 1 as const, cdpPort: CDP_PORT, release: () => {} }) };
const quick = { toolDeadlineMs: 4000, frozenProbeMs: 1000 };
const browserWith = (connector: CdpConnector = webSocketConnector) => createBrowser({ desktops, connector, ...quick });

const inspector = await webSocketConnector(CDP_PORT);
const contexts = async () => ((await inspector.send("Target.getBrowserContexts")).browserContextIds as string[]).length;
const browserAlive = () =>
  fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1000) }).then(
    () => true,
    () => false,
  );

const browser = browserWith();
const run = (key: string): Browsing => ({ kind: "loggedOut", key });
const open = (target: ReturnType<typeof browserWith>, path: string, browsing: Browsing | undefined) =>
  target.execute({ botId: BOT, tool: { name: "browser_navigate", args: { url: `${SITE}${path}` } }, browsing, signal });
const look = (target: ReturnType<typeof browserWith>, browsing: Browsing | undefined) => target.execute({ botId: BOT, tool: { name: "browser_snapshot", args: {} }, browsing, signal });

const jarDir = mkdtempSync(join(tmpdir(), "verify-logged-out-"));
const logins = createLogins({ dir: jarDir, connector: webSocketConnector });
const jarText = () => {
  try {
    return JSON.stringify(JSON.parse(readFileSync(join(jarDir, "logins.json"), "utf8")) as Jar);
  } catch {
    return "";
  }
};
const readDefaultCookies = async () => ((await inspector.send("Storage.getCookies")).cookies as { name: string; value: string }[]).filter((cookie) => cookie.name === "session");

await logins.opened(BOT, CDP_PORT);
await open(browser, `/login?as=owner${nonce}`, undefined);
await logins.closed(BOT, CDP_PORT);
check(jarText().includes(`owner${nonce}`), "control: a login in a take-over reaches the jar");
const own = await open(browser, "/mine", undefined);
check(own.outcome === "ok" && own.output.includes("/mine"), "the bot's own page opens");
const control = await open(browser, "/whoami", undefined);
check(control.output.includes(`session=owner${nonce}`), "control: a chat run's request carries the login", control.output);
await open(browser, "/mine", undefined);

const first = await open(browser, "/whoami", run("one"));
check(first.outcome === "ok" && first.output.includes("cookies: none"), "a logged-out request carries no login", first.output);
check(seen.at(-1)?.cookie === undefined, "the server received no cookie");
check((await contexts()) === 1, "one context exists during the run");
check((await look(browser, run("one"))).output.includes("/whoami"), "the same key keeps its page");

await logins.opened(BOT, CDP_PORT);
await open(browser, "/login?as=stranger", run("one"));
const inside = await open(browser, "/whoami", run("one"));
check(inside.output.includes("session=stranger"), "a page can log in inside its window", inside.output);
await logins.closed(BOT, CDP_PORT);
check(!jarText().includes("stranger"), "a login made in a logged-out window does not reach the jar, even during a take-over");
check((await readDefaultCookies()).every((cookie) => cookie.value === `owner${nonce}`), "the default context keeps the owner's login");

// Chromium writes such a download to a hidden name, and with no deny that file stayed for at least 10 seconds.
const downloads = () => (existsSync(DOWNLOADS) ? readdirSync(DOWNLOADS).length : 0);
const filesBefore = downloads();
await open(browser, `/file/denied-${nonce}.bin`, run("one"));
await open(browser, "/scripted-download", run("one"));
await sleep(1000);
check(downloads() === filesBefore, "a logged-out download writes nothing, from a link or from a script");

const allowed = `allowed-${nonce}.bin`;
await open(browser, "/mine", undefined);
check((await contexts()) === 0, "a chat call ends a window that a finished run left");
const mineAfter = await look(browser, undefined);
check(mineAfter.output.includes("/mine"), "the bot's own page stayed where it was", mineAfter.output);
await open(browser, `/file/${allowed}`, undefined);
await sleep(1000);
check(existsSync(join(DOWNLOADS, allowed)), "a chat run's download still lands");
rmSync(join(DOWNLOADS, allowed), { force: true });
await open(browser, "/mine", undefined);

const again = await open(browser, "/whoami", run("two"));
check(again.output.includes("cookies: none"), "a login made in an ended window is gone", again.output);

const dialog = await open(browser, "/alert", run("two"));
check(dialog.outcome === "ok" && dialog.output.includes("alert returned"), "a dialog in a logged-out page's first script is answered", dialog.output);
await open(browser, "/popup", run("two"));
const popup = await browser.execute({ botId: BOT, tool: { name: "browser_click", args: { ref: 1 } }, browsing: run("two"), signal });
check(popup.outcome === "ok" && popup.output.includes("alert returned"), "a popup whose first script alerts stays in the window's context, and it is the current page", popup.output);
const targets = (await inspector.send("Target.getTargets")).targetInfos as { type: string; browserContextId: string; url: string }[];
const defaultId = (await inspector.send("Target.getBrowserContexts")).defaultBrowserContextId as string;
check(targets.filter((target) => target.type === "page" && target.url.endsWith("/alert")).every((target) => target.browserContextId !== defaultId), "the popup is not in the default context");

await browser.endBrowsing(BOT, "two");
check((await contexts()) === 0 && (await browserAlive()), "endBrowsing ends the window, and the browser stays");

const links = await open(browser, "/links", run("three"));
check(links.output.includes(`"relative" to: ${SITE}/a?x=1`), "a logged-out snapshot shows a link's address", links.output);
check(!links.output.includes("javascript:") && !links.output.includes("mailto:"), "it shows only http and https addresses");
const long = links.output.split("\n").find((line) => line.includes('"long"')) ?? "";
check(long.endsWith("...") && long.length < 240, "a long address is cut at 200 characters and says so", long);
const chatLinks = await open(browser, "/links", undefined);
check(!chatLinks.output.includes(" to: "), "a chat run's snapshot shows no addresses", chatLinks.output);
await open(browser, "/mine", undefined);

await open(browser, "/whoami", run("four"));
const frozen = await open(browser, "/spin", run("four"));
check(frozen.outcome === "timeout" && frozen.output.includes("froze and was closed"), "a frozen logged-out page ends its call, and the model reads why", frozen.output);
const afterFrozen = await look(browser, run("four"));
check(afterFrozen.output.includes("about:blank"), "the next call has a blank page", afterFrozen.output);
const leak = await open(browser, "/whoami", run("four"));
check(leak.output.includes("cookies: none"), "that page is still logged out", leak.output);
await browser.endBrowsing(BOT, "four");
check((await look(browser, undefined)).output.includes("/mine"), "the bot's own page survived the freeze");

await open(browser, "/whoami", run("five"));
const pages = ((await inspector.send("Target.getTargets")).targetInfos as { type: string; targetId: string; browserContextId: string }[]).filter((target) => target.type === "page" && target.browserContextId === defaultId);
for (const page of pages) {
  await inspector.send("Target.closeTarget", { targetId: page.targetId });
}
await sleep(500);
await browser.endBrowsing(BOT, "five");
await sleep(2500);
check(await browserAlive(), "the browser survives the end of a window when the bot had no page of its own");

let dying: Cdp | undefined;
const restarting = createBrowser({ desktops, ...quick, personHasScreen: () => true, connector: async (port) => (dying = await webSocketConnector(port)) });
const kept = await open(restarting, "/spin", run("six"));
check(kept.output.includes("owner has the screen"), "a frozen page stays while a person has the screen", kept.output);
check((await contexts()) === 1, "its context is still there");
dying?.close();
await sleep(1000);
check((await contexts()) === 0 && (await browserAlive()), "a frozen window ends with computerd's socket, and the browser stays");
const fresh = browserWith();
const resumed = await look(fresh, run("six"));
check(resumed.outcome === "ok" && resumed.output.includes("about:blank"), "a resumed run with the same key gets a blank logged-out page", resumed.output);
await fresh.endBrowsing(BOT, "six");

inspector.close();
server.close();
rmSync(jarDir, { recursive: true, force: true });
console.log(`logged out: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
