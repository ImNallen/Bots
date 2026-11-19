import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = join(root, "src/.markdown-check.tsx");
const html = join(root, ".markdown-check.html");
const destination = "/tmp/bots-markdown-review";
const source = [
  "### A report from Atlas", "", "**Ready** to ship. See [the notes](https://example.com/notes).", "",
  "- Streaming Markdown", "- Safe links and images", "",
  "```ts", 'const title = "<safe>";', `const url = "https://example.com/${"long-path/".repeat(12)}";`, "```", "",
  "| Language | Status | Notes | Owner |", "| --- | --- | --- | --- |", "| TypeScript | Highlighted | Ready to review | Atlas |", "",
  "![Chart](https://evil.example/chart.png?private=1)", "",
  "[![Badge](https://evil.example/badge.png)](https://example.com/)", "",
  "[blocked](javascript:alert(1)) [relative](/auth/token)", "",
  '<img src="https://evil.example/raw.png" onerror="alert(1)"><script>window.attacked=true</script>',
].join("\n");
const report = "**Morning report**\n\n```unknown-language\n<unchanged> & plain code\n```";
const fixture = `
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatItem } from './ChatItem.tsx';
import './styles.css';
import '@fontsource-variable/inter';
const character = {shape: 'ball', color: 'blue'};
function App() {
  const [text, setText] = useState(${JSON.stringify(source)});
  const [streaming, setStreaming] = useState(false);
  return <>
    <nav style={{display:'flex',gap:16,padding:16}}>
      <label>Source<textarea aria-label="Source" value={text} onChange={event => setText(event.target.value)} /></label>
      <label><input aria-label="Streaming" type="checkbox" checked={streaming} onChange={event => setStreaming(event.target.checked)} />Streaming</label>
      <button onClick={() => document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'}>Theme</button>
    </nav>
    <main style={{maxWidth:784,width:'100%',margin:'0 auto',padding:24,display:'flex',flexDirection:'column',gap:24}}>
      <ChatItem item={{key:'user',kind:'user',text:'**User text** <b>plain</b>'}} character={character} />
      <section aria-label="Assistant"><ChatItem item={{key:'assistant',kind:'assistant',text,streaming}} character={character} botName="Atlas" /></section>
      <section aria-label="Report"><ChatItem item={{key:'report',kind:'report',text:${JSON.stringify(report)},routine:null}} character={character} botName="Atlas" /></section>
    </main>
  </>;
}
createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
`;

