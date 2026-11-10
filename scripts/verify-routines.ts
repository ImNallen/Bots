import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { ConvexHttpClient } from "convex/browser";
import { chromium, type Browser, type CDPSession, type Locator, type Page } from "playwright";
import { paths, readEnvFile, runConvex } from "./lib.ts";

const base = process.argv[2] ?? "http://localhost:5173";
const destination = process.env.DESIGN_SCREENSHOTS ?? "/tmp/bots-routines-review";
const convexUrl = readEnvFile(paths.convexEnv).CONVEX_SELF_HOSTED_URL ?? "http://127.0.0.1:3210";
const tokenResponse = await fetch(`${base}/auth/token`);
const body: unknown = await tokenResponse.json();
assert(tokenResponse.ok && typeof body === "object" && body !== null && "token" in body && typeof body.token === "string", "Start the local dev app before running verify:routines.");
const client = new ConvexHttpClient(convexUrl);
client.setAuth(body.token);
await client.mutation(api.users.ensureCurrent, { browserTimeZone: "Europe/Stockholm" });
await client.mutation(api.users.setTimeZone, { timeZone: "Europe/Stockholm" });
const name = `Routines review ${Date.now()}`;
const botId = await client.mutation(api.bots.create, { name, shape: "ball", color: "green" });
await client.mutation(api.bots.setProfile, { botId, name, title: "Your everyday assistant", description: "" });
await mkdir(destination, { recursive: true });

const WATCH = {
  title: "Deadlock patch watch",
  summary: "Tells you in chat when Valve ships a new Deadlock patch, hero, or ranked change.",
  steps: [
    "Reads the Deadlock Wiki, unDeadlock, PatchBot, and Valve's Steam news.",
    "Compares them with the last update it told you about.",
    "If something is new, posts a short summary: date, heroes, items, ranked changes.",
    "If nothing is new, says so in one line.",
  ],
  instruction: "Check the Deadlock Wiki, unDeadlock, PatchBot, and Valve's Steam news for a new patch. Compare with the last report. Post a short summary of anything new.",
};
const LEGACY_INSTRUCTION = "Look through the Stockholm city council's agenda pages for anything about bike lanes on Södermalm and report it";

type Listed = NonNullable<Awaited<ReturnType<typeof listed>>>[number];
async function listed() {
  return (await client.query(api.schedules.listForBot, { botId }))?.routines ?? [];
}
async function routineNamed(title: string): Promise<Listed> {
  const routine = (await listed()).find((row) => row.title === title);
  assert(routine, `${title} exists`);
  return routine;
}
function check(name: string, args: object) {
  const result = runConvex(["run", `scheduleChecks:${name}`, JSON.stringify(args)]);
  assert(result.kind === "ok", result.kind === "failed" ? result.output : "");
}
async function seed(fields: { title?: string; summary?: string; steps?: string[]; instruction: string; cadence: object; active: boolean }) {
  const { active, ...args } = fields;
  check("createForCheck", { botId, ...args });
  const routine = (await listed()).find((row) => (fields.title === undefined ? row.kind === "live" && row.summary === undefined && row.steps === undefined : row.title === fields.title));
  assert(routine);
  if (active) {
    await client.mutation(api.schedules.resume, { scheduleId: routine._id });
  }
  return routine._id;
}
async function waitFor(what: string, test: () => Promise<boolean>, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (!(await test())) {
    assert(Date.now() < until, what);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
async function screenshot(page: Page, file: string) {
  await page.evaluate("document.fonts.ready");
  await page.screenshot({ path: join(destination, `${file}.png`) });
  shots.push(join(destination, `${file}.png`));
}
async function touchDrag(cdp: CDPSession, target: Locator, dx: number, dy: number) {
  const box = await target.boundingBox();
  assert(box);
  const x = box.x + box.width - 60;
  const y = box.y + box.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 10; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dx * step) / 10, y: y + (dy * step) / 10 }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function openRoutines(page: Page) {
  await page.goto(`${base}/bots/${botId}?routines=true`);
  await page.locator(".info .routines-panel").waitFor();
}

const shots: string[] = [];
const errors: string[] = [];
const watchId = await seed({ ...WATCH, cadence: { kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], hour: 10, minute: 0 }, active: true });
await seed({ title: "Morning reading", summary: "Reads three long articles.", steps: ["Picks three articles."], instruction: "Pick three long articles and summarise them.", cadence: { kind: "weekly", weekdays: [1, 2, 3, 4, 5], hour: 8, minute: 0 }, active: true });
await seed({ title: "Weekly discoveries", summary: "Finds new music.", steps: ["Finds new albums."], instruction: "Find three new albums I would like.", cadence: { kind: "weekly", weekdays: [5], hour: 16, minute: 0 }, active: true });
await seed({ title: "Stockholm watch", summary: "Watches the city news.", steps: ["Reads the city news."], instruction: "Read Stockholm city news.", cadence: { kind: "weekly", weekdays: [1], hour: 9, minute: 0 }, active: false });
await seed({ instruction: LEGACY_INSTRUCTION, cadence: { kind: "everyHours", hours: 6 }, active: false });
check("seedRunsForCheck", { scheduleId: watchId, count: 1, state: { kind: "failed", reason: "Valve's news page did not load." }, endedAt: Date.now() - 60_000 });
check("seedRunsForCheck", { scheduleId: watchId, count: 1, state: { kind: "done" }, endedAt: Date.now() });

