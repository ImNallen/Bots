// Runs in a user VM, as the computerd user, from the release's root. It uses the real desktops and browser code against real
// units, with no link and no orchestrator. infra/proxmox/verify-desktop.sh runs it. Pass a directory for a frame of each desktop.
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { MAX_MARKS, MAX_SCREEN_IMAGE_BYTES, type ToolResult } from "../packages/protocol/src/index.ts";
import { createBrowser } from "../apps/computerd/src/browser.ts";
import { createDesktop } from "../apps/computerd/src/desktop.ts";
import { createDesktops, createSystemd, IDLE_STOP_MS, streamPort, type DesktopLease, type Slot, type Systemd } from "../apps/computerd/src/desktops.ts";

const FRAMES = process.argv[2];
const run = promisify(execFile);
const RUNTIME_DIR = "/run/computerd";
const BOTS = ["verifydesktopsa", "verifydesktopsb"] as const;
const signal = new AbortController().signal;
let failures = 0;
let passes = 0;

function check(ok: boolean, label: string, detail = ""): void {
  if (ok) {
    passes += 1;
    console.log(`ok    ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}${detail === "" ? "" : ` [${detail.slice(0, 400)}]`}`);
  }
}

function measure(label: string, startedAt: number): void {
  console.log(`measure  ${label}: ${Math.round(performance.now() - startedAt)} ms`);
}

const probe = (...args: string[]): Promise<string> =>
  run(process.execPath, ["infra/proxmox/desktop-probe.mjs", ...args]).then(({ stdout }) => stdout.trim());

const portAnswers = (port: number): Promise<boolean> =>
  fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }).then(
    () => true,
    () => false,
  );

function pageWith(title: string, body: string): string {
  return `data:text/html,${encodeURIComponent(`<!doctype html><title>${title}</title>${body}`)}`;
}

let starts = 0;
const real = createSystemd();
const counted: Systemd = {
  ...real,
  start: (slot) => {
    starts += 1;
    return real.start(slot);
  },
};
let clockOffset = 0;
const now = (): number => Date.now() + clockOffset;
const desktops = createDesktops({ systemd: counted, runtimeDir: RUNTIME_DIR, now });
const browser = createBrowser({ desktops });
const desktop = createDesktop({ desktops });

const browse = (botId: string, tool: Parameters<typeof browser.execute>[0]["tool"]) => browser.execute({ botId, tool, browsing: undefined, signal });
const refOf = (output: string, label: string): number => Number(new RegExp(`\\[(\\d+)\\] [^\\n]*${label}`).exec(output)?.[1]);

let startedAt = performance.now();
const [firstA, firstB] = await Promise.all(
  BOTS.map((botId) =>
    browse(botId, { name: "browser_navigate", args: { url: pageWith(`page of ${botId}`, `<a href="https://example.com/">go to example</a>`) } }),
  ),
);
measure("two bots start together and each opens a page", startedAt);
check(firstA?.outcome === "ok" && firstA.output.includes(`Title: page of ${BOTS[0]}`), "the first bot reads its own page", firstA?.output);
check(firstB?.outcome === "ok" && firstB.output.includes(`Title: page of ${BOTS[1]}`), "the second bot reads its own page", firstB?.output);
const screenOf = (output: string | undefined): string | undefined => /^Screen (\d)/.exec(output ?? "")?.[1];
check(screenOf(firstA?.output) !== screenOf(firstB?.output), "they are on different screens", `${screenOf(firstA?.output)} ${screenOf(firstB?.output)}`);

const clicked = await browse(BOTS[0], { name: "browser_click", args: { ref: refOf(firstA?.output ?? "", "go to example") } });
check(clicked.output.includes("Example Domain"), "the first bot clicks a link and lands on a real website", clicked.output);
const wikipedia = await browse(BOTS[1], { name: "browser_navigate", args: { url: "https://en.wikipedia.org/wiki/Linux" } });
check(wikipedia.output.includes("Linux - Wikipedia"), "the second bot opens another real website", wikipedia.output);
const stillA = await browse(BOTS[0], { name: "browser_snapshot", args: {} });
check(stillA.output.includes("Example Domain") && !stillA.output.includes("Wikipedia"), "the first bot's page did not change");

startedAt = performance.now();
await browse(BOTS[0], { name: "browser_snapshot", args: {} });
measure("a browser call on a running desktop, including its sudo and the 400 ms settle", startedAt);

