import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { api } from "@bots/convex";
import { ConvexHttpClient } from "convex/browser";
import { chromium, type Page } from "playwright";
import { WebSocketServer, type WebSocket } from "ws";

const base = process.argv[2] ?? "http://127.0.0.1:5173";
const output = process.env.DESIGN_SCREENSHOTS ?? "/tmp/bots-floating-computer-review";
const response = await fetch(`${base}/auth/token`);
const auth: unknown = await response.json();
assert(response.ok && typeof auth === "object" && auth !== null && "token" in auth && typeof auth.token === "string", "Start the local app before this check.");
const client = new ConvexHttpClient("http://127.0.0.1:3210");
client.setAuth(auth.token);
await client.mutation(api.users.ensureCurrent, { browserTimeZone: "Europe/Stockholm" });
const botId = await client.mutation(api.bots.create, { name: "Atlas", color: "green" });
const browser = await chromium.launch();
const errors: string[] = [];
let watchOpened = 0, inputOpened = 0, activeInputs = 0, rejectConnections = false;
const keys: number[] = [];

// Only the remote desktop is a fixture. The actual noVNC client decodes RFB and sends input;
// ownership and take-over state use the local backend through the running application.
function desktop(socket: WebSocket, path: string) {
  const input = path.endsWith("/input");
  socket.on("error", () => {});
  if (input) { inputOpened++; activeInputs++; } else watchOpened++;
  let closed = false;
  const close = () => { if (!closed) { closed = true; if (input) activeInputs--; } };
  socket.on("close", close);
  if (rejectConnections) { close(); socket.close(); return; }
  let state: "version" | "security" | "shared" | "ready" = "version";
  let buffer = Buffer.alloc(0), sent = false;
  function init() {
    const name = Buffer.from("Fixture desktop");
    const header = Buffer.alloc(24);
    header.writeUInt16BE(1280, 0); header.writeUInt16BE(800, 2);
    header[4] = 32; header[5] = 24; header[6] = 0; header[7] = 1;
    header.writeUInt16BE(255, 8); header.writeUInt16BE(255, 10); header.writeUInt16BE(255, 12);
    header[14] = 16; header[15] = 8; header[16] = 0; header.writeUInt32BE(name.length, 20);
    socket.send(Buffer.concat([header, name]));
  }
  function frame() {
    const header = Buffer.alloc(16); header.writeUInt16BE(1, 2); header.writeUInt16BE(1280, 8); header.writeUInt16BE(800, 10);
    const pixels = Buffer.alloc(1280 * 800 * 4);
    for (let y = 0; y < 800; y++) for (let x = 0; x < 1280; x++) {
      const i = (y * 1280 + x) * 4;
      const inside = x > 60 && x < 1220 && y > 50 && y < 750;
      const line = inside && x > 150 && x < 950 && (y > 200 && y < 220 || y > 270 && y < 280 || y > 360 && y < 370);
      const shade = !inside ? 210 : y < 110 ? 232 : line ? 125 : 250;
      pixels[i] = shade; pixels[i + 1] = shade; pixels[i + 2] = shade;
    }
    socket.send(Buffer.concat([header, pixels])); sent = true;
  }
  socket.on("message", (message) => {
    const chunk = Buffer.isBuffer(message) ? message : message instanceof ArrayBuffer ? Buffer.from(message) : Buffer.concat(message);
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 0) {
      if (state === "version") { if (buffer.length < 12) return; buffer = buffer.subarray(12); state = "security"; socket.send(Buffer.from([1, 1])); continue; }
      if (state === "security") { buffer = buffer.subarray(1); state = "shared"; socket.send(Buffer.alloc(4)); continue; }
      if (state === "shared") { buffer = buffer.subarray(1); state = "ready"; init(); continue; }
      const type = buffer[0];
      let length: number;
      if (type === 0) length = 20;
      else if (type === 2) { if (buffer.length < 4) return; length = 4 + buffer.readUInt16BE(2) * 4; }
      else if (type === 3) length = 10;
      else if (type === 4) length = 8;
      else if (type === 5) length = 6;
      else if (type === 6) { if (buffer.length < 8) return; length = 8 + buffer.readUInt32BE(4); }
      else if (type === 150) length = 10;
      else throw new Error(`Unexpected RFB client message ${type}`);
      if (buffer.length < length) return;
      if (type === 4 && input && buffer[1] === 1) keys.push(buffer.readUInt32BE(4));
      buffer = buffer.subarray(length);
      if (type === 3 && !sent) frame();
    }
  });
  socket.send(Buffer.from("RFB 003.008\n"));
}
const remote = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise<void>((resolve) => remote.once("listening", resolve));
const remoteAddress = remote.address(); assert(remoteAddress && typeof remoteAddress !== "string");
remote.on("connection", (socket, request) => desktop(socket, request.url ?? ""));
const remoteOrigin = `ws://127.0.0.1:${remoteAddress.port}`;
async function prepare(page: Page) {
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(`{
    const Native = window.WebSocket;
    function DesktopSocket(url, protocols) {
      const parsed = new URL(url, location.href);
      return new Native(parsed.pathname.startsWith('/screens/') ? ${JSON.stringify(remoteOrigin)} + parsed.pathname : url, protocols);
    }
    DesktopSocket.prototype = Native.prototype;
    Object.setPrototypeOf(DesktopSocket, Native);
    window.WebSocket = DesktopSocket;
  }`);
}
async function shot(page: Page, name: string) {
  await page.evaluate("document.fonts.ready");
  await page.screenshot({ path: `${output}/${name}.png`, animations: "disabled" });
}
async function ready(page: Page) {
  await page.getByRole("button", { name: "Take control", exact: true }).waitFor();
  await page.waitForFunction("document.querySelector('.scr-stream canvas')?.width > 0");
}
async function withinChat(page: Page) {
  await page.waitForFunction(`(() => {
    const view = document.querySelector('.screen'), chat = document.querySelector('.chat'), composer = document.querySelector('.composer');
    if (!view || !chat || !composer || view.dataset.presentation === 'fullscreen') return false;
    const r = view.getBoundingClientRect(), c = chat.getBoundingClientRect(), box = composer.getBoundingClientRect();
    return r.x >= c.x && r.right <= c.right + 1 && r.bottom <= box.y - 23;
  })()`);
  const rect = await page.locator(".screen").boundingBox(), chat = await page.locator(".chat").boundingBox(), composer = await page.locator(".composer").boundingBox();
  assert(rect && chat && composer);
  assert(rect.x >= chat.x && rect.x + rect.width <= chat.x + chat.width + 1);
  assert(rect.y + rect.height <= composer.y - 23, "The floating computer must leave the composer clear.");
  if (await page.locator('.screen[data-presentation="floating"]').count()) assert(Math.abs((rect.height - 92) / rect.width - 10 / 16) < 0.01);
  return rect;
}
async function until(probe: () => Promise<boolean>, message: string) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) { if (await probe()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  assert.fail(message);
}
async function released() { await until(async () => (await client.query(api.bots.get, { botId }))?.takeoverUntil === undefined, "Closing or minimizing must release the take-over."); }

try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "light" });
  await prepare(page);
  await page.goto(`${base}/bots/${botId}`);
  await page.locator("#message").fill("Keep this draft while I watch Atlas.");
  await page.getByRole("button", { name: "Open computer", exact: true }).click();
  await page.locator('.screen[data-presentation="floating"]').waitFor();
  await ready(page);
  assert.equal((await withinChat(page)).width, 640);
  assert.equal(await page.locator(".screen").getAttribute("aria-modal"), null);
  await page.locator("#message").fill("Chat stays usable beside the live computer.");
  const watchAtOpen = watchOpened;
  assert(watchAtOpen >= 1);
  await page.locator(".chat-computer .window-icon, .screen .window-icon").evaluateAll((icons) => {
    for (const icon of icons) { if (icon.getBoundingClientRect().width !== 16 || icon.getBoundingClientRect().height !== 16) throw new Error("Window icon geometry changed"); }
  });
  await shot(page, "desktop-light-floating");
  const drag = await page.getByRole("button", { name: "Move computer window", exact: true }).boundingBox(); assert(drag);
  const before = await withinChat(page);
  await page.mouse.move(drag.x + 100, drag.y + 22); await page.mouse.down(); await page.mouse.move(drag.x - 100, drag.y - 138, { steps: 12 }); await page.mouse.up();
  const moved = await withinChat(page); assert(moved.x < before.x - 100 && moved.y < before.y - 100);
  await page.mouse.move(moved.x + 12, moved.y + 12); await page.mouse.down(); await page.mouse.move(moved.x - 68, moved.y - 38, { steps: 12 }); await page.mouse.up();
  assert((await withinChat(page)).width >= moved.width + 79);
  const handle = page.getByRole("slider", { name: "Resize computer window" });
  await handle.focus(); await page.keyboard.press("Home"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
  assert.equal((await withinChat(page)).width, 416);
  await page.getByRole("button", { name: "Move computer window", exact: true }).focus(); await page.keyboard.press("ArrowRight");
  const saved = await withinChat(page);
  await page.waitForFunction("JSON.parse(localStorage.getItem('bots.computerPlacement') || 'null')?.width === 416");
  assert.equal(watchOpened, watchAtOpen, "Dragging and resizing must not reconnect noVNC.");
  await page.getByRole("button", { name: "Minimize computer window" }).click();
  await page.locator('.screen[data-presentation="minimized"]').waitFor();
  await withinChat(page); assert.equal(await page.locator(".scr-stream canvas").count(), 1);
  assert.equal(await page.locator(".scr-stream canvas").isVisible(), false);
  await page.locator("#message").fill("A draft written while the computer is minimized.");
  await shot(page, "desktop-light-minimized");
  await page.getByRole("button", { name: "Open computer", exact: true }).click(); await ready(page);
  assert.equal(watchOpened, watchAtOpen, "Restoring must reuse the watch stream.");
  await page.getByRole("button", { name: "Move computer window", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.locator('.screen[data-presentation="fullscreen"]').waitFor();
  await page.getByRole("button", { name: "Return to floating view" }).click();
  await page.getByRole("button", { name: "Open full screen", exact: true }).click();
  await page.locator('.screen[data-presentation="fullscreen"]').waitFor();
  assert.equal(await page.locator(".screen").getAttribute("aria-modal"), "true");
  assert.equal(await page.locator("#message").isVisible(), false);
  await page.getByRole("button", { name: "Return to floating view" }).click(); await ready(page);
  assert.equal(watchOpened, watchAtOpen, "Full screen must reuse the watch stream.");
  await withinChat(page);
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await page.getByRole("button", { name: "Give back", exact: true }).waitFor();
  await until(async () => inputOpened >= 1 && activeInputs === 1, "The input stream must open.");
  await page.waitForFunction("document.querySelector('.scr-stream canvas')?.width > 0");
  await page.locator(".scr-stream canvas").click(); await page.keyboard.type("a");
  await until(async () => keys.includes(97), "Real noVNC must send typed input.");
  assert((await client.query(api.bots.get, { botId }))?.takeoverUntil);
  await page.getByRole("button", { name: "Minimize computer window" }).click(); await released();
  await until(async () => activeInputs === 0, "Minimizing closes the input stream.");
  await page.getByRole("button", { name: "Restore computer window" }).click(); await ready(page);
  assert.equal(await page.locator("#message").inputValue(), "A draft written while the computer is minimized.");
  await page.reload(); await ready(page);
  const restored = await withinChat(page);
  assert.equal(restored.width, saved.width); assert.equal(restored.x, saved.x); assert.equal(restored.y, saved.y);
  await page.emulateMedia({ colorScheme: "dark" }); await shot(page, "desktop-dark-compact");
  await page.setViewportSize({ width: 1280, height: 800 }); await withinChat(page);
  await page.locator(".chat-head .pill").click(); await withinChat(page);
  const sidebar = page.getByRole("separator", { name: "Resize bot sidebar" });
  await sidebar.focus(); await page.keyboard.press("End"); await withinChat(page);
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.locator('.screen[data-presentation="fullscreen"]').waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.locator('.screen[data-presentation="floating"]').waitFor(); await withinChat(page);
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await page.getByRole("button", { name: "Give back", exact: true }).waitFor();
  await page.getByRole("button", { name: "Close the screen", exact: true }).click(); await released();
  await page.locator(".screen").waitFor({ state: "detached" });
  rejectConnections = true;
  await page.getByRole("button", { name: "Open computer", exact: true }).click();
  await page.getByRole("button", { name: "Try again", exact: true }).waitFor();
  rejectConnections = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click(); await ready(page);
  await page.getByRole("button", { name: "Close the screen", exact: true }).click();

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "dark" });
  await prepare(phone); await phone.goto(`${base}/bots/${botId}?screen=true`); await ready(phone);
  assert.equal(await phone.locator(".screen").getAttribute("data-presentation"), "fullscreen");
  assert.equal(await phone.getByRole("button", { name: "Minimize computer window" }).count(), 0);
  await phone.getByRole("button", { name: "Take control", exact: true }).click();
  await phone.getByRole("textbox", { name: "Type on the screen" }).waitFor();
  await shot(phone, "phone-control");
  await phone.setViewportSize({ width: 844, height: 390 }); await shot(phone, "phone-landscape-control");
  await phone.getByRole("button", { name: "Close the screen", exact: true }).click(); await released();
  assert.deepEqual(errors, []);
  console.log("verify:floating-computer passed: live noVNC rendering and input, drag and edge resize, keyboard controls, composer clearance, storage, minimize/restore and full-screen stream continuity, take-over release, retries, responsive fallback, phone controls, and themes.");
  console.log(`Screenshots: ${output}`);
} catch (error) {
  const current = browser.contexts()[0]?.pages()[0];
  if (current) {
    await shot(current, "failure");
    console.error(await current.evaluate("JSON.stringify({screen:document.querySelector('.screen')?.getAttribute('data-presentation'),chat:document.querySelector('.chat')?.getBoundingClientRect().toJSON(),composer:document.querySelector('.composer')?.getBoundingClientRect().toJSON()})"));
  }
  console.error(errors);
  throw error;
} finally {
  await browser.close();
  for (const socket of remote.clients) socket.terminate();
  await new Promise<void>((resolve) => remote.close(() => resolve()));
  await client.mutation(api.bots.remove, { botId });
}
