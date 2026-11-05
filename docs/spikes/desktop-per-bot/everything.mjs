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
for (const n of [1, 2, 3, 4]) { browsers[n] = await browserOf(n); pages[n] = await browsers[n].page(page(n)); await sleep(150); }
await sleep(1500);
const value = (n) => pages[n].ev("document.getElementById('t').value");
const reset = async () => { for (const n of [1, 2, 3, 4]) await pages[n].ev("document.getElementById('t').value=''"); };
const tally = async () => { const o = {}; for (const n of [1, 2, 3, 4]) o[n] = (await value(n)).length; return o; };
const TEXT = "abcdefghijklmnopqrstuvwxyz0123456789";

console.log("--- A. typing through VNC right after a click, switching displays");
let leaks = 0, lost = 0, rounds = 0;
for (const waitMs of [0, 30, 100, 200, 400]) {
  for (const n of [1, 2, 3, 4, 2, 1, 4, 3]) {
    await reset();
    const c = await rfb(6900 + n);
    await click(c, 640, 420);
    await sleep(waitMs);
    await typeKeys(c, TEXT, 8);
    await sleep(250);
    const t = await tally();
    rounds += 1;
    const others = [1, 2, 3, 4].filter((m) => m !== n).reduce((s, m) => s + t[m], 0);
    leaks += others; lost += TEXT.length - t[n];
    if (t[n] !== TEXT.length || others !== 0) console.log(`      wait ${waitMs} display ${n}: ${JSON.stringify(t)}`);
    c.close(); await sleep(60);
  }
}
report(leaks === 0, "no keystroke ever reached another display", `${leaks} leaked in ${rounds} rounds`);
report(lost === 0, "every keystroke reached its own page", `${lost} of ${rounds * TEXT.length} lost`);

console.log("--- B. typing on display 1 while other bots act on their own displays");
const disturb = {
  "another bot opens a window on its display": async () => { const w = await browsers[2].cdp("Target.createTarget", { url: "about:blank", newWindow: true }); await sleep(500); await browsers[2].cdp("Target.closeTarget", { targetId: w.targetId }); },
  "another bot brings itself to front": async () => { await browsers[3].cdp("Page.bringToFront", {}, pages[3].sessionId); },
  "another bot types through CDP": async () => { for (const ch of "bot-text") { await browsers[4].cdp("Input.insertText", { text: ch }, pages[4].sessionId); await sleep(20); } },
  "another bot's page opens a popup": async () => { await browsers[3].cdp("Runtime.evaluate", { expression: "void window.open('about:blank','_blank','width=300,height=200')", userGesture: true }, pages[3].sessionId); },
};
for (const [name, act] of Object.entries(disturb)) {
  await reset();
  await pages[4].ev("document.getElementById('t').focus()");
  const c = await rfb(6901); await click(c, 640, 420); await sleep(200);
  const typing = typeKeys(c, TEXT, 25);
  await sleep(250); await act(); await typing; await sleep(300);
  const v = await value(1);
  report(v === TEXT, name, `display 1 got ${v.length}/${TEXT.length}; ${JSON.stringify(await tally())}`);
  c.close(); await sleep(150);
}

console.log("--- C. what real desktop input can do");
const c1 = await rfb(6901);
const keysym = (c, s) => { c.key(s, true); c.key(s, false); };
const CTRL = 0xffe3, RETURN = 0xff0d, DOWN = 0xff54;
await click(c1, 640, 420); await sleep(150);
c1.key(CTRL, true); c1.key(0x6c, true); c1.key(0x6c, false); c1.key(CTRL, false); await sleep(200);
await typeKeys(c1, "example.com", 15); keysym(c1, RETURN); await sleep(2500);
const loc = await pages[1].ev("location.host");
report(loc === "example.com", "Ctrl+L and typing in the address bar navigates", `host ${loc}`);
const sel = `data:text/html,<!doctype html><title>sel</title><style>body{margin:40px;font:24px sans-serif}select{font:24px sans-serif;width:400px}</style><select id=s><option>one<option>two<option>three<option>four</select><div id=o></div><script>s.onchange=()=>o.textContent='changed:'+s.value</script>`;
await pages[1].nav(sel); await sleep(300);
const r = await pages[1].ev("(()=>{const b=document.getElementById('s').getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2,h:b.height,chrome:outerHeight-innerHeight,sx:screenX,sy:screenY}})()");
const sx = Math.round(r.x + r.sx), sy = Math.round(r.y + r.sy + r.chrome);
await click(c1, sx, sy); await sleep(600);
await click(c1, sx, Math.round(sy + r.h * 3)); await sleep(500);
const dd = await pages[1].ev("document.getElementById('o').textContent");
report(/changed/.test(dd), "a mouse click chooses a dropdown option, which CDP could not do", `"${dd}"`);
c1.close();
const vo = await rfb(5903);
await pages[3].ev("document.getElementById('t').value=''");
await click(vo, 640, 420); await sleep(200); await typeKeys(vo, "viewonly", 15); await sleep(300);
report((await value(3)).length === 0, "the view-only stream of a display types nothing");
vo.close();

