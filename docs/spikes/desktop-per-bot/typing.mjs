import { connect } from "node:net";
import { createServer } from "node:http";
import { execSync } from "node:child_process";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const report = (ok, name, detail = "") => { results.push(ok); console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`); };
const sh = (c) => { try { return execSync(c, { encoding: "utf8" }).trim(); } catch (e) { return `ERR ${String(e.message).slice(0, 120)}`; } };
const asBrowser = (c) => sh(`sudo -u browser bash -c ${JSON.stringify(c)}`);

async function browserOf(n) {
  const version = await (await fetch(`http://127.0.0.1:${9300 + n}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let nextId = 1; const pending = new Map();
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); } };
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const page = async (url) => {
    const { targetId } = await cdp("Target.createTarget", { url });
    const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
    await cdp("Page.enable", {}, sessionId); await cdp("Runtime.enable", {}, sessionId);
    const ev = async (expression) => (await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)).result?.value;
    const nav = async (u) => { await cdp("Page.navigate", { url: u }, sessionId); for (let i = 0; i < 60; i++) { await sleep(200); if ((await ev("document.readyState").catch(() => "")) === "complete") return; } };
    return { targetId, sessionId, ev, nav };
  };
  return { cdp, page, close: () => ws.close() };
}
// A minimal RFB client: raw encoding, no auth.
function rfb(port) {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0); const waiters = [];
    const pump = () => { while (waiters.length && buf.length >= waiters[0].n) { const w = waiters.shift(); const out = buf.subarray(0, w.n); buf = buf.subarray(w.n); w.r(Buffer.from(out)); } };
    sock.on("data", (d) => { buf = Buffer.concat([buf, d]); pump(); });
    sock.on("error", reject);
    const read = (n) => new Promise((r) => { waiters.push({ n, r }); pump(); });
    (async () => {
      await read(12); sock.write("RFB 003.008\n");
      const n = (await read(1))[0]; const types = await read(n);
      if (!types.includes(1)) throw new Error("no None security"); sock.write(Buffer.from([1]));
      const status = (await read(4)).readUInt32BE(0); if (status !== 0) throw new Error("auth failed");
      sock.write(Buffer.from([1]));
      const init = await read(24); const width = init.readUInt16BE(0), height = init.readUInt16BE(2); const nameLen = init.readUInt32BE(20); await read(nameLen);
      const pf = Buffer.alloc(20); pf[0] = 0; pf.writeUInt8(32, 4); pf.writeUInt8(24, 5); pf.writeUInt8(0, 6); pf.writeUInt8(1, 7); pf.writeUInt16BE(255, 8); pf.writeUInt16BE(255, 10); pf.writeUInt16BE(255, 12); pf.writeUInt8(16, 14); pf.writeUInt8(8, 15); pf.writeUInt8(0, 16); sock.write(pf);
      const enc = Buffer.alloc(8); enc[0] = 2; enc.writeUInt16BE(1, 2); enc.writeInt32BE(0, 4); sock.write(enc);
      const frame = async () => {
        const req = Buffer.alloc(10); req[0] = 3; req[1] = 0; req.writeUInt16BE(width, 6); req.writeUInt16BE(height, 8); sock.write(req);
        const px = Buffer.alloc(width * height * 4);
        for (;;) {
          const t = (await read(1))[0];
          if (t !== 0) { continue; }
          const h = await read(3); const rects = h.readUInt16BE(1);
          for (let i = 0; i < rects; i++) { const r = await read(12); const x = r.readUInt16BE(0), y = r.readUInt16BE(2), w = r.readUInt16BE(4), hh = r.readUInt16BE(6); const data = await read(w * hh * 4); for (let row = 0; row < hh; row++) data.copy(px, (y + row) * width * 4 + x * 4, row * w * 4, (row + 1) * w * 4); }
          return (x, y) => { const o = (y * width + x) * 4; return [px[o + 2], px[o + 1], px[o]]; };
        }
      };
      const pointer = (x, y, mask) => { const b = Buffer.alloc(6); b[0] = 5; b[1] = mask; b.writeUInt16BE(x, 2); b.writeUInt16BE(y, 4); sock.write(b); };
      const key = (sym, down) => { const b = Buffer.alloc(8); b[0] = 4; b[1] = down ? 1 : 0; b.writeUInt32BE(sym, 4); sock.write(b); };
      resolve({ width, height, frame, pointer, key, close: () => sock.destroy() });
    })().catch(reject);
  });
}