await mkdir(destination, { recursive: true });
await writeFile(entry, fixture);
await writeFile(html, '<html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/src/.markdown-check.tsx"></script></html>');
const server = await createServer({ root, define: { "import.meta.env.VITE_CONVEX_URL": JSON.stringify("http://127.0.0.1:3210") }, server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  assert(url);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  const remoteImages: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://evil.example/**", (route) => { remoteImages.push(route.request().url()); return route.abort(); });
  await page.goto(`${url}.markdown-check.html`);
  const assistant = page.getByRole("region", { name: "Assistant", exact: true });
  const routine = page.getByRole("region", { name: "Report", exact: true });
  await assistant.getByRole("heading", { name: "A report from Atlas" }).waitFor();
  assert.equal(await page.locator(".mine").textContent(), "**User text** <b>plain</b>");
  assert.equal(await page.locator(".mine strong, .mine b, .md img, .md script, .md iframe, .md a a").count(), 0);
  assert.equal(await page.locator('[data-markdown="line-numbers"]').count(), 0);
  assert.equal(await assistant.locator(".md-image").count(), 2);
  assert((await assistant.locator(".md").textContent())?.includes("Chart https://evil.example/chart.png?private=1"));
  for (const link of await page.locator(".md a").evaluateAll((nodes) => nodes.map((node) => ({ href: node.getAttribute("href"), target: node.getAttribute("target"), rel: node.getAttribute("rel") })))) {
    assert(link.href && ["http:", "https:", "mailto:"].includes(new URL(link.href).protocol));
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
  }
  assert.equal(await routine.locator("strong").textContent(), "Morning report");
  assert.equal(await routine.locator("pre").textContent(), "<unchanged> & plain code\n");
  assert.equal(await routine.locator('code [style*="color"]').count(), 0);
  await routine.getByRole("button", { name: "Copy", exact: true }).waitFor();
  assert.equal(await routine.getByRole("button", { name: "Retry", exact: true }).count(), 0);

  const token = assistant.locator('code span[style*="light-dark"]').first();
  const light = await token.evaluate((node) => getComputedStyle(node).color);
  assert.notEqual(light, await assistant.locator("code").evaluate((node) => getComputedStyle(node).color));
  await page.locator("main").screenshot({ path: join(destination, "desktop-light.png") });
  await page.getByRole("button", { name: "Theme", exact: true }).click();
  const dark = await token.evaluate((node) => getComputedStyle(node).color);
  assert.notEqual(dark, light);
  await page.locator("main").screenshot({ path: join(destination, "desktop-dark.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  for (const selector of ["pre", ".md-scroll"]) {
    const scroller = assistant.locator(selector);
    const size = await scroller.evaluate((node) => ({ scroll: node.scrollWidth, width: node.clientWidth }));
    assert(size.scroll > size.width, `${selector} should scroll: ${JSON.stringify(size)}`);
    assert.equal(await scroller.evaluate((node) => getComputedStyle(node).overflowX), "auto");
  }
  await page.locator("main").screenshot({ path: join(destination, "mobile-dark.png") });
  await page.getByRole("button", { name: "Theme", exact: true }).click();
  await page.locator("main").screenshot({ path: join(destination, "mobile-light.png") });

  await page.getByLabel("Streaming", { exact: true }).check();
  await page.getByLabel("Source", { exact: true }).fill("**bol");
  await assistant.locator("strong").filter({ hasText: /^bol$/ }).waitFor();
  assert.equal(await assistant.locator('[data-streaming="true"]').count(), 1);
  await page.getByLabel("Streaming", { exact: true }).uncheck();
  assert.equal(await assistant.locator("strong").count(), 0);
  assert.equal((await assistant.locator(".md").textContent())?.trim(), "**bol");
  await page.getByLabel("Streaming", { exact: true }).check();
  for (const code of ["const n = ", "const n = 1;\n", "const n = 1;\nconst done = true;\n"]) {
    await page.getByLabel("Source", { exact: true }).fill(`Stable paragraph.\n\n\`\`\`ts\n${code}`);
    assert.equal((await assistant.locator("pre").textContent())?.trimEnd(), code.trimEnd());
    assert(await assistant.locator('code span[style*="light-dark"]').count() > 0);
  }
  const final = "Stable paragraph.\n\n```ts\nconst n = 1;\nconst done = true;\n```\n\n**Finished**";
  await page.getByLabel("Source", { exact: true }).fill(final);
  await page.getByLabel("Streaming", { exact: true }).uncheck();
  assert.equal(await assistant.locator("pre").count(), 1);
  assert.equal(await assistant.locator("pre").textContent(), "const n = 1;\nconst done = true;\n");
  assert.equal(await assistant.locator("strong").textContent(), "Finished");
  assert.equal(await assistant.locator('[data-streaming="true"]').count(), 0);
  await assistant.getByRole("button", { name: "Copy", exact: true }).waitFor();
  await page.locator("main").screenshot({ path: join(destination, "stream-completed.png") });
  assert.deepEqual(remoteImages, []);
  assert.deepEqual(errors, []);
  console.log(`Markdown safety, highlighting, themes, mobile scrolling and streaming completion passed. Screenshots: ${destination}`);
} finally {
  await browser?.close();
  await server.close();
  await Promise.all([rm(entry, { force: true }), rm(html, { force: true })]);
}
