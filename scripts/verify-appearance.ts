import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { api } from "@bots/convex";
import { ConvexHttpClient } from "convex/browser";
import { chromium } from "playwright";
import { paths, readEnvFile } from "./lib.ts";

const base = process.argv[2] ?? "http://127.0.0.1:5175";
const destination = process.env.APPEARANCE_SCREENSHOTS ?? "/tmp/bots-appearance/verification";
assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname), "Use the isolated local app.");
const convexUrl = readEnvFile(paths.convexEnv).CONVEX_SELF_HOSTED_URL ?? "http://127.0.0.1:3210";
assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(convexUrl).hostname), "Use local Convex.");
const response = await fetch(`${base}/auth/token`);
const auth: unknown = await response.json();
assert(response.ok && typeof auth === "object" && auth !== null && "token" in auth && typeof auth.token === "string", "Start the isolated authenticated dev app.");
const client = new ConvexHttpClient(convexUrl);
client.setAuth(auth.token);
await client.mutation(api.users.ensureCurrent, { browserTimeZone: "Europe/Stockholm" });
const botId = await client.mutation(api.bots.create, { name: "Atlas", shape: "ball", color: "green" });
const createdIds = [botId];
const createdName = `Appearance verification ${Date.now()}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "light", reducedMotion: "reduce" });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(10_000);
await mkdir(destination, { recursive: true });
let hold = false;
let rejectNext = false;
let holdCreate = false;
const releases: (() => void)[] = [];
const intents: unknown[] = [];
await page.routeWebSocket(/\/sync/, (socket) => {
  const server = socket.connectToServer();
  socket.onMessage((message) => {
    const parsed: unknown = JSON.parse(message.toString());
    if (typeof parsed === "object" && parsed !== null && "udfPath" in parsed && parsed.udfPath === "bots:create" && holdCreate) {
      releases.push(() => server.send(message));
      return;
    }
    if (typeof parsed !== "object" || parsed === null || !("udfPath" in parsed) || parsed.udfPath !== "bots:setCharacter") {
      server.send(message);
      return;
    }
    assert("args" in parsed && Array.isArray(parsed.args));
    intents.push(parsed.args[0]);
    const outgoing = rejectNext ? JSON.stringify({ ...parsed, args: [{ botId }] }) : message;
    rejectNext = false;
    if (hold) releases.push(() => server.send(outgoing));
    else server.send(outgoing);
  });
});
async function appearance() {
  await page.locator(".chat-head .pill").waitFor();
  if (!await page.locator(".info").isVisible()) await page.locator(".chat-head .pill").click();
  await page.getByRole("button", { name: /Appearance Choose/ }).click();
}
async function saved(expected: { shape: string; color: string }) {
  await assertEventually(async () => {
    const bot = await client.query(api.bots.get, { botId });
    assert.equal(bot?.shape, expected.shape);
    assert.equal(bot?.color, expected.color);
  });
}
async function assertEventually(check: () => Promise<void>) {
  for (let attempt = 0; ; attempt++) {
    try { await check(); return; }
    catch (error) {
      if (attempt === 40) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
async function screenshot(name: string) {
  await page.evaluate("document.fonts.ready.then(() => undefined)");
  await page.screenshot({ path: join(destination, `${name}.png`), animations: "disabled" });
}
function release() { hold = false; for (const send of releases.splice(0)) send(); }
try {
  await assert.rejects(client.mutation(api.bots.setCharacter, { botId }), /Choose a color or shape/);
  const anonymous = new ConvexHttpClient(convexUrl);
  await assert.rejects(anonymous.mutation(api.bots.setCharacter, { botId, color: "red" }));
  await page.goto(`${base}/bots/${botId}`);
  await page.locator("#message").fill("Keep this chat draft.");
  await page.locator(".chat-head .pill").click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Keep this profile draft");
  const entry = page.getByRole("button", { name: /Appearance Choose/ });
  await entry.click();
  assert.equal(await page.getByRole("group", { name: "Color", exact: true }).getByRole("radio").count(), 12);
  assert.equal(await page.getByRole("group", { name: "Shape", exact: true }).getByRole("radio").count(), 6);
  hold = true;
  await page.getByRole("radio", { name: "Lilac", exact: true }).check();
  await page.getByRole("radio", { name: "Squircle", exact: true }).check();
  await page.locator('.character-preview [data-color="purple"][data-shape="flower"]').waitFor();
  await page.locator('.chat-head [data-color="purple"][data-shape="flower"]').waitFor();
  await page.locator(".bot-nav").getByRole("link", { name: "Atlas", exact: true }).locator('[data-color="purple"][data-shape="flower"]').waitFor();
  await saved({ shape: "ball", color: "green" });
  release();
  await saved({ shape: "flower", color: "purple" });
  assert.deepEqual(intents.slice(0, 2), [{ botId, color: "purple" }, { botId, shape: "flower" }]);
  await screenshot("desktop-light");
  await page.getByRole("button", { name: "Bot details", exact: true }).click();
  assert(await entry.evaluate((element) => element === element.ownerDocument.activeElement), "Back restores focus to Appearance.");
  assert.equal(await page.getByRole("textbox", { name: "Name", exact: true }).inputValue(), "Keep this profile draft");
  assert.equal(await page.locator("#message").inputValue(), "Keep this chat draft.");
  await entry.click();
  hold = true;
  for (const name of ["Blue", "Peach", "Rose"]) await page.getByRole("radio", { name, exact: true }).check();
  await page.locator('.character-preview [data-color="pink"]').waitFor();
  await page.getByRole("button", { name: "Close appearance" }).click();
  release();
  await saved({ shape: "flower", color: "pink" });
  await page.reload();
  await appearance();
  assert(await page.getByRole("radio", { name: "Rose", exact: true }).isChecked());
  assert(await page.getByRole("radio", { name: "Squircle", exact: true }).isChecked());
  await page.getByRole("radio", { name: "Rose", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await saved({ shape: "flower", color: "teal" });
  assert(await page.getByRole("radio", { name: "Teal", exact: true }).isChecked());
  await client.mutation(api.bots.setCharacter, { botId, shape: "hex" });
  await page.getByRole("radio", { name: "Hexagon", exact: true }).waitFor();
  hold = true;
  await page.getByRole("radio", { name: "Lemon", exact: true }).check();
  await client.mutation(api.bots.setCharacter, { botId, shape: "bean" });
  release();
  await saved({ shape: "bean", color: "lemon" });
  await page.locator('.character-preview [data-shape="bean"]').waitFor();
  rejectNext = true;
  await page.getByRole("radio", { name: "Coral", exact: true }).check();
  await page.getByRole("alert").filter({ hasText: "Couldn't save appearance" }).waitFor();
  await page.locator('.character-preview [data-color="lemon"]').waitFor();
  await saved({ shape: "bean", color: "lemon" });
  await client.mutation(api.bots.setCharacter, { botId, shape: "tile" });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await saved({ shape: "tile", color: "red" });
  assert.deepEqual(intents.at(-1), { botId, color: "red" }, "Retry preserves the untouched remote field.");
  assert.equal(await page.getByRole("alert").count(), 0);
  hold = true; rejectNext = true;
  await page.getByRole("radio", { name: "Blue", exact: true }).check();
  await page.getByRole("radio", { name: "Honey", exact: true }).check();
  release();
  await saved({ shape: "tile", color: "amber" });
  assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).count(), 0, "An obsolete failure cannot offer a stale Retry.");
  hold = true; rejectNext = true;
  await page.getByRole("radio", { name: "Graphite", exact: true }).check();
  await page.getByRole("radio", { name: "Oval", exact: true }).check();
  release();
  await saved({ shape: "egg", color: "amber" });
  await page.getByRole("alert").filter({ hasText: "Couldn't save appearance" }).waitFor();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await saved({ shape: "egg", color: "black" });
  assert.deepEqual(intents.at(-1), { botId, color: "black" }, "A later shape choice must not discard a failed color choice.");
  await page.getByRole("radio", { name: "Square", exact: true }).check();
  await saved({ shape: "tile", color: "black" });
  hold = true; rejectNext = true;
  await page.getByRole("radio", { name: "Mist", exact: true }).check();
  await page.getByRole("button", { name: "Close appearance" }).click();
  release();
  await appearance();
  await page.getByRole("alert").filter({ hasText: "Couldn't save appearance" }).waitFor();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await saved({ shape: "tile", color: "grey" });
  hold = true; rejectNext = true;
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByRole("radio", { name: "Oval", exact: true }).check();
  release();
  await saved({ shape: "egg", color: "grey" });
  await page.getByRole("alert").filter({ hasText: "Couldn't save appearance" }).waitFor();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await saved({ shape: "egg", color: "green" });
  assert.deepEqual(intents.at(-1), { botId, color: "green" }, "Retry of a failed Reset must preserve a newer shape choice.");
  hold = true;
  await page.getByRole("radio", { name: "Lemon", exact: true }).check();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  release();
  await saved({ shape: "ball", color: "green" });
  assert.deepEqual(intents.at(-1), { botId, shape: "ball", color: "green" });
  await page.reload(); await appearance();
  assert(await page.getByRole("radio", { name: "Sage", exact: true }).isChecked());
  assert(await page.getByRole("radio", { name: "Round", exact: true }).isChecked());
  for (const name of ["Sage", "Blue", "Peach", "Lilac", "Rose", "Teal", "Honey", "Clay", "Coral", "Mist", "Graphite", "Lemon"]) {
    await page.getByRole("radio", { name, exact: true }).check();
  }
  for (const name of ["Round", "Square", "Oval", "Squircle", "Hexagon", "Capsule"]) {
    await page.getByRole("radio", { name, exact: true }).check();
  }
  await saved({ shape: "bean", color: "lemon" });
  await page.getByRole("radio", { name: "Lilac", exact: true }).check();
  await page.getByRole("radio", { name: "Squircle", exact: true }).check();
  await saved({ shape: "flower", color: "purple" });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      await page.setViewportSize(viewport);
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      assert.equal(await page.locator(".appearance-panel").evaluate((el) => el.scrollWidth > el.clientWidth), false);
      await screenshot(`${viewport.width === 1440 ? "desktop" : `mobile-${viewport.width}`}-${theme}`);
      await page.getByRole("button", { name: "Reset", exact: true }).scrollIntoViewIfNeeded();
      assert(await page.getByRole("button", { name: "Reset", exact: true }).isVisible());
      if (viewport.width === 320) await screenshot(`mobile-320-${theme}-scrolled`);
      await page.locator(".appearance-panel").evaluate((el) => el.scrollTop = 0);
    }
  }
  await page.getByRole("button", { name: "Close appearance" }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "New bot", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Cancel appearance check");
  await page.getByRole("radio", { name: "Lemon", exact: true }).check();
  await page.getByRole("radio", { name: "Capsule", exact: true }).check();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert(!(await client.query(api.bots.list)).some((bot) => bot.name === "Cancel appearance check"));
  await page.getByRole("button", { name: "New bot", exact: true }).click();
  assert(await page.getByRole("radio", { name: "Sage", exact: true }).isChecked());
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Nova");
  await page.getByRole("radio", { name: "Lilac", exact: true }).check();
  await page.getByRole("radio", { name: "Squircle", exact: true }).check();
  for (const theme of ["light", "dark"]) {
    await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      await page.setViewportSize(viewport);
      assert.equal(await page.locator(".appearance-create").evaluate((el) => el.scrollWidth > el.clientWidth), false);
      await screenshot(`creation-${viewport.width === 1440 ? "desktop" : `mobile-${viewport.width}`}-${theme}`);
      await page.getByRole("button", { name: "Create bot", exact: true }).scrollIntoViewIfNeeded();
      assert(await page.getByRole("button", { name: "Create bot", exact: true }).isVisible());
      await page.locator(".appearance-create").evaluate((el) => el.scrollTop = 0);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(createdName);
  holdCreate = true;
  await page.getByRole("button", { name: "Create bot", exact: true }).click();
  assert(await page.getByRole("textbox", { name: "Name", exact: true }).isDisabled());
  assert(await page.getByRole("radio", { name: "Lilac", exact: true }).isDisabled());
  assert(await page.getByRole("button", { name: "Cancel", exact: true }).isDisabled());
  assert.equal((await client.query(api.bots.list)).filter((bot) => bot.name === createdName).length, 0, "Creation stays staged until the pending request runs.");
  holdCreate = false; release();
  await page.locator('dialog[aria-label="Create a bot"]').waitFor({ state: "detached" });
  await page.locator(".chat-head .pill").waitFor();
  const created = (await client.query(api.bots.list)).find((bot) => bot.name === createdName);
  assert(created); createdIds.push(created._id);
  assert.equal(created.shape, "flower"); assert.equal(created.color, "purple");
  assert.deepEqual(errors, []);
  console.log(`Appearance persistence, optimistic rollback/retry, rapid field intents, remote updates, keyboard, reset, drafts, creation/cancel and responsive screenshots passed. Screenshots: ${destination}`);
} finally {
  release();
  await browser.close();
  for (const bot of await client.query(api.bots.list)) {
    if (bot.name === createdName && !createdIds.includes(bot._id)) createdIds.push(bot._id);
  }
  for (const botId of createdIds) await client.mutation(api.bots.remove, { botId });
}