const typeKeys = async (c, text, ms = 12) => { for (const ch of text) { const sym = ch.charCodeAt(0); c.key(sym, true); c.key(sym, false); await sleep(ms); } };
const click = async (c, x, y) => { c.pointer(x - 11, y - 7, 0); await sleep(25); c.pointer(x, y, 0); await sleep(25); c.pointer(x, y, 1); await sleep(40); c.pointer(x, y, 0); };
const page = (n) => `data:text/html,<!doctype html><title>desk${n}</title><style>html,body{margin:0;height:100%25;background:%23ddd}textarea{position:fixed;inset:30px;width:calc(100%25 - 60px);height:calc(100%25 - 60px);font:18px monospace}</style><textarea id=t></textarea>`;


const browsers = {}; const pages = {};
const nums = [1, 2, 3, 4];
for (const n of nums) { browsers[n] = await browserOf(n); pages[n] = await browsers[n].page(page(n)); await sleep(150); }
await sleep(1500);
const value = (n) => pages[n].ev("document.getElementById('t').value");
const tally = async () => { const o = {}; for (const n of nums) o[n] = (await value(n)).length; return o; };
const reset = async () => { for (const n of nums) await pages[n].ev("document.getElementById('t').value=''"); };
// Text can arrive late, so count only once nothing has changed for a full second.
const settled = async () => { let last = JSON.stringify(await tally()); let still = 0; const t0 = Date.now(); while (still < 10 && Date.now() - t0 < 15000) { await sleep(100); const now = JSON.stringify(await tally()); still = now === last ? still + 1 : 0; last = now; } return JSON.parse(last); };
const TEXT = "abcdefghijklmnopqrstuvwxyz0123456789";

console.log("--- A. typing through VNC right after a click, counted after delivery settles");
for (const [label, gap] of [["fast, 8 ms per key", 8], ["human, 60 ms per key", 60]]) {
  let leaks = 0, lost = 0, rounds = 0, badLog = [];
  for (const waitMs of [0, 30, 100, 200, 400]) {
    for (const n of [1, 2, 3, 4, 2, 1, 4, 3]) {
      await settled(); await reset();
      const c = await rfb(6900 + n);
      await click(c, 640, 420);
      await sleep(waitMs);
      await typeKeys(c, TEXT, gap);
      const t = await settled();
      rounds += 1;
      const others = nums.filter((m) => m !== n).reduce((s, m) => s + t[m], 0);
      leaks += others; lost += TEXT.length - t[n];
      if (t[n] !== TEXT.length || others !== 0) badLog.push(`wait ${waitMs} display ${n}: ${JSON.stringify(t)}`);
      c.close(); await sleep(60);
    }
  }
  report(leaks === 0, `${label}: no keystroke reached another display`, `${leaks} leaked in ${rounds} rounds`);
  report(lost === 0, `${label}: every keystroke reached its own page`, `${lost} of ${rounds * TEXT.length} lost`);
  for (const l of badLog.slice(0, 8)) console.log(`      ${l}`);
}

console.log("--- A2. how long a key takes to arrive");
await reset();
const c = await rfb(6902); await click(c, 640, 420); await sleep(500);
const times = [];
for (let i = 0; i < 20; i++) {
  const before = (await value(2)).length; const t0 = performance.now();
  c.key(0x61, true); c.key(0x61, false);
  while ((await value(2)).length === before && performance.now() - t0 < 5000) await sleep(5);
  times.push(Math.round(performance.now() - t0));
  await sleep(150);
}
times.sort((a, b) => a - b);
console.log(`      idle typing, ms per key: median ${times[10]}, worst ${times[19]}`);
c.close();
const c3 = await rfb(6902); await click(c3, 640, 420); await sleep(400);
await reset();
const t0 = performance.now();
await typeKeys(c3, TEXT, 8);
let arrived = 0; while (arrived < TEXT.length && performance.now() - t0 < 15000) { arrived = (await value(2)).length; await sleep(20); }
console.log(`      a burst of ${TEXT.length} keys at 8 ms apart took ${Math.round(performance.now() - t0)} ms to arrive, got ${arrived}`);
c3.close();
const c4 = await rfb(6902); await reset();
await click(c4, 640, 420); const c0 = performance.now();
await sleep(0);
c4.key(0x7a, true); c4.key(0x7a, false);
let got = 0; while (got === 0 && performance.now() - c0 < 8000) { got = (await value(2)).length; await sleep(10); }
console.log(`      click then a key at once: the key arrived after ${Math.round(performance.now() - c0)} ms`);
c4.close();
console.log(`${results.filter(Boolean).length} passed, ${results.filter((x) => !x).length} failed`);
process.exit(0);
