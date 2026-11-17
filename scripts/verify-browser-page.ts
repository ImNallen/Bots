import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { OUTPUT_CAP_BYTES, PAGE_LIMITS, pageView, isPageInputRequest, type BrowserInvocation, type PageInputRequest, type PageView, type Browsing, type ToolResult } from "@bots/protocol";
import { aimPageInput } from "../apps/orchestrator/src/page.ts";
import { createBrowser, webSocketConnector, type Cdp } from "../apps/computerd/src/browser.ts";
import { NORMAL_VALUE_READS, PASSWORD_VALUE_GUARD } from "./page-fixture.ts";

const requestCookies: (string | undefined)[] = [];
const server = createServer((req, res) => {
  requestCookies.push(req.headers.cookie);
  res.setHeader("Content-Type", "text/html");
  if (req.url === "/popup") return res.end('<title>popup</title><button>Popup control</button>');
  if (req.url === "/other") return res.end('<title>other</title><button>Other control</button>');
  res.setHeader("Set-Cookie", "owner=yes; Path=/");
  res.end(`<!doctype html><title>Page proof</title><style>input,button,a,div[contenteditable] {display:block; margin:8px}</style>
    <div id="__botsPage" hidden></div>
    <button type="button"><svg>${'<path d="M0 0h1v1z"/>'.repeat(80)}</svg>Continue</button>
    <button type="button"><span hidden>Hidden prefix </span>Visible label</button>
    <button type="button"><span>First</span><br><span>Second</span></button>
    <button type="button"><div>Block one</div><div>Block two</div></button>
    <button type="button"><span style="visibility:hidden">Hidden<span style="visibility:visible">Visible override</span></span></button>
    <label for="labelled">Visible<span hidden> hidden label</span></label><input id="labelled">
    <input type="date" aria-label="Date picker"><input type="number" aria-label="Number spinner">
    <form><button id="submit" role="link">Read more</button></form>
    <button type="button" id="click" onclick="this.textContent='Clicked'">Click me</button>
    <input id="line" aria-label="Ordinary" value="old"><input id="secret" type="PASSWORD" role="button" value="never-retain-this">
    <input type="bogus" aria-label="Invalid input"><button type="bogus" aria-label="Invalid button">Invalid button</button>
    <input type="image" aria-label="Image submit"><input type="checkbox" role="link" aria-label="Check">
    <textarea readonly aria-label="Notes"></textarea><div contenteditable="true">Rich</div>
    <a href="/other">Next page</a><button type="button" onclick="window.open('/popup')">Open popup</button>
    <script>document.querySelector('form').onsubmit=e=>e.preventDefault();</script>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const site = `http://127.0.0.1:${address.port}`;
let inspector: Cdp | undefined;
let transport: Cdp | undefined;
let ownerWorld: { client: Cdp; contextId: number; sessionId: string } | undefined;
const portReservation = createServer();
await new Promise<void>((resolve) => portReservation.listen(0, "127.0.0.1", resolve));
const reserved = portReservation.address();
assert.ok(reserved && typeof reserved !== "string");
const port = reserved.port;
await new Promise<void>((resolve) => portReservation.close(() => resolve()));
const chromiumServer = await chromium.launchServer({ headless: true, args: [`--remote-debugging-port=${port}`] });
try {
  inspector = await webSocketConnector(port);
  const browser = createBrowser({
    desktops: { acquire: async () => ({ slot: 1, cdpPort: port, release() {} }) },
    connector: async (cdpPort) => {
      const client = await webSocketConnector(cdpPort); transport = client;
      return { ...client, send: async (method, params, sessionId) => {
        const result = await client.send(method, params, sessionId);
        if (method === "Page.createIsolatedWorld" && typeof params?.worldName === "string" && params.worldName.startsWith("bots.page.") && typeof result.executionContextId === "number" && sessionId !== undefined) {
          ownerWorld = { client, contextId: result.executionContextId, sessionId };
          const guarded = await client.send("Runtime.evaluate", { contextId: result.executionContextId, expression: PASSWORD_VALUE_GUARD }, sessionId);
          assert.equal(guarded.exceptionDetails, undefined);
        }
        return result;
      } };
    },
  });
  let lastPage: PageView | null = null;
  const execute = async (request: Exclude<BrowserInvocation, { aim: unknown }> | PageInputRequest, browsing?: Browsing) => {
    let tool: BrowserInvocation;
    if (isPageInputRequest(request)) {
      const prepared = aimPageInput(request, lastPage);
      assert.equal(prepared.kind, "computer");
      tool = prepared.tool;
    } else tool = request;
    const result = await browser.execute({ botId: "proof", tool, browsing, signal: AbortSignal.timeout(15000) });
    assert.equal(result.outcome, "ok", result.output);
    assert.ok(result.page, result.output);
    pageView.parse(result.page);
    lastPage = result.page;
    assert.ok(Buffer.byteLength(result.output) <= OUTPUT_CAP_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify(result.page)) <= PAGE_LIMITS.jsonBytes);
    const refs = [...result.output.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
    assert.deepEqual(refs, result.page.targets.map((t) => t.ref));
    return result;
  };
  const ref = (result: ToolResult, words: string) => {
    const target = result.page?.targets.find((target) => target.words === words);
    assert.ok(target, `missing ${words}`);
    return target.ref;
  };
  let result = await execute({ name: "browser_navigate", args: { url: site } });
  assert.equal(result.page?.origin, site);
  assert.ok(result.page?.targets.some((target) => target.words === "Continue"), "SVG icons must not consume a control's label budget");
  assert.ok(result.page?.targets.some((target) => target.words === "Visible label"));
  assert.ok(result.page?.targets.some((target) => target.words === "First Second"));
  assert.ok(result.page?.targets.some((target) => target.words === "Block one Block two"));
  assert.ok(result.page?.targets.some((target) => target.words === "Visible override"));
  assert.ok(result.page?.targets.some((target) => target.words === "Visible"));
  assert.ok(!JSON.stringify(result).includes("Hidden prefix"));
  assert.ok(!JSON.stringify(result.page).includes("hidden label"));
  for (const words of ["Date picker", "Number spinner"]) {
    assert.deepEqual(result.page?.targets.find((target) => target.words === words)?.control, { kind: "button" });
  }
  console.log("ok named DOM property cannot shadow owner, rendered labels, non-text inputs");
  const loggedOut: Browsing = { kind: "loggedOut", key: "proof-run" };
  result = await execute({ name: "browser_navigate", args: { url: site } }, loggedOut);
  assert.match(result.output, new RegExp(`to: ${site}/other`));
  assert.equal(result.page?.origin, site);
  assert.equal(requestCookies.at(-1), undefined, "logged-out request must not carry owner cookies");
  const contexts = await inspector.send("Target.getBrowserContexts");
  assert.ok(Array.isArray(contexts.browserContextIds) && contexts.browserContextIds.length === 1);
  await execute({ name: "browser_type", args: { ref: ref(result, "Ordinary"), text: "loggedout-only", submit: false } }, loggedOut);
  await browser.endBrowsing("proof", "proof-run");
  result = await execute({ name: "browser_snapshot", args: {} });
  assert.ok(!result.output.includes("loggedout-only"));
  assert.ok(!result.output.includes(" to: "));
  console.log("ok logged-out isolated facts and href compatibility");
  const evaluateMain = async (url: string, expression: string) => {
    assert.ok(inspector);
    const { targetInfos } = await inspector.send("Target.getTargets");
    assert.ok(Array.isArray(targetInfos));
    const target = targetInfos.find((t: { url: string }) => t.url === url);
    assert.ok(target);
    const session = await inspector.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const reply = await inspector.send("Runtime.evaluate", { expression, returnByValue: true }, String(session.sessionId));
    assert.equal(reply.exceptionDetails, undefined, JSON.stringify(reply.exceptionDetails));
  };
  await evaluateMain(`${site}/`, `(() => {
    const forged = document.createElement('button'); forged.textContent='Forged'; forged.dataset.botsRef='2'; document.body.prepend(forged, forged.cloneNode(true));
    document.querySelector('#click').dataset.botsRef='999';
    Object.defineProperty(HTMLInputElement.prototype, 'value', { get() { if(this.type==='password') throw new Error('password value read'); return 'poisoned'; } });
    Object.defineProperty(HTMLInputElement.prototype, 'type', { get() { return 'text'; } });
    Object.defineProperty(HTMLButtonElement.prototype, 'type', { get() { return 'button'; } });
    Element.prototype.getAttribute = () => 'poisoned';
    Element.prototype.getBoundingClientRect = () => ({width:0,height:0});
    Document.prototype.querySelectorAll = () => {throw new Error('poisoned')};
    window.Map = class { constructor(){throw new Error('poisoned')} };
    window.getComputedStyle = () => ({display:'none'});
  })()`);
  result = await execute({ name: "browser_snapshot", args: {} });
  const first = result.page?.snapshotId;
  const controls = result.page?.targets;
  assert.deepEqual(controls?.find((t) => t.words === "Read more")?.control, { kind: "submit" });
  assert.deepEqual(controls?.find((t) => t.words === "Invalid button")?.control, { kind: "submit" });
  assert.deepEqual(controls?.find((t) => t.words === "Invalid input")?.control, { kind: "field", field: "line", readOnly: false });
  assert.ok(controls?.some((t) => t.control.kind === "field" && t.control.field === "secret"));
  assert.ok(!JSON.stringify(result).includes("never-retain-this"));
  assert.ok(!result.output.includes("poisoned"));
  result = await execute({ name: "browser_click", args: { ref: ref(result, "Click me") } });
  assert.ok(result.page?.targets.some((t) => t.words === "Clicked"));
  assert.notEqual(result.page?.snapshotId, first);
  result = await execute({ name: "browser_type", args: { ref: ref(result, "Ordinary"), text: "typed normally", submit: false } });
  assert.match(result.output, /typed normally/);
  assert.ok(ownerWorld);
  const reads = await ownerWorld.client.send("Runtime.evaluate", { contextId: ownerWorld.contextId, expression: NORMAL_VALUE_READS, returnByValue: true }, ownerWorld.sessionId);
  assert.ok(reads.result && typeof reads.result === "object" && "value" in reads.result && typeof reads.result.value === "number" && reads.result.value > 0, "The value getter must be instrumented in the real owner world");
  console.log("ok isolated native facts, forged refs, click/type, fresh identity, password nonaccess");
  result = await execute({ name: "browser_click", args: { ref: ref(result, "Open popup") } });
  assert.match(result.output, /Title: popup/);
  result = await execute({ name: "browser_navigate", args: { url: `${site}/other` } });
  assert.match(result.output, /Other control/);
  console.log("ok newest popup and navigation");
  for (const fixture of ["unicode", "many", "mostly-text"]) {
    await evaluateMain(`${site}/other`, `(() => {
      const name = ${JSON.stringify(fixture)};
      document.body.replaceChildren();
      if (name === "unicode") {
        const b = document.createElement("button"); b.style.cssText='width:200px;height:40px;content-visibility:hidden'; b.textContent = '😀\\\"\u0000'.repeat(1_000_000); document.body.append(b);
      } else {
        for (let i = 0; i < 20000; i++) {
          const e = document.createElement(name === "many" ? "button" : "span");
          e.textContent = name === "many" ? '😀 control ' + i : " "; document.body.append(e);
        }
        const b = document.createElement("button"); b.textContent = "Beyond budget"; document.body.append(b);
      }
    })()`);
    result = await execute({ name: "browser_snapshot", args: {} });
    assert.ok(result.page?.targets.length !== undefined && result.page.targets.length <= PAGE_LIMITS.targets);
    assert.equal(result.truncated, true);
    console.log(`ok bounded ${fixture}`);
  }
  console.log("verify:browser-page passed");
} finally {
  transport?.close();
  inspector?.close();
  await chromiumServer.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
