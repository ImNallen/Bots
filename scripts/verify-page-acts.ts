import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isBrowserInvocation, pageView, type AimedPageInvocation, type BrowserInvocation, type PageView } from "../packages/protocol/src/index.ts";
import { createBrowser, webSocketConnector, type Cdp } from "../apps/computerd/src/browser.ts";
import { openJournal } from "../apps/computerd/src/journal.ts";
import { createCalls } from "../apps/computerd/src/calls.ts";
import { NORMAL_VALUE_READS, PASSWORD_VALUE_GUARD } from "./page-fixture.ts";

const html = `<!doctype html><title>Bound page actions</title>
<style>input,textarea,button,a,[contenteditable] {display:block;margin:12px; min-height:24px} #below {margin-top:1800px}</style>
<form id="form" action="/saved" onclick="void 0"><input type="hidden" name="form"><fieldset id="fieldset">
${["text", "search", "email", "url", "tel", "password"].map(type => `<input id="${type}" type="${type}" aria-label="${type}" value="old">`).join("")}
<textarea id="notes" aria-label="notes">old</textarea><button id="button" type="button">Act</button>
<button id="submit">Submit</button><input id="sentinel" aria-label="Sentinel" value="">
</fieldset></form><a id="link" href="/next" ping="/original-ping">Next</a><div id="rich" contenteditable aria-label="rich">old</div>
<select id="choice" aria-label="Choice"><option>One</option><option>Two</option></select>
<div id="unlisted" tabindex="0">unlisted</div><output id="state"></output><button id="below" type="button">Below</button>
<script>
window.events=[]; window.clicks=0; window.before=0; window.state={};
for(const name of ['input','beforeinput','click','mousedown','select','change']) document.addEventListener(name,e=>{
  events.push({type:e.type, target:e.target.id, trusted:e.isTrusted});
  if(e.type==='input') { state[e.target.id]=e.target.value; document.querySelector('output').textContent=JSON.stringify(state); }
});
button.onclick=()=>{clicks++}; below.onclick=()=>{clicks++};
form.onsubmit=e=>e.preventDefault();
</script>`;
const requests: { url: string; method: string }[] = [];
const server = createServer((request, response) => { requests.push({ url: request.url ?? "", method: request.method ?? "" }); response.setHeader("Content-Type", "text/html"); response.end(html); });
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const site = `http://127.0.0.1:${address.port}`;
let port = Number(process.argv[process.argv.indexOf("--cdp-port") + 1]);
let closeBrowser = async () => {};
if (!process.argv.includes("--cdp-port")) {
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const reserved = reservation.address();
  assert.ok(reserved && typeof reserved !== "string");
  port = reserved.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const { chromium } = await import("playwright");
  const launched = await chromium.launchServer({ headless: true, args: [`--remote-debugging-port=${port}`] });
  closeBrowser = () => launched.close();
} else assert.ok(process.argv.includes("--disposable"), "An existing CDP browser must be explicitly marked --disposable");
assert.ok(Number.isInteger(port) && port > 0);
const inspector = await webSocketConnector(port);
const transports: Cdp[] = [];
let duringWorld: (() => Promise<void>) | null = null;
let guardValues = false;
let ownerWorld: { client: Cdp; contextId: number; sessionId: string } | undefined;
const makeBrowser = () => createBrowser({
  desktops: { acquire: async () => ({ slot: 1, cdpPort: port, release() {} }) },
  connector: async (value) => {
    const client = await webSocketConnector(value); transports.push(client);
    return { ...client, send: async (method, params, sessionId) => {
      const result = await client.send(method, params, sessionId);
      if (guardValues && method === "Page.createIsolatedWorld" && typeof params?.worldName === "string" && params.worldName.startsWith("bots.page.") && typeof result.executionContextId === "number" && sessionId !== undefined) {
        ownerWorld = { client, contextId: result.executionContextId, sessionId };
        const guarded = await client.send("Runtime.evaluate", { contextId: result.executionContextId, expression: PASSWORD_VALUE_GUARD }, sessionId);
        assert.equal(guarded.exceptionDetails, undefined);
      }
      if (method === "Page.createIsolatedWorld" && duringWorld) { const hook = duringWorld; duringWorld = null; await hook(); }
      return result;
    } };
  },
});
let browser = makeBrowser();
let session = "";
const journalDir = await mkdtemp(join(tmpdir(), "bots-page-acts-"));
const execute = (tool: BrowserInvocation) => browser.execute({ botId: "page-proof", tool, browsing: undefined, signal: AbortSignal.timeout(15000) });
const evaluate = async (expression: string) => {
  const reply = await inspector.send("Runtime.evaluate", { expression, returnByValue: true }, session);
  assert.equal(reply.exceptionDetails, undefined, JSON.stringify(reply.exceptionDetails));
  return (reply.result as { value: unknown }).value;
};
const snapshot = async (): Promise<PageView> => {
  const result = await execute({ name: "browser_snapshot", args: {} });
  assert.equal(result.outcome, "ok", result.output);
  return pageView.parse(result.page);
};
const reset = async () => {
  const result = await execute({ name: "browser_navigate", args: { url: site } });
  assert.equal(result.outcome, "ok", result.output);
  const { targetInfos } = await inspector.send("Target.getTargets");
  assert.ok(Array.isArray(targetInfos));
  const target = targetInfos.find(target => target.url === site + "/");
  assert.ok(target);
  const attached = await inspector.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  assert.equal(typeof attached.sessionId, "string");
  session = String(attached.sessionId);
  return pageView.parse(result.page);
};
const input = (page: PageView, words = "text", text = "replacement"): AimedPageInvocation => {
  const target = page.targets.find(target => target.words === words);
  assert.ok(target, words);
  return { name: "browser_type", args: { ref: target.ref, text, submit: false }, aim: { kind: "element", snapshotId: page.snapshotId, origin: page.origin, target } };
};
const click = (page: PageView, words = "Act"): AimedPageInvocation => {
  const target = page.targets.find(target => target.words === words);
  assert.ok(target, words);
  return { name: "browser_click", args: { ref: target.ref }, aim: { kind: "element", snapshotId: page.snapshotId, origin: page.origin, target } };
};
const refused = async (tool: BrowserInvocation) => {
  const result = await execute(tool);
  assert.equal(result.outcome, "error", result.output);
  assert.equal(result.page, undefined, "refusal must not silently capture and rebind");
  assert.equal(await evaluate("sentinel.value"), "", "sentinel must remain untouched");
  return result;
};
try {
  console.log("browser", await inspector.send("Browser.getVersion"));
  let page = await reset();
  const frame = await inspector.send("Page.getFrameTree", {}, session);
  const frameId = (frame.frameTree as { frame: { id: string } }).frame.id;
  const world = await inspector.send("Page.createIsolatedWorld", { frameId, worldName: "bots.primitive.probe" }, session);
  const primitive = async (expression: string) => {
    const reply = await inspector.send("Runtime.evaluate", { expression, contextId: world.executionContextId, returnByValue: true }, session);
    assert.equal(reply.exceptionDetails, undefined);
  };
  await primitive(`(()=>{const e=document.getElementById('text');e.focus();e.select();document.execCommand('insertText',false,'command')})()`);
  await primitive(`(()=>{const e=document.getElementById('text');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'setter');e.dispatchEvent(new InputEvent('input',{bubbles:true,data:'setter'}))})()`);
  assert.deepEqual(await evaluate("events.filter(e=>e.type==='input').map(e=>e.trusted)"), [true, false]);
  console.log("ok primitive comparison: execCommand trusted input; setter untrusted input");
  page = await reset();
  guardValues = true;
  for (const words of ["text", "search", "email", "url", "tel", "password", "notes", "rich"]) {
    const result = await execute(input(page, words, `new-${words}`));
    assert.equal(result.outcome, "ok", result.output);
    assert.equal(await evaluate(words === "rich" ? "rich.textContent" : `state[${JSON.stringify(words)}]`), `new-${words}`);
    page = pageView.parse(result.page);
  }
  assert.ok(ownerWorld);
  const reads = await ownerWorld.client.send("Runtime.evaluate", { contextId: ownerWorld.contextId, expression: NORMAL_VALUE_READS, returnByValue: true }, ownerWorld.sessionId);
  assert.ok(reads.result && typeof reads.result === "object" && "value" in reads.result && typeof reads.result.value === "number" && reads.result.value > 0, "The value getter must be instrumented in the real owner world");
  assert.equal(await evaluate("sentinel.value"), "");
  assert.equal(await evaluate("events.filter(e=>e.type==='input'&&!e.trusted).length"), 0);
  assert.equal(await evaluate("events.filter(e=>e.type==='click'||e.type==='mousedown').length"), 0);
  assert.ok(!JSON.stringify(page).includes("new-password"));
  assert.equal((await execute(input(page, "text", ""))).outcome, "ok");
  assert.equal(await evaluate("document.getElementById('text').value"), "");
  console.log("ok replacement/empty text, eight editable kinds, listener-backed app state, no mouse, guarded password nonaccess");
  page = await reset();
  await evaluate("document.getElementById('text').addEventListener('beforeinput',()=>{before++;sentinel.focus()})");
  assert.equal((await execute(input(page))).outcome, "ok");
  assert.equal(await evaluate("before"), 0, "insertText must not expose a beforeinput retargeting gap on this engine");
  assert.equal(await evaluate("sentinel.value"), "");
  for (const [label, setup] of [
    ["focus theft", "document.getElementById('text').onfocus=()=>sentinel.focus()"],
    ["focus changes URL", "document.getElementById('text').onfocus=()=>history.pushState({},'', '/changed')"],
    ["focus changes semantics", "document.getElementById('text').onfocus=e=>e.target.readOnly=true"],
    ["focus replaces node", "document.getElementById('text').onfocus=e=>e.target.replaceWith(e.target.cloneNode())"],
    ["focus covers target", "document.getElementById('text').onfocus=()=>{let d=document.createElement('div');d.style='position:fixed;inset:0;z-index:999;background:red';document.body.append(d)}"],
  ] as const) {
    page = await reset(); await evaluate(setup); await refused(input(page));
    assert.equal(await evaluate("document.getElementById('text').value"), "old");
    console.log("ok", label);
  }
  page = await reset();
  await evaluate("document.getElementById('text').onselect=()=>sentinel.focus()");
  assert.equal((await execute(input(page))).outcome, "ok");
  assert.equal(await evaluate("document.getElementById('text').value"), "replacement");
  assert.equal(await evaluate("sentinel.value"), "");
  console.log("ok select listener runs after bound edit; beforeinput listener never retargets edit");
  for (const [label, setup, words] of [
    ["replacement", "button.replaceWith(button.cloneNode(true))", "Act"],
    ["same-node label", "button.textContent='Changed'", "Act"],
    ["same-node type", "button.type='submit'", "Act"],
    ["effective disabled", "fieldset.disabled=true", "Act"],
    ["inert ancestor", "form.inert=true", "Act"],
    ["readonly", "document.getElementById('text').readOnly=true", "text"],
    ["type", "document.getElementById('text').type='password'", "text"],
    ["href", "link.href='/elsewhere'", "Next"],
    ["ping", "link.ping='/changed-ping'", "Next"],
    ["download", "link.download='export.txt'", "Next"],
    ["referrer policy", "link.referrerPolicy='unsafe-url'", "Next"],
    ["form action", "form.action='/elsewhere'", "Submit"],
    ["form method", "form.method='post'", "Submit"],
    ["clobbered form action", "form.insertAdjacentHTML('beforeend','<input name=action>');form.setAttribute('action','/elsewhere')", "Submit"],
    ["base target", "let b=document.createElement('base');b.target='_blank';document.head.append(b)", "Next"],
    ["form override", "document.getElementById('submit').formAction='/elsewhere'", "Submit"],
    ["occluded", "let d=document.createElement('div');d.style='position:fixed;inset:0;z-index:999;background:red';document.body.append(d)", "Act"],
    ["same-document URL", "history.pushState({},'', '/changed')", "Act"],
  ] as const) {
    page = await reset(); await evaluate(setup!);
    await refused(words === "text" ? input(page) : click(page, words));
    assert.equal(await evaluate("clicks"), 0);
    assert.ok(!requests.some(request => request.url === "/changed-ping" && request.method === "POST"), "A changed native ping destination must receive no request");
    console.log("ok stale", label);
  }
  page = await reset();
  assert.equal((await execute(click(page, "Below"))).outcome, "ok");
  assert.equal(await evaluate("clicks"), 1);
  assert.deepEqual(await evaluate("events.filter(e=>e.type==='click').map(e=>[e.target,e.trusted])"), [["below", false]]);
  assert.equal(await evaluate("events.filter(e=>e.type==='mousedown').length"), 0);
  console.log("ok scroll/hit-test and native click, untrusted click without pointer sequence");
  for (const negativeTabIndex of [false, true]) {
    page = await reset();
    if (negativeTabIndex) {
      await evaluate("text.tabIndex=-1; choice.tabIndex=-1; sentinel.focus()");
      page = await snapshot();
    }
    assert.equal((await execute(click(page, "text"))).outcome, "ok");
    assert.equal(await evaluate("document.activeElement.id"), "text");
    page = await snapshot();
    assert.equal((await execute(click(page, "Choice"))).outcome, "ok");
    assert.deepEqual(await evaluate("({focus:document.activeElement.id,open:choice.matches(':open'),windowFocus:document.hasFocus()})"), { focus: "choice", open: true, windowFocus: true });
    await inspector.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, session);
    await inspector.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, session);
  }
  console.log("ok native focus and select picker, including negative tabindex; fixture closes picker through its inspector");
  for (const tabIndex of ["-1", "2147483648", "bad"]) {
    await reset();
    await evaluate(`(()=>{const e=document.createElement('div');e.id='odd';e.setAttribute('role','button');e.setAttribute('aria-label','Odd tabindex');e.setAttribute('tabindex',${JSON.stringify(tabIndex)});e.textContent='Odd tabindex';e.style='display:block;width:160px;height:40px;margin:20px';e.onclick=()=>clicks++;document.body.prepend(e);sentinel.focus()})()`);
    page = await snapshot();
    assert.equal((await execute(click(page, "Odd tabindex"))).outcome, "ok");
    assert.equal(await evaluate("clicks"), 1);
    assert.equal(await evaluate("document.activeElement.id"), tabIndex === "-1" ? "odd" : "sentinel");
  }
  page = await reset(); await evaluate("button.onfocus=()=>sentinel.focus()");
  assert.equal((await execute(click(page))).outcome, "ok");
  assert.equal(await evaluate("clicks"), 1);
  assert.equal(await evaluate("sentinel.value"), "");
  for (const mutation of ["button.textContent='Changed'", "button.disabled=true", "button.replaceWith(button.cloneNode(true))"]) {
    page = await reset(); await evaluate(`button.onfocus=()=>{${mutation}}`);
    await refused(click(page));
    assert.equal(await evaluate("clicks"), 0);
  }
  console.log("ok native click stays element-bound across focus changes; invalid tabindex and postfocus mutations");
  page = await reset(); await snapshot(); await refused(click(page));
  page = await reset(); await evaluate("location.reload()");
  await new Promise(resolve => setTimeout(resolve, 100)); await refused(click(page));
  page = await reset(); browser = makeBrowser(); await refused(click(page));
  page = await reset(); transports.at(-1)?.close(); browser = makeBrowser(); await refused(click(page));
  console.log("ok capture UUID/ref reuse, reload, new owner/restart, lost connection");
  page = await reset();
  await evaluate("document.getElementById('unlisted').focus()"); assert.deepEqual((await snapshot()).focus, { kind: "unlisted" });
  await evaluate("document.getElementById('text').focus()");
  page = await snapshot(); assert.equal(page.focus?.kind, "target");
  for (const key of ["Enter", "Tab", "Escape"] as const) {
    assert.ok(page.focus);
    await refused({ name: "browser_press", args: { key }, aim: { kind: "focus", snapshotId: page.snapshotId, origin: page.origin, focus: page.focus, target: page.targets.find(target => page.focus?.kind === "target" && target.ref === page.focus.ref) ?? null } });
  }
  const submit = input(page); assert.equal(submit.name, "browser_type");
  if (submit.name === "browser_type") { submit.args.submit = true; await refused(submit); }
  assert.equal(await evaluate("document.getElementById('text').value"), "old");
  console.log("ok optional focus captures; selected key/submit refusal occurs before partial edit");
  page = await reset();
  const journal = await openJournal({ dir: journalDir });
  let executions = 0;
  const calls = createCalls({ journal, execute: async args => {
    executions++;
    assert.ok(isBrowserInvocation(args.tool));
    return browser.execute({ ...args, tool: args.tool });
  } });
  const request = { callId: `proof:${randomUUID()}`, botId: "page-proof", tool: click(page) };
  const first = await calls.call(request);
  assert.equal(first.outcome, "ok", first.output);
  await evaluate("button.textContent='Changed after execution'");
  assert.deepEqual(await calls.call(request), first);
  assert.deepEqual(await createCalls({ journal, execute: async () => { throw Error('replayed input'); } }).call(request), first);
  assert.equal(executions, 1); assert.equal(await evaluate("clicks"), 1);
  const stale = { ...request, callId: `proof:${randomUUID()}` };
  const rejected = await calls.call(stale); assert.equal(rejected.outcome, "error");
  await snapshot(); assert.deepEqual(await calls.call(stale), rejected);
  console.log("ok real journal: one physical click, identical snapshot across two replays; refused replay never captures");
  page = await reset();
  const { targetId } = await inspector.send("Target.createTarget", { url: site + "/popup" });
  await refused(click(page));
  await inspector.send("Target.closeTarget", { targetId });
  console.log("ok already-observed newer page refuses old aim");
  page = await reset();
  let popupId: unknown;
  duringWorld = async () => { popupId = (await inspector.send("Target.createTarget", { url: site + "/during-bind" })).targetId; };
  await refused(click(page));
  assert.equal(await evaluate("clicks"), 0);
  await inspector.send("Target.closeTarget", { targetId: popupId });
  console.log("ok real popup created during world-binding wait refuses before dispatch");
  console.log("verify:page-acts passed; native keys and submit intentionally refuse");
} finally {
  transports.forEach(client => client.close());
  inspector.close();
  await closeBrowser();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(journalDir, { recursive: true, force: true });
}