let browser: Browser | undefined;
try {
  browser = await chromium.launch();
  for (const theme of ["light", "dark"] as const) {
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: theme });
    desktop.on("pageerror", (error) => errors.push(error.message));
    desktop.setDefaultTimeout(15_000);
    await openRoutines(desktop);
    await desktop.locator(`html[data-theme="${theme}"]`).waitFor();
    const legacyTitle = await desktop.locator(".routine-title").filter({ hasText: "Look through" }).textContent();
    assert(legacyTitle?.endsWith("…") && [...legacyTitle].length <= 60, `A routine made before titles shows the start of its instruction, cut to 60 characters: ${legacyTitle}`);
    assert.equal(await desktop.getByText("Test now").count(), 0, "Test now is gone.");
    await screenshot(desktop, `desktop-${theme}-list`);

    await desktop.getByRole("button", { name: `Details for ${WATCH.title}`, exact: true }).click();
    const detail = desktop.locator(".routine-detail");
    await detail.getByRole("heading", { name: WATCH.title }).waitFor();
    await detail.getByText(WATCH.summary).waitFor();
    assert.equal(await detail.locator(".routine-when-cadence").textContent(), "Every day at 10:00");
    assert.match((await detail.locator(".routine-when-next").first().textContent()) ?? "", /^Next run .* · Europe\/Stockholm$/);
    assert.deepEqual(await detail.locator(".routine-steps li").allTextContents(), WATCH.steps.map((step, index) => `${index + 1}${step}`));
    assert.deepEqual(await detail.locator(".routine-limits li").allTextContents(), ["Read only", "Logged out", "Reports in this chat"]);
    assert.deepEqual(await detail.locator(".routine-run-words").allTextContents(), ["Succeeded", "Failed: Valve's news page did not load."]);
    assert.equal(await desktop.locator(".routines-panel").getByRole("button", { name: /Delete|Test now|Change in chat/ }).count(), 0, "The details have no action buttons.");
    assert.equal(await desktop.getByText(WATCH.instruction).count(), 0, "The raw instruction shows nowhere in the panel.");
    await desktop.getByText("Results arrive in your conversation.").waitFor();
    await screenshot(desktop, `desktop-${theme}-detail`);
    await desktop.getByRole("button", { name: "All routines", exact: true }).click();

    await desktop.getByRole("button", { name: /^Details for Look through/ }).click();
    assert.equal(await desktop.locator(".routine-head p").count(), 0, "An older routine has no description line.");
    assert.equal(await desktop.getByRole("region", { name: "What it does" }).count(), 0, "An older routine has no steps.");
    await desktop.getByRole("button", { name: "All routines", exact: true }).click();

    const morning = desktop.getByRole("button", { name: "Details for Morning reading", exact: true });
    await morning.click({ button: "right" });
    const menu = desktop.getByRole("menu");
    await menu.getByRole("menuitem", { name: "Delete routine" }).waitFor();
    assert.equal(await desktop.locator('.routine-item[data-selected="true"] .routine-title').textContent(), "Morning reading", "The row stays highlighted while its menu is open.");
    await screenshot(desktop, `desktop-${theme}-menu`);
    await desktop.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert(await morning.evaluate((element) => element === element.ownerDocument.activeElement), "Escape gives focus back to the row.");
    await morning.click({ button: "right" });
    await desktop.mouse.click(5, 500);
    await menu.waitFor({ state: "detached" });

    const morningRoutine = await routineNamed("Morning reading");
    assert(morningRoutine.kind === "live");
    await morning.focus();
    await desktop.keyboard.press("Shift+F10");
    await desktop.getByRole("menuitem", { name: "Delete routine" }).waitFor();
    await desktop.keyboard.press("Enter");
    const undoLine = desktop.locator(".routine-deleted").filter({ hasText: "Morning reading deleted." });
    await undoLine.waitFor();
    const deleted = await routineNamed("Morning reading");
    assert.equal(deleted.kind, "deleted", "The server holds the routine as deleted during its window.");
    const nextNote = (await desktop.locator(".routines-panel > .panel-note").first().textContent()) ?? "";
    assert(/10:00/.test(nextNote) && !/8:00/.test(nextNote), `The next run note counts only live routines: ${nextNote}`);
    await screenshot(desktop, `desktop-${theme}-undo`);
    await undoLine.getByRole("button", { name: "Undo" }).click();
    await morning.waitFor();
    const restored = await routineNamed("Morning reading");
    assert(restored.kind === "live" && restored.nextFireAt === morningRoutine.nextFireAt, "Undo gives the routine back its own next run.");

    await desktop.getByRole("button", { name: "Details for Stockholm watch", exact: true }).click({ button: "right" });
    await desktop.getByRole("menuitem", { name: "Delete routine" }).click();
    await desktop.locator(".routine-deleted").filter({ hasText: "Stockholm watch deleted." }).waitFor();
    await desktop.locator(".routine-deleted").waitFor({ state: "detached", timeout: 12_000 });
    await waitFor("The routine is gone for good after its window", async () => !(await listed()).some((row) => row.title === "Stockholm watch"));
    assert.equal(await desktop.getByRole("button", { name: "Details for Stockholm watch" }).count(), 0);
    await seed({ title: "Stockholm watch", summary: "Watches the city news.", steps: ["Reads the city news."], instruction: "Read Stockholm city news.", cadence: { kind: "weekly", weekdays: [1], hour: 9, minute: 0 }, active: false });
    await desktop.close();

    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: theme });
    const phone = await phoneContext.newPage();
    phone.on("pageerror", (error) => errors.push(error.message));
    phone.setDefaultTimeout(15_000);
    const cdp = await phoneContext.newCDPSession(phone);
    await openRoutines(phone);
    const weeklyRow = phone.locator(".routine-item").filter({ hasText: "Weekly discoveries" });
    await touchDrag(cdp, weeklyRow.locator(".routine-row"), 0, -120);
    assert.equal(await weeklyRow.locator(".routine-swipe").getAttribute("data-open"), "false", "A vertical drag scrolls and opens nothing.");
    await touchDrag(cdp, weeklyRow.locator(".routine-row"), -140, 4);
    await weeklyRow.locator('.routine-swipe[data-open="true"]').waitFor();
    const reveal = await weeklyRow.locator(".routine-swipe-delete").boundingBox();
    const row = await weeklyRow.locator(".routine-row").boundingBox();
    assert(reveal && row && Math.abs(row.x + row.width - reveal.x) < 2, "The row slides left by the width of Delete.");
    await screenshot(phone, `phone-${theme}-swipe`);
    await phone.locator(".routines-heading h2").tap();
    await weeklyRow.locator('.routine-swipe[data-open="false"]').waitFor();
    await touchDrag(cdp, weeklyRow.locator(".routine-row"), -140, 0);
    await weeklyRow.locator(".routine-swipe-delete").tap();
    const phoneUndo = phone.locator(".routine-deleted").filter({ hasText: "Weekly discoveries deleted." });
    await phoneUndo.waitFor();
    await screenshot(phone, `phone-${theme}-undo`);
    await phoneUndo.getByRole("button", { name: "Undo" }).tap();
    await phone.getByRole("button", { name: "Details for Weekly discoveries", exact: true }).waitFor();
    await phone.getByRole("button", { name: `Details for ${WATCH.title}`, exact: true }).tap();
    await phone.locator(".routine-detail").waitFor();
    assert.equal(await phone.evaluate("document.documentElement.scrollWidth > innerWidth"), false, "No horizontal page overflow on a phone.");
    await screenshot(phone, `phone-${theme}-detail`);
    await phoneContext.close();
  }
  assert.deepEqual(errors, []);
  console.log("verify:routines passed: titles, the details, an older routine, the context menu by mouse and keyboard, the touch swipe, undo, and the delete after its window, in light and dark.");
  console.log(shots.join("\n"));
} finally {
  await browser?.close();
  await client.mutation(api.bots.remove, { botId: botId as Id<"bots"> });
}
