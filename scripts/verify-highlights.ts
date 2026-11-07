import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { ConvexHttpClient } from "convex/browser";
import { decodeJwt, importJWK, SignJWT } from "jose";
import { chromium, type BrowserContextOptions, type Page } from "playwright";
import { parsePrivateJwk, paths, readEnvFile } from "./lib.ts";

const base = "http://localhost:5173";
const output = process.env.DESIGN_SCREENSHOTS ?? "/tmp/bots-design-review";
const response = await fetch(`${base}/auth/token`);
const body: unknown = await response.json();
assert(response.ok && typeof body === "object" && body !== null && "token" in body && typeof body.token === "string", "Start pnpm dev before verify:highlights.");
const { iss, aud } = decodeJwt(body.token);
assert(typeof iss === "string" && typeof aud === "string");
const issuer = iss;
const audience = aud;
const rawKey = readEnvFile(paths.rootEnv).JWT_PRIVATE_JWK;
assert(rawKey);
const jwk = parsePrivateJwk(rawKey);
const key = await importJWK(jwk, "ES256");
async function tokenFor(subject: string) {
  return new SignJWT({ email: `${subject}@localhost`, name: "Design Review" })
    .setProtectedHeader({ alg: "ES256", kid: jwk.kid, typ: "JWT" })
    .setSubject(subject).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("1h").sign(key);
}
const token = await tokenFor(`dev:verify-highlights-${Date.now()}`);
const url = readEnvFile(paths.convexEnv).CONVEX_SELF_HOSTED_URL;
assert(url);
const client = new ConvexHttpClient(url, { logger: false });
client.setAuth(token);
await client.mutation(api.users.ensureCurrent, {});
const ids: Id<"bots">[] = [];
const browser = await chromium.launch();
const errors: string[] = [];
async function openPage(options: BrowserContextOptions = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
  await context.route("**/auth/token", (route) => route.fulfill({ json: { token } }));
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator('.bot-list [data-bot-id]').first().waitFor();
  return page;
}
function bot(page: Page, id: Id<"bots">) { return page.locator(`[data-bot-id="${id}"]`); }
async function mouseDrop(page: Page, id: Id<"bots">, target: "top" | "list" | Id<"bots">) {
  const source = await bot(page, id).boundingBox();
  assert(source);
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 + 10, source.y + source.height / 2, { steps: 3 });
  await page.locator(".highlights").waitFor();
  const destination = await (target === "top" ? page.locator(".highlights") : target === "list" ? page.locator(".bot-list") : bot(page, target)).boundingBox();
  assert(destination);
  await page.mouse.move(target === "top" ? destination.x + destination.width - 3 : destination.x + destination.width / 2, target === "top" ? destination.y + 3 : destination.y + 25, { steps: 15 });
  await page.mouse.up();
  await page.locator('nav[aria-busy="false"]').waitFor();
}
async function count(page: Page, expected: number) {
  await page.waitForFunction(`document.querySelectorAll('.highlight-tile').length === ${expected}`);
  await page.locator('nav[aria-busy="false"]').waitFor();
}
async function saved() { return (await client.query(api.users.current))?.highlightedBotIds ?? []; }
async function screenshot(page: Page, name: string) {
  await page.evaluate("document.fonts.ready");
  await page.screenshot({ path: `${output}/highlights-${name}.png`, animations: "disabled" });
}
async function centered(page: Page) {
  const group = await page.locator(".highlights").boundingBox();
  const boxes = await Promise.all((await page.locator(".highlight-tile").all()).map((item) => item.boundingBox()));
  const first = boxes[0], last = boxes.at(-1);
  assert(group && first && last);
  assert(Math.abs((first.x + last.x + last.width) / 2 - (group.x + group.width / 2)) < 1, "One or two highlights must be centered.");
  for (const button of await page.locator(".highlights .highlight-button").all()) {
    const square = await button.boundingBox(), name = await button.locator(".highlight-name").boundingBox();
    assert(square && name && square.width === square.height && name.y + name.height <= square.y + square.height, "The name stays inside its square.");
  }
}
async function resize(page: Page, width: number) {
  const border = page.getByRole("separator", { name: "Resize bot sidebar" });
  const box = await border.boundingBox(); assert(box);
  const before = await page.locator(".side").boundingBox(); assert(before);
  await page.mouse.move(box.x + box.width / 2, 480);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + width - before.width, 480, { steps: 12 });
  await page.mouse.up();
  assert.equal((await page.locator(".side").boundingBox())?.width, Math.max(88, Math.min(400, width)));
}
async function grid(page: Page, columns: number) {
  const boxes = await Promise.all((await page.locator(".highlight-tile").all()).map((item) => item.boundingBox()));
  assert(boxes.every((box) => box !== null));
  assert.equal(new Set(boxes.map((box) => box?.x)).size, columns);
  const sidebar = await page.locator(".side").boundingBox(); assert(sidebar);
  for (const box of boxes) assert(box && box.x >= sidebar.x && box.x + box.width <= sidebar.x + sidebar.width, "Highlights stay inside the sidebar.");
  assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
}
try {
  await mkdir(output, { recursive: true });
  for (const [name, color] of [["Atlas", "green"], ["Scout", "blue"], ["Milo", "orange"], ["Nova", "blue"], ["River", "green"]] as const) {
    ids.push(await client.mutation(api.bots.create, { name, color, shape: "ball" }));
  }
  const [atlas, scout, milo, nova, river] = ids;
  assert(atlas && scout && milo && nova && river);
  const page = await openPage();
  await bot(page, atlas).click();
  assert.equal(await page.locator(".side h1").count(), 0);
  assert.equal(await page.locator(".highlights").count(), 0);
  assert.equal((await page.getByRole("button", { name: "New bot", exact: true }).boundingBox())?.y, 20);
  await screenshot(page, "none-light");
  await mouseDrop(page, atlas, "top"); await count(page, 1); await centered(page);
  assert.deepEqual(await saved(), [atlas]); await screenshot(page, "one-light");
  await mouseDrop(page, scout, "top"); await count(page, 2); await centered(page);
  assert.deepEqual(await saved(), [atlas, scout]); await screenshot(page, "two-light");
  await mouseDrop(page, milo, "top"); await count(page, 3);
  await mouseDrop(page, nova, "top"); await count(page, 4); await grid(page, 2);
  await screenshot(page, "four-standard-light");
  await mouseDrop(page, river, "top"); await page.getByRole("alert").waitFor();
  assert.deepEqual(await saved(), [atlas, scout, milo, nova], "A fifth bot must not replace a highlight.");
  await mouseDrop(page, atlas, milo);
  assert.deepEqual(await saved(), [scout, milo, atlas, nova], "Dragging changes highlight order.");
  await page.reload(); await count(page, 4);
  const secondPage = await openPage(); await count(secondPage, 4);
  assert.deepEqual(await secondPage.locator(".highlight-name").allTextContents(), ["Scout", "Milo", "Atlas", "Nova"]);
  await secondPage.close();
  await page.evaluate("document.documentElement.dataset.theme='dark'"); await screenshot(page, "four-standard-dark");
  await resize(page, 400); await grid(page, 4); await screenshot(page, "four-wide-dark");
  await resize(page, 500); await grid(page, 4);
  await resize(page, 176); await grid(page, 1); await screenshot(page, "four-narrow-dark");
  await resize(page, 88); await grid(page, 1); await screenshot(page, "four-compact-dark");
  assert.equal(await page.locator('.side .highlight-name:visible, .side .row-text:visible, .side .me-name:visible').count(), 0);
  assert.equal(await bot(page, atlas).getAttribute("aria-label"), "Atlas");
  await page.reload(); await count(page, 4);
  assert.equal((await page.locator(".side").boundingBox())?.width, 88, "Sidebar width persists after reload.");
  await mouseDrop(page, atlas, scout); await count(page, 4);
  assert.deepEqual(await saved(), [atlas, scout, milo, nova], "The compact rail supports reordering.");
  await mouseDrop(page, nova, "list"); await count(page, 3);
  await mouseDrop(page, nova, "top"); await count(page, 4);
  const border = page.getByRole("separator", { name: "Resize bot sidebar" });
  await border.focus(); await page.keyboard.press("End"); assert.equal(await border.getAttribute("aria-valuenow"), "400");
  await page.keyboard.press("Home"); await page.keyboard.press("ArrowLeft"); assert.equal(await border.getAttribute("aria-valuenow"), "88");
  await page.keyboard.press("ArrowRight"); assert.equal(await border.getAttribute("aria-valuenow"), "96");
  await border.dblclick(); assert.equal((await page.locator(".side").boundingBox())?.width, 264);
  await page.evaluate("localStorage.setItem('bots.sidebarWidth', 'invalid')"); await page.reload(); await count(page, 4);
  assert.equal((await page.locator(".side").boundingBox())?.width, 264, "Invalid saved widths fall back to the standard layout.");
  for (const id of [scout, milo, atlas, nova]) await mouseDrop(page, id, "list");
  await count(page, 0); assert.equal(await page.locator(".highlights").count(), 0);
  await bot(page, atlas).focus(); await page.keyboard.press("Space"); await page.locator(".highlights").waitFor();
  await page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await page.keyboard.press("ArrowUp"); await page.locator('.highlights[data-over="true"]').waitFor(); await page.keyboard.press("Space"); await count(page, 1);
  await bot(page, atlas).focus(); await page.keyboard.press("Space"); await bot(page, atlas).locator('xpath=self::*[@data-dragging="true"]').waitFor();
  await page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await page.keyboard.press("ArrowDown"); await page.locator('.bot-list[data-over="true"]').waitFor(); await page.keyboard.press("Space"); await count(page, 0);
  const mobile = await openPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.evaluate("localStorage.setItem('bots.sidebarWidth', '88')"); await mobile.reload();
  await bot(mobile, atlas).waitFor();
  assert.equal((await mobile.locator(".side").boundingBox())?.width, 390, "A saved desktop rail does not constrain the phone list.");
  const cdp = await mobile.context().newCDPSession(mobile);
  async function touchHighlight(id: Id<"bots">) {
    const source = await bot(mobile, id).boundingBox(); assert(source);
    const start = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start, id: 1 }] });
    await mobile.waitForTimeout(300);
    await mobile.locator(".highlights").waitFor();
    const target = await mobile.locator(".highlights").boundingBox(); assert(target);
    for (let step = 1; step <= 12; step++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x + (target.x + target.width - 3 - start.x) * step / 12, y: start.y + (target.y + 3 - start.y) * step / 12, id: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
  await touchHighlight(atlas); await count(mobile, 1); await centered(mobile);
  await touchHighlight(scout); await count(mobile, 2); await centered(mobile);
  await screenshot(mobile, "two-mobile-light");
  await mobile.evaluate("document.documentElement.dataset.theme='dark'"); await screenshot(mobile, "two-mobile-dark");
  await touchHighlight(milo); await count(mobile, 3);
  await touchHighlight(nova); await count(mobile, 4); await grid(mobile, 2);
  assert.equal(await mobile.getByRole("separator").count(), 0, "Phones do not expose resizing.");
  await screenshot(mobile, "four-mobile-dark");
  await client.mutation(api.bots.setHighlight, { botId: milo, position: null });
  await client.mutation(api.bots.setHighlight, { botId: nova, position: null });
  await count(mobile, 2);
  const longName = "A thoughtful assistant with a much longer name";
  const extraIds: Id<"bots">[] = [];
  for (let index = 0; index < 6; index++) {
    const id = await client.mutation(api.bots.create, { name: index === 0 ? longName : `Extra ${index}`, color: "green", shape: "ball" });
    ids.push(id); extraIds.push(id);
  }
  const last = extraIds.at(-1), longBot = extraIds[0]; assert(last && longBot);
  await bot(mobile, last).waitFor({ state: "attached" });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 180, y: 650, id: 1 }] });
  for (let step = 1; step <= 10; step++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 180, y: 650 - step * 15, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await mobile.waitForFunction("document.querySelector('.bot-nav').scrollTop > 0");
  assert.equal(await mobile.locator(".highlight-ghost").count(), 0, "Swiping the list scrolls without starting a drag.");
  await client.mutation(api.bots.setHighlight, { botId: longBot, position: 2 });
  await mobile.reload(); await count(mobile, 3);
  assert.equal(await bot(mobile, longBot).getAttribute("title"), longName);
  assert.equal(await mobile.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
  await screenshot(mobile, "long-name-mobile");
  const stranger = new ConvexHttpClient(url, { logger: false });
  stranger.setAuth(await tokenFor(`dev:verify-highlights-stranger-${Date.now()}`));
  await stranger.mutation(api.users.ensureCurrent, {});
  await assert.rejects(stranger.mutation(api.bots.setHighlight, { botId: atlas, position: 0 }), /Bot not found/);
  await assert.rejects(new ConvexHttpClient(url, { logger: false }).mutation(api.bots.setHighlight, { botId: atlas, position: 0 }), /Not authenticated/);
  for (const position of [-1, 0.5, 4]) await assert.rejects(client.mutation(api.bots.setHighlight, { botId: atlas, position }), /position/);
  await client.mutation(api.bots.setHighlight, { botId: atlas, position: 0 });
  assert.deepEqual(await saved(), [atlas, scout, longBot], "Repeated highlighting must not duplicate a bot.");
  await client.mutation(api.bots.remove, { botId: atlas });
  assert.deepEqual(await saved(), [scout, longBot], "Deleting a bot removes its highlight.");
  assert.deepEqual(errors, []);
  console.log("verify:highlights passed: mouse, touch, keyboard, touch scrolling, long names, 0–4 states, centering, square names, reordering, border and keyboard resizing, width bounds and persistence, responsive grids, compact rail, capacity, ownership, invalid input, and deletion.");
  console.log(`Screenshots: ${output}`);
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: `${output}/highlights-failure-${Date.now()}.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  for (const botId of ids) if (await client.query(api.bots.get, { botId })) await client.mutation(api.bots.remove, { botId });
}
