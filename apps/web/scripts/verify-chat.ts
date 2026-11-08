import assert from "node:assert/strict";
import { mkdir, rm, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = join(root, "src/.chat-check.tsx");
const html = join(root, ".chat-check.html");
const destination = "/tmp/bots-chat-review";
const fixture = `
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { ConvexProvider, ConvexReactClient } from 'convex/react';
import { ChatFeed } from './ChatFeed.tsx';
import { BotFace } from './BotFace.tsx';
import { StopReplyButton } from './StopReplyButton.tsx';
import { Icon } from './Icon.tsx';
import './styles.css';
import '@fontsource-variable/inter';
const character = {shape:'ball', color:'green'};
const client = new ConvexReactClient('http://127.0.0.1:3210');
function App() {
  const [phase,setPhase]=useState('Thinking'),[retries,setRetries]=useState(0),[stopped,setStopped]=useState(false);
  const tool={kind:'tool',key:'tool',name:'Read a file',icon:'file',summary:'Stockholm cafés.md',status:'finished',note:null,output:{text:'Three cafés with good coffee and room to work.',exitCode:0,truncated:false}};
  const items=[{kind:'user',key:'user',text:'Find three quiet cafés in Stockholm where I can work for a few hours.'}];
  if(phase==='Thinking'||phase==='Working')items.push({kind:'status',key:phase,mode:phase==='Thinking'?'thinking':'tool',text:phase==='Thinking'?'Thinking':'Reading a file'});
  if(phase==='Answer')items.push(tool,{kind:'assistant',key:'answer',streaming:false,text:'I found three places with good coffee, reliable Wi-Fi, and a little room to think.\\n\\n### A quieter corner of Stockholm\\n\\n1. **Café Pascal** · Vasastan\\n2. **Drop Coffee** · Södermalm\\n3. **Gast** · Norrmalm'});
  if(phase==='Error')items.push({kind:'failed',key:'failed',reason:'The connection was interrupted.'});
  if(phase==='Stopped')items.push({kind:'stopped',key:'stopped'});
  if(phase==='Approval')items.push({kind:'approval',key:'approval',approvalId:'approval-fixture',title:'Run this command?',arguments:[{label:'Command',value:'echo café notes'}]});
  return <><nav style={{padding:12,display:'flex',gap:12}}><select aria-label="Scenario" value={phase} onChange={e=>{setPhase(e.target.value);setStopped(false)}}>{['Thinking','Working','Answer','Approval','Error','Stopped'].map(p=><option key={p}>{p}</option>)}</select><button onClick={()=>document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'}>Theme</button><span role="status">Retries: {retries}</span></nav>
    <main style={{maxWidth:784,width:'100%',margin:'0 auto',padding:32}}>
      <header className="chat-head"><button className="pill"><BotFace character={character} size={32}/><span>Atlas</span></button></header>
      <section className="conversation" style={{minHeight:420}}><ChatFeed items={items} character={character} botName="Atlas" onRetry={async()=>setRetries(n=>n+1)}/></section>
      <form className="composer" style={{marginTop:32}} onSubmit={e=>e.preventDefault()}><div className="composer-row"><textarea aria-label="Message Atlas" placeholder="Message Atlas…" rows={1}/><div className="composer-toolbar"><button className="round composer-attach" type="button" aria-label="Attach files"><Icon name="attachment"/></button><button className="round composer-mic" type="button" aria-label="Voice input"><Icon name="mic"/></button><div className="composer-send"><StopReplyButton stopping={stopped} onStop={()=>setStopped(true)}/></div></div></div></form>
      <section aria-label="Mascot expressions" style={{display:'flex',gap:20,marginTop:32}}>{['idle','thinking','working','needsApproval','success','error'].map(state=><BotFace key={state} character={character} size={32} state={state}/>)}</section>
      <section aria-label="Bot colors" style={{display:'flex',gap:20,marginTop:24}}>{['green','blue','orange'].map(color=><BotFace key={color} character={{shape:'ball',color}} size={32}/>)}</section>
      <section aria-label="Theme colors" className="info-card" style={{marginTop:24}}><span className="me-dot">AN</span><div style={{display:'flex',gap:8}}><button className="btn btn-go" type="button">Save</button><button className="btn danger-link" type="button">Delete bot</button><button className="btn danger-link" type="button">Remove</button></div></section>
    </main></>;
}
createRoot(document.getElementById('root')).render(<ConvexProvider client={client}><App/></ConvexProvider>);
`;

await mkdir(destination, { recursive: true });
await writeFile(entry, fixture);
await writeFile(html, '<html><div id="root"></div><script type="module" src="/src/.chat-check.tsx"></script></html>');
const server = await createServer({ root, define: { "import.meta.env.VITE_CONVEX_URL": JSON.stringify("http://127.0.0.1:3210") }, server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  assert(url);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/auth/token", (route) => route.fulfill({ status: 401, json: { error: "UI fixture has no session" } }));
  await page.goto(`${url}.chat-check.html`);
  await page.getByText("Thinking…", { exact: true }).waitFor();
  const pill = page.locator('.pill .face');
  const box = await pill.boundingBox();
  assert(box);
  await page.mouse.move(box.x + box.width + 60, box.y + 10);
  await page.waitForFunction(() => document.querySelector('.pill .face')?.getAttribute('data-looking') === 'true');
  assert.notEqual(await pill.evaluate(el => el.style.getPropertyValue('--gaze-x')), '0px');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.pill .face-gaze')!).translate === '0px');
  await page.mouse.move(box.x + 50, box.y + 20);
  assert.notEqual(await pill.getAttribute('data-looking'), 'true');
  for (const state of ['idle', 'thinking', 'working', 'needsApproval', 'error']) {
    const animation = await page.locator(`section[aria-label="Mascot expressions"] [data-state="${state}"] .face-eyes`).evaluate(el => getComputedStyle(el).animationName);
    assert.equal(animation, 'none');
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByLabel('Scenario').selectOption('Working');
  await page.getByLabel('Scenario').selectOption('Thinking');
  await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector('.conversation .face-eye')!).height) < 16);
  await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector('.conversation .face-eye')!).height) > 17.9);
  const thinking = page.locator('.conversation .face');
  const thinkingBox = await thinking.boundingBox();
  assert(thinkingBox);
  await page.mouse.move(thinkingBox.x + 50, thinkingBox.y + 10);
  assert.equal(await thinking.getAttribute('data-looking'), null);

  await page.clock.install();
  await page.clock.fastForward(10_100);
  await page.getByText('Still working…', { exact: true }).waitFor();
  await page.getByLabel('Scenario').selectOption('Working');
  await page.getByText('Reading a file', { exact: true }).waitFor();
  assert.equal(await page.getByText('Still working…', { exact: true }).count(), 0);
  await page.getByLabel('Message Atlas').fill('Keep this follow-up draft');
  const control = await page.getByRole('button', { name: 'Stop reply', exact: true }).boundingBox();
  assert(control?.width === 36 && control.height === 36);
  await page.getByRole('button', { name: 'Stop reply', exact: true }).click();
  assert(await page.getByRole('button', { name: 'Stopping reply' }).isDisabled());
  assert.equal(await page.getByLabel('Message Atlas').inputValue(), 'Keep this follow-up draft');
  await page.getByLabel('Scenario').selectOption('Answer');
  assert.equal(await page.locator('.tool-details').getAttribute('open'), null);
  await page.locator('.tool-details summary').click();
  await page.getByRole('button', { name: /Read a file/ }).click();
  await page.locator('.out').waitFor();
  assert((await page.locator('.out').textContent())?.includes('Three cafés with good coffee and room to work.'));
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await page.getByRole('button', { name: 'Copied' }).waitFor();
  assert((await page.evaluate(() => navigator.clipboard.readText())).includes('Café Pascal'));
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByText('Retries: 1', { exact: true }).waitFor();
  await page.locator('.tool-details summary').click();
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
  assert.equal(await page.locator('.info-card').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(245, 245, 245)');
  assert.equal(await page.locator('.me-dot').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(32, 32, 32)');
  assert.equal(await page.locator('.me-dot').evaluate(el => getComputedStyle(el).color), 'rgb(255, 255, 255)');
  assert.deepEqual(await page.locator('.danger-link').evaluateAll(nodes => nodes.map(el => getComputedStyle(el).color)), ['rgb(207, 53, 53)', 'rgb(207, 53, 53)']);
  await page.screenshot({ path: join(destination, 'desktop-light.png'), animations: 'disabled', fullPage: true });
  await page.getByRole('button', { name: 'Theme', exact: true }).click();
  assert.equal(await page.locator('.composer-row').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(34, 34, 34)');
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(24, 24, 24)');
  assert.equal(await page.locator('.info-card').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(19, 19, 19)');
  assert.equal(await page.locator('.me-dot').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(235, 235, 235)');
  assert.equal(await page.locator('.me-dot').evaluate(el => getComputedStyle(el).color), 'rgb(24, 24, 24)');
  assert.deepEqual(await page.locator('.danger-link').evaluateAll(nodes => nodes.map(el => getComputedStyle(el).color)), ['rgb(255, 133, 133)', 'rgb(255, 133, 133)']);
  await page.screenshot({ path: join(destination, 'desktop-dark.png'), animations: 'disabled', fullPage: true });
  await page.getByRole('button', { name: 'Theme', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(destination, 'mobile.png'), animations: 'disabled', fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  for (const scenario of ['Approval', 'Error', 'Stopped']) {
    await page.getByLabel('Scenario').selectOption(scenario);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  }
  assert.deepEqual(await page.locator('section[aria-label="Bot colors"] .face-body').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).fill)), ['rgb(67, 169, 110)', 'rgb(86, 135, 218)', 'rgb(232, 139, 80)']);
  const success = page.locator('section[aria-label="Mascot expressions"] [data-state="success"] image');
  assert.equal(await success.getAttribute('width'), '64');
  const image = await success.getAttribute('href');
  assert(image);
  assert.equal(await success.evaluate(async el => { const image = new Image(); image.src = el.getAttribute('href') ?? ''; await image.decode(); return image.naturalWidth; }), 32);
  assert.equal((await success.boundingBox())?.width, 32);
  for (const name of ['happy-sage.svg', 'happy-blue.svg', 'happy-peach.svg']) assert((await stat(join(root, 'src/assets/mascot', name))).size > 0);
  assert.deepEqual(errors, []);
  console.log(`Chat rendering, tool disclosure, copy/retry callbacks, Stop, drafts, mascot gaze, reduced motion, themes and mobile checks passed. Screenshots: ${destination}`);
} finally {
  await browser?.close();
  await server.close();
  await Promise.all([rm(entry, { force: true }), rm(html, { force: true })]);
}