console.log("--- D. logins across copied profiles");
const cookieLog = [];
const server = createServer((req, res) => {
  const cookie = req.headers.cookie ?? "";
  if (req.url.startsWith("/login")) { const v = new URL(req.url, "http://x").searchParams.get("v"); res.setHeader("Set-Cookie", `session=${v}; HttpOnly; Max-Age=86400; Path=/`); res.setHeader("Content-Type", "text/html"); res.end(`<!doctype html><title>logged in</title><script>localStorage.setItem('ls','${v}')</script>ok`); return; }
  res.setHeader("Content-Type", "text/plain"); res.end(cookie || "no-cookie");
}).listen(7777, "127.0.0.1");
const ORIGIN = "http://127.0.0.1:7777";
const body = (p) => p.ev("document.body.innerText");
const lsOf = (p) => p.ev("localStorage.getItem('ls') ?? 'no-ls'");
const closeBrowser = async (n) => { await browsers[n].cdp("Browser.close").catch(() => {}); browsers[n].close(); for (let i = 0; i < 40; i++) { if (sh(`pgrep -fc "[r]emote-debugging-port=${9300 + n}" || true`) === "0") break; await sleep(250); } };
const startOn = async (n, profile, bin = "/usr/bin/chromium") => { asBrowser(`/opt/chrome.sh ${n} ${profile} ${bin}`); for (let i = 0; i < 60; i++) { try { await (await fetch(`http://127.0.0.1:${9300 + n}/json/version`)).json(); break; } catch { await sleep(250); } } browsers[n] = await browserOf(n); };

const base = await browsers[2].page(`${ORIGIN}/login?v=copied`); await sleep(800);
await closeBrowser(2);
const dbInfo = asBrowser(`sqlite3 'file:/home/browser/profile/Fork-2/Default/Cookies?immutable=1' "select name, substr(hex(encrypted_value),1,6), length(value) from cookies where host_key like '127%'"`);
console.log("      on disk:", dbInfo, "(763130 means v10, encrypted with a fixed key)");
asBrowser(`mkdir -p /home/browser/profile/Fork-5 && cp -a /home/browser/profile/Fork-2/. /home/browser/profile/Fork-5/ && rm -f /home/browser/profile/Fork-5/Singleton* && rm -rf /home/browser/profile/Fork-5/Default/Cache /home/browser/profile/Fork-5/Default/'Code Cache'`);
console.log("      copy size:", asBrowser(`du -sh /home/browser/profile/Fork-5 | cut -f1`));
await startOn(2, "/home/browser/profile/Fork-5");
const fork = await browsers[2].page(`${ORIGIN}/whoami`); await sleep(800);
report((await body(fork)) === "session=copied", "a copied profile stays logged in, with an HttpOnly cookie and the sandbox on", await body(fork));
report((await lsOf(fork)) === "copied", "a copied profile keeps localStorage", await lsOf(fork));

console.log("--- E. moving a login to a bot that is already running");
const other = await browsers[3].page(`${ORIGIN}/whoami`); await sleep(500);
report((await body(other)) === "no-cookie", "another running bot starts logged out", await body(other));
const source = await browsers[4].page(`${ORIGIN}/login?v=live`); await sleep(600);
const { cookies } = await browsers[4].cdp("Storage.getCookies", {});
const mine = cookies.filter((k) => k.name === "session");
console.log("      read through CDP:", JSON.stringify(mine.map((k) => ({ name: k.name, httpOnly: k.httpOnly, expires: Math.round(k.expires) > 0 }))));
await browsers[3].cdp("Storage.setCookies", { cookies: mine.map(({ name, value, domain, path, expires, httpOnly, secure, sameSite }) => ({ name, value, domain, path, expires, httpOnly, secure, ...(sameSite ? { sameSite } : {}) })) });
await other.nav(`${ORIGIN}/whoami`); await sleep(300);
report((await body(other)) === "session=live", "a login moves to a running bot through CDP, with no restart", await body(other));
report((await lsOf(other)) === "no-ls", "localStorage does not move that way", await lsOf(other));

console.log("--- F. a real site's HttpOnly session");
const gh = await browsers[4].page("https://github.com/login"); await sleep(2500);
const ghCookies = (await browsers[4].cdp("Storage.getCookies", {})).cookies.filter((k) => k.domain.includes("github"));
const sess = ghCookies.find((k) => k.name === "_gh_sess");
report(sess?.httpOnly === true, "CDP can read a real site's HttpOnly session cookie", `${ghCookies.length} github cookies, _gh_sess httpOnly=${sess?.httpOnly}`);

console.log("--- G. Chromium and real Chrome at a site that blocked us");
const gl = await browsers[3].page("https://gitlab.com/users/sign_in");
await sleep(9000);
console.log("      chromium:", await gl.ev("document.title"));
await closeBrowser(1);
await startOn(1, "/home/browser/profile/Chrome-1", "/usr/bin/google-chrome");
const glc = await browsers[1].page("https://gitlab.com/users/sign_in"); await sleep(9000);
console.log("      chrome:  ", await glc.ev("document.title"), "|", await glc.ev("navigator.userAgent.match(/Chrome\\/[0-9.]+/)[0]"), "| webdriver", await glc.ev("navigator.webdriver"));
const sb = await browsers[1].page("chrome://sandbox"); await sleep(1200);
console.log("      chrome sandbox:", (await sb.ev("document.body.innerText")).match(/You are[^\n]*/)?.[0]);

console.log("--- H. the cost");
const sites = { 2: "https://en.wikipedia.org/wiki/Virtual_machine", 3: "https://github.com/ImNallen/Bots", 4: "https://developer.mozilla.org/en-US/docs/Web/API/WebSocket" };
for (const [n, u] of Object.entries(sites)) { await browsers[n].page(u); }
await sleep(5000);
console.log("      4 desktops, real pages:", sh("free -m | sed -n 2p"));
console.log("      load:", sh("cut -d' ' -f1-3 /proc/loadavg"), "| chrome rss by display not separable");
server.close();
console.log(`${results.filter(Boolean).length} passed, ${results.filter((x) => !x).length} failed`);
process.exit(0);
