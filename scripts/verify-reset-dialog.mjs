import { realpathSync } from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(realpathSync(resolve(root, "apps/web/node_modules/vite/package.json")));
const { build } = await import(require.resolve("rolldown"));
const directory = await mkdtemp(join(tmpdir(), "bots-reset-dialog-"));
const entry = join(directory, "dialog.tsx");
const bundle = join(directory, "dialog.js");
await writeFile(entry, `
import React, { useState } from ${JSON.stringify(resolve(root, "apps/web/node_modules/react/index.js"))};
import { createRoot } from ${JSON.stringify(resolve(root, "apps/web/node_modules/react-dom/client.js"))};
import { Dialog, DialogFrame } from ${JSON.stringify(resolve(root, "apps/web/src/Dialog.tsx"))};
function App() {
  const [outer, setOuter] = useState(true);
  const [inner, setInner] = useState(false);
  const [pending, setPending] = useState(false);
  window.release = () => setPending(false);
  return outer ? <DialogFrame title="Settings" onClose={() => setOuter(false)}>
    <button onClick={() => setInner(true)}>Reset computer</button>
    {inner && <Dialog title="Reset computer?" dismissible={!pending} onClose={() => setInner(false)}>
      <button data-autofocus disabled={pending} onClick={() => setInner(false)}>Cancel</button>
      <button disabled={pending} onClick={() => setPending(true)}>Confirm</button>
    </Dialog>}
  </DialogFrame> : <p>Settings closed</p>;
}
createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
`);
await build({ input: entry, moduleTypes: { ".svg": "text" }, resolve: { alias: { react: resolve(root, "apps/web/node_modules/react"), "react-dom": resolve(root, "apps/web/node_modules/react-dom") } }, transform: { jsx: { runtime: "automatic" } }, output: { file: bundle, format: "iife" } });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ path: bundle });
  const reset = page.getByRole("button", { name: "Reset computer", exact: true });
  const confirmation = page.getByRole("dialog", { name: "Reset computer?", exact: true });
  for (const cancel of ["button", "escape", "native-close"]) {
    await reset.click();
    await confirmation.waitFor();
    if (cancel === "button") await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    else if (cancel === "escape") await page.keyboard.press("Escape");
    else await confirmation.evaluate((dialog) => dialog.close());
    await confirmation.waitFor({ state: "detached" });
    assert.equal(await page.locator("dialog[open]").count(), 1);
    await page.waitForFunction(() => document.activeElement?.textContent === "Reset computer", null, { timeout: 5000 });
    assert(await reset.evaluate((button) => document.activeElement === button), `${cancel} restores focus`);
  }
  await reset.click();
  await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("dialog[open]").count(), 2);
  assert(await confirmation.getByRole("button", { name: "Close", exact: true }).isDisabled());
  await page.evaluate(() => window.release());
  await confirmation.getByRole("button", { name: "Confirm", exact: true }).waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector("dialog:last-of-type button[aria-label=Close]")?.disabled, null, { timeout: 5000 });
  await page.keyboard.press("Escape");
  await confirmation.waitFor({ state: "detached" });
  assert(await reset.evaluate((button) => document.activeElement === button));
  console.log("verify:reset-dialog passed with actual Dialog components. Cancel, Escape, native close, pending Escape refusal, and focus return passed.");
} finally {
  await browser.close();
  await rm(directory, { recursive: true });
}