const leases = new Map<string, DesktopLease>();
for (const botId of BOTS) {
  startedAt = performance.now();
  leases.set(botId, await desktops.acquire(botId));
  measure("an acquire on a running desktop", startedAt);
}
const slots = BOTS.map((botId) => (leases.get(botId) as DesktopLease).slot);
check(new Set(slots).size === 2, "their leases are on different slots", slots.join());
for (const botId of BOTS) {
  const lease = leases.get(botId) as DesktopLease;
  const watchPort = streamPort(lease.slot, "watch");
  const size = await probe("rfb-size", String(watchPort));
  check(size === "1280x800", `slot ${lease.slot} streams 1280x800 on port ${watchPort}`, size);
  if (FRAMES !== undefined) {
    await probe("rfb-frame", String(watchPort), `${FRAMES}/slot-${lease.slot}.png`);
  }
}

const popupPage = pageWith("the opener", `<button onclick="const w = window.open('about:blank', '_blank', 'width=600,height=400'); w.document.title = 'the popup'">open a popup</button>`);
const opener = await browse(BOTS[0], { name: "browser_navigate", args: { url: popupPage } });
const popup = await browse(BOTS[0], { name: "browser_click", args: { ref: refOf(opener.output, "open a popup") } });
check(popup.output.includes("Title: the popup"), "a popup becomes the page the bot acts on", popup.output);
const afterRestart = await createBrowser({ desktops }).execute({ botId: BOTS[0], tool: { name: "browser_snapshot", args: {} }, browsing: undefined, signal });
check(afterRestart.output.includes("Title: the popup"), "a popup stays current across a computerd restart, because Chromium says who opened it", afterRestart.output);
const closePopup = await browse(BOTS[0], { name: "browser_navigate", args: { url: pageWith("closing", "<script>setTimeout(() => window.close(), 200)</script>") } });
check(closePopup.outcome === "ok", "the popup navigates", closePopup.output);
await new Promise((done) => setTimeout(done, 800));
const backOnOpener = await browse(BOTS[0], { name: "browser_snapshot", args: {} });
check(backOnOpener.output.includes("Title: the opener"), "when the popup closes, the bot is back on the page that opened it", backOnOpener.output);

const stale = await browse(BOTS[0], { name: "browser_click", args: { ref: 999 } });
check(stale.outcome === "error" && stale.output.includes("take a new snapshot"), "a ref that is not on the page answers with the stale ref error", stale.output);

const personSlot = (leases.get(BOTS[1]) as DesktopLease).slot;
const inputPort = streamPort(personSlot, "control");
await real.restartInput(personSlot);
const personTyped = await probe("rfb-type", String(9300 + personSlot), String(inputPort));
check(personTyped === "value=xyz", "a person's click and keys through computerd's own restart reach the bot's page", personTyped);

const target = "position:fixed;left:200px;top:150px;width:60px;height:40px;background:#f0f;border:0";
await browse(BOTS[1], {
  name: "browser_navigate",
  args: { url: pageWith("not clicked", `<button style="${target}" onclick="document.title='clicked'"></button>`) },
});
await new Promise((done) => setTimeout(done, 500));
const [x, y] = (await probe("rfb-find-magenta", String(streamPort(personSlot, "watch")))).split(",").map(Number) as [number, number];
await real.restartInput(personSlot);
await probe("rfb-click", String(inputPort), String(x), String(y));
const hit = await browse(BOTS[1], { name: "browser_snapshot", args: {} });
check(hit.output.includes("Title: clicked"), `a person's click at ${x},${y} on the stream lands on what the stream shows there`, hit.output);

await browse(BOTS[1], { name: "browser_navigate", args: { url: pageWith("a form", `<input id="field" value="typed by a person">`) } });
const recovered = createDesktops({ systemd: counted, runtimeDir: RUNTIME_DIR, now });
const again = await recovered.acquire(BOTS[1]);
check(again.slot === (leases.get(BOTS[1]) as DesktopLease).slot, "a new instance over the same state finds the same slot", String(again.slot));
again.release();
const sameScreen = await createBrowser({ desktops: recovered }).execute({ botId: BOTS[1], tool: { name: "browser_snapshot", args: {} }, browsing: undefined, signal });
check(sameScreen.output.includes("typed by a person"), "a new instance over the same state finds the same page", sameScreen.output);

const lookAt = (botId: string) => desktop.execute({ botId, tool: { name: "desktop_look", args: {} }, signal });
const pictureBytes = (result: ToolResult): number => Buffer.byteLength(result.screen?.image?.base64 ?? "", "base64");
async function savePicture(result: ToolResult, name: string): Promise<void> {
  if (FRAMES !== undefined && result.screen?.image !== undefined) {
    await writeFile(`${FRAMES}/look-${name}.${result.screen.image.mediaType === "image/png" ? "png" : "jpg"}`, Buffer.from(result.screen.image.base64, "base64"));
  }
}
const marked = (result: ToolResult, role: string, name: string) => result.screen?.marks.find((mark) => mark.role === role && mark.name === name);

await browse(BOTS[0], { name: "browser_navigate", args: { url: pageWith("a form to look at", `<input aria-label="Your name"><button>Send it</button>`) } });
startedAt = performance.now();
const looked = await lookAt(BOTS[0]);
measure("a look at a desktop with a form", startedAt);
const active = looked.screen?.active === null || looked.screen === undefined ? undefined : looked.screen.windows[looked.screen.active];
check(looked.outcome === "ok" && active?.app === "Chromium" && active.title.startsWith("a form to look at"), "a look names Chromium's window as active", looked.output + JSON.stringify(active));
check(marked(looked, "entry", "Address and search bar") !== undefined, "a look lists Chromium's address bar, which CDP cannot reach");
check(marked(looked, "entry", "Your name") !== undefined && marked(looked, "button", "Send it") !== undefined, "a look lists the page's field and button");
check(looked.screen?.marks.some((mark) => looked.screen?.windows[mark.win]?.kind === "panel") === true, "a look lists the panel");
check(looked.screen?.image !== undefined && pictureBytes(looked) <= MAX_SCREEN_IMAGE_BYTES, `a look's picture fits: ${pictureBytes(looked)} bytes of ${looked.screen?.image?.mediaType}`);
await savePicture(looked, "form");

const links = Array.from({ length: 2000 }, (_, index) => `<a href="#l${index}">link number ${index}</a>`).join(" ");
await browse(BOTS[0], { name: "browser_navigate", args: { url: pageWith("many links", links) } });
startedAt = performance.now();
const crowded = await lookAt(BOTS[0]);
const crowdedMs = performance.now() - startedAt;
measure("a look at a page with 2,000 links", startedAt);
check(crowded.outcome === "ok" && crowdedMs < 3000, "a look at a page with 2,000 links takes under 3 s", `${Math.round(crowdedMs)} ms`);
check(crowded.screen?.marks.length === MAX_MARKS && (crowded.screen?.unlisted ?? 0) > 0, `it lists ${MAX_MARKS} marks and counts the rest`, `${crowded.screen?.marks.length} listed, ${crowded.screen?.unlisted} more`);
check(crowded.screen?.image !== undefined && pictureBytes(crowded) <= MAX_SCREEN_IMAGE_BYTES, `its picture fits: ${pictureBytes(crowded)} bytes of ${crowded.screen?.image?.mediaType}`);
await savePicture(crowded, "many-links");

// The spin starts after the navigation has returned, so the browser tool does not see it and close the page first.
await browse(BOTS[0], { name: "browser_navigate", args: { url: pageWith("frozen", `<button>still here</button><script>setTimeout(() => { for (;;) {} }, 2500)</script>`) } });
await new Promise((done) => setTimeout(done, 4000));
startedAt = performance.now();
const frozen = await lookAt(BOTS[0]);
const frozenMs = performance.now() - startedAt;
measure("a look while the page spins in while (true)", startedAt);
check(frozen.outcome === "ok" && frozenMs < 30_000, "a look still answers while the page spins", `${frozen.outcome} in ${Math.round(frozenMs)} ms, silent ${JSON.stringify(frozen.screen?.silent)}`);
check(frozen.screen?.image !== undefined, "it still has its picture");
check(frozen.screen?.windows.some((window) => window.app === "Chromium" && window.title.startsWith("frozen")) === true, "it still names the frozen page's window", JSON.stringify(frozen.screen?.windows));
await savePicture(frozen, "frozen");
await browse(BOTS[0], { name: "browser_navigate", args: { url: "about:blank" } });

(leases.get(BOTS[1]) as DesktopLease).release();
clockOffset += IDLE_STOP_MS * 2;
const cdpOf = (slot: Slot): number => 9300 + slot;
const [slotA, slotB] = slots as [Slot, Slot];
await desktops.sweep();
check(await portAnswers(cdpOf(slotA)), "a sweep keeps a desktop with an open lease");
check(!(await portAnswers(cdpOf(slotB))), "a sweep stops an idle desktop, and its port is closed when the sweep returns");
const returned = await browse(BOTS[1], { name: "browser_click", args: { ref: 1 } });
check(returned.outcome === "error" && returned.output.includes("take a new snapshot"), "a bot back after an idle stop gets the stale ref error, and clicks nothing", returned.output);
const blank = await browse(BOTS[1], { name: "browser_snapshot", args: {} });
check(blank.output.includes("URL: about:blank"), "its next snapshot says about:blank", blank.output);

(leases.get(BOTS[0]) as DesktopLease).release();
clockOffset += IDLE_STOP_MS * 2;
await desktops.sweep();
check(!(await portAnswers(cdpOf(slotA))), "a released desktop stops at the next sweep");

const left = await real.liveSlots();
check(left.length === 0, "no desktop is left running", left.join());

console.log("---");
console.log(`passed ${passes}, failed ${failures}`);
process.exit(failures === 0 ? 0 : 1);
