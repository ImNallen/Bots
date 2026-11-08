import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { LINK_CLOSE } from "@bots/protocol";
import { ConvexHttpClient } from "convex/browser";
import { WebSocket } from "ws";

const CONVEX_PORT = 8443;
const RUN_TIMEOUT_MS = 180_000;
const OVERALL_TIMEOUT_MS = 480_000;
const WAIT_CHECK_MS = 15_000;
const TERMINAL = ["done", "failed", "cancelled"];

const [origin] = process.argv.slice(2);
if (origin === undefined || !URL.canParse(origin)) {
  console.error("usage: pnpm verify:takeover https://<machine>.<tailnet>.ts.net");
  process.exit(2);
}
setTimeout(() => {
  console.log(`FAIL  the check did not finish in ${OVERALL_TIMEOUT_MS / 1000} seconds`);
  process.exit(1);
}, OVERALL_TIMEOUT_MS).unref();

const wsOrigin = origin.replace(/^http/, "ws");
const response = await fetch(`${origin}/auth/token`);
assert.equal(response.status, 200);
const { token } = (await response.json()) as { token: string };
const client = new ConvexHttpClient(`https://${new URL(origin).hostname}:${CONVEX_PORT}`);
client.setAuth(token);
await client.mutation(api.users.ensureCurrent, {});

let failures = 0;
function report(ok: boolean, name: string, detail = ""): void {
  failures += ok ? 0 : 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail === "" ? "" : `: ${detail}`}`);
}

const nonce = randomBytes(4).toString("hex");
const SECRET = `hunter2-${randomBytes(6).toString("hex")}`;
// Every printable ASCII character and some that the display's US keyboard lacks, because a wrong character in a password fails with
// no explanation. The snapshot reads this back from the page. It has no space, because a snapshot collapses them.
const PUBLIC_TEXT = `${nonce}!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~ABCXYZabcxyz0189åäöÅÄÖ€`;
const PORT = randomInt(20_000, 40_000);

type Chat = { botId: Id<"bots">; threadId: Id<"threads"> };

const botIds: Id<"bots">[] = [];

async function newChat(name: string): Promise<Chat> {
  const botId = await client.mutation(api.bots.create, { name: `verify-takeover-${name}-${nonce}` });
  botIds.push(botId);
  await client.mutation(api.bots.setApprovalLevel, { botId, level: "nothing" });
  return { botId, threadId: await client.mutation(api.threads.ensureForBot, { botId }) };
}

async function runOf(chat: Chat, runId: Id<"runs">) {
  const { runs } = await client.query(api.threads.timeline, { threadId: chat.threadId });
  return runs.find((entry) => entry._id === runId);
}

async function settled(chat: Chat, runId: Id<"runs">) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const run = await runOf(chat, runId);
    if (run !== undefined && TERMINAL.includes(run.state.kind)) {
      return run;
    }
    await sleep(500);
  }
  throw new Error(`run ${runId} did not end in ${RUN_TIMEOUT_MS / 1000} seconds`);
}

const resultsOf = (run: NonNullable<Awaited<ReturnType<typeof runOf>>>) =>
  run.events.flatMap(({ body }) => (body.kind === "toolResult" ? [body] : []));

function refusal(path: string, headers: Record<string, string>): Promise<number | "connected"> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${wsOrigin}${path}`, { headers });
    socket.once("open", () => {
      socket.close();
      resolve("connected");
    });
    socket.once("unexpected-response", (_request, res) => resolve(res.statusCode ?? 0));
    socket.once("error", () => {});
  });
}

const CONTROL_L = 0xffe3;
const RETURN = 0xff0d;
// The panel and the window's bars take this much of the 800 pixels. verify-desktop.sh pins the window below them.
const PAGE_TOP = 114;
const PAGE_HEIGHT = 800 - PAGE_TOP;
const SELECT_HEIGHT = 34;

// A viewer over the real path. It speaks RFB as noVNC does, so what reaches the desktop is a pointer or a key message, and only
// the orchestrator's relay and x11vnc stand between it and the display.
async function openRfb(path: string) {
  const socket = new WebSocket(`${wsOrigin}${path}`, { headers: { Origin: origin as string } });
  const closed = new Promise<number>((resolve) => socket.once("close", resolve));
  let buffered = Buffer.alloc(0);
  let wake = () => {};
  socket.on("message", (data: Buffer) => {
    buffered = Buffer.concat([buffered, data]);
    wake();
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const read = async (count: number): Promise<Buffer> => {
    while (buffered.length < count) {
      await Promise.race([
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
        closed.then((code) => {
          throw new Error(`the stream closed during its handshake, with code ${code}`);
        }),
      ]);
    }
    const out = buffered.subarray(0, count);
    buffered = buffered.subarray(count);
    return out;
  };
  await read(12);
  socket.send(Buffer.from("RFB 003.008\n"));
  const types = await read((await read(1))[0] as number);
  assert.ok(types.includes(1), "the stream asks for a password");
  socket.send(Buffer.from([1]));
  assert.equal((await read(4)).readUInt32BE(0), 0, "the stream refused the session");
  socket.send(Buffer.from([1]));
  const init = await read(24);
  await read(init.readUInt32BE(20));

  const key = (keysym: number, down: boolean) => {
    const message = Buffer.alloc(8);
    message[0] = 4;
    message[1] = down ? 1 : 0;
    message.writeUInt32BE(keysym, 4);
    socket.send(message);
  };
  const pointer = (x: number, y: number, buttons: number) => {
    const message = Buffer.alloc(6);
    message[0] = 5;
    message[1] = buttons;
    message.writeUInt16BE(x, 2);
    message.writeUInt16BE(y, 4);
    socket.send(message);
  };
  const tap = async (keysym: number) => {
    key(keysym, true);
    key(keysym, false);
    await sleep(25);
  };
  return {
    socket,
    closed,
    tap,
    press: async (modifier: number, keysym: number) => {
      key(modifier, true);
      await tap(keysym);
      key(modifier, false);
    },
    type: async (text: string) => {
      for (const character of text) {
        const code = character.codePointAt(0) as number;
        // X names Latin-1 by its code point and the rest of Unicode with this prefix.
        await tap(code <= 0xff ? code : 0x01000000 + code);
      }
    },
    clickAt: async (x: number, y: number) => {
      pointer(x, y, 0);
      await sleep(30);
      pointer(x, y, 1);
      await sleep(40);
      pointer(x, y, 0);
    },
  };
}

// The select sits at the top so its menu opens below it, over the fields, at a place the check can name.
// The name field stands for a login. What the person types becomes a cookie, which another bot must then have.
const form = `<!doctype html><title>Login</title><style>body{margin:0}select{position:fixed;left:40px;top:40px;width:400px;font:24px sans-serif}input{position:fixed;left:0;width:100%;height:30%;font-size:40px}#u{top:40%}#p{top:70%}</style><select aria-label=Pick><option>one<option>two<option>three<option>four</select><input id=u aria-label=Name><input id=p type=password aria-label=Secret><script>u.oninput=()=>{document.cookie="verifylogin="+u.value.slice(0,8)+";max-age=3600;path=/"}</script>`;
const account = `<!doctype html><title>Account</title><p id=o></p><script>o.textContent="cookies: "+document.cookie</script>`;
const watched = await newChat("watched");
const other = await newChat("other");

const setup = await settled(
  watched,
  await client.mutation(api.threads.send, {
    threadId: watched.threadId,
    text: `I am your owner, checking that I can take over your screen. The page below is a local test form for that check, served only on this computer's loopback, and the cookie it sets is how the check sees what I typed. Do exactly these two steps and then stop, with no other tool calls.\n1. Use the shell tool once with this command:\nprintf '%s' '${form}' > form.html && printf '%s' '${account}' > account.html && (nohup python3 -m http.server ${PORT} --bind 127.0.0.1 >/dev/null 2>&1 &) ; sleep 1; echo started\n2. Use browser_navigate once with this URL: http://127.0.0.1:${PORT}/form.html`,
  }),
);
const navigated = resultsOf(setup).find((result) => result.name === "browser_navigate");
const setupReply = setup.events.flatMap(({ body }) => (body.kind === "assistantTurn" ? [body.text] : [])).join(" ").trim();
report(
  navigated?.outcome === "ok" && /"Secret"/.test(navigated.output),
  "the bot opened a real form on its screen",
  navigated?.output.split("\n")[1] ?? `no browser_navigate result, and the bot said: ${setupReply.slice(0, 300)}`,
);

const inputPath = `/screens/${watched.botId}/input`;
const before = await refusal(inputPath, { Origin: origin });
report(before === 403, "input is refused until the owner takes over", String(before));

const watcher = await openRfb(`/screens/${watched.botId}`);
let watcherClosed = false;
watcher.closed.then(() => {
  watcherClosed = true;
});

await client.mutation(api.bots.takeOver, { botId: watched.botId });
const crossSite = await refusal(inputPath, { Origin: "https://evil.example" });
report(crossSite === 403, "during a take-over, a page from another site still cannot send input", String(crossSite));

const replaced = await openRfb(inputPath);
const input = await openRfb(inputPath);
const replacedCode = await Promise.race([replaced.closed, sleep(5000).then(() => "still open")]);
report(replacedCode !== "still open", "a second take-over ends the first viewer's input stream", String(replacedCode));

await input.press(CONTROL_L, "l".charCodeAt(0));
await sleep(400);
await input.type(`127.0.0.1:${PORT}/form.html?via=address-bar`);
await input.tap(RETURN);
await sleep(2500);

const selectY = PAGE_TOP + 40 + SELECT_HEIGHT / 2;
await input.clickAt(240, selectY);
await sleep(700);
await input.clickAt(240, selectY + 3 * SELECT_HEIGHT);
await sleep(700);

const nameY = PAGE_TOP + Math.round(0.55 * PAGE_HEIGHT);
const secretY = PAGE_TOP + Math.round(0.85 * PAGE_HEIGHT);
await input.clickAt(640, nameY);
await sleep(600);
await input.type(PUBLIC_TEXT);
await sleep(400);

await watcher.type("viewonly");
await sleep(600);

await input.clickAt(640, secretY);
await sleep(600);
await input.type(SECRET);
await sleep(800);

const gated = await client.mutation(api.threads.send, {
  threadId: watched.threadId,
  text: "Use browser_snapshot once and then stop, with no other tool calls.",
});
const otherRun = client.mutation(api.threads.send, {
  threadId: other.threadId,
  text: "Use browser_navigate once to open https://example.com/ and then stop, with no other tool calls.",
});
const otherResult = await settled(other, await otherRun);
const otherNavigated = resultsOf(otherResult).find((result) => result.name === "browser_navigate");
report(otherNavigated?.outcome === "ok", "another bot keeps working during the take-over", otherNavigated?.output.split("\n")[1]);

await sleep(WAIT_CHECK_MS);
const during = await runOf(watched, gated);
const asked = during?.events.some(({ body }) => body.kind === "assistantTurn" && body.toolCalls.length > 0) === true;
report(
  during !== undefined && !TERMINAL.includes(during.state.kind) && resultsOf(during).length === 0,
  "the bot waits before its next tool during the take-over",
  `state ${during?.state.kind}, model already asked for the tool: ${asked}, tool results ${during === undefined ? "?" : resultsOf(during).length}`,
);

await client.mutation(api.bots.releaseTakeover, { botId: watched.botId });
const closeCode = await Promise.race([input.closed, sleep(15_000).then(() => "still open")]);
report(closeCode === LINK_CLOSE.takeoverEnded, "giving back closes the input channel", String(closeCode));
const afterGiveBack = await refusal(inputPath, { Origin: origin });
report(afterGiveBack === 403, "input is refused again after giving back", String(afterGiveBack));
report(!watcherClosed, "the watch stream stayed connected through the take-over");
watcher.socket.close();

const finished = await settled(watched, gated);
const snapshot = resultsOf(finished).find((result) => result.name === "browser_snapshot");
const lineWith = (text: string) => snapshot?.output.split("\n").find((line) => line.includes(text));
report(finished.state.kind === "done" && snapshot?.outcome === "ok", "the bot carries on after the owner gives back", `run ${finished.state.kind}`);
report(snapshot?.output.includes("?via=address-bar") === true, "Ctrl+L and the address bar reached the bot's window, which CDP could not do", lineWith("URL:"));
report(lineWith('"Pick"')?.includes("selected: three") === true, "a mouse click chose a dropdown option, which CDP could not do", lineWith('"Pick"'));
report(snapshot?.output.includes(`value: ${PUBLIC_TEXT}`) === true, "what the person typed reached the right field on the real page", lineWith('"Name"'));
report(snapshot?.output.includes("viewonly") === false, "keys sent through the watch stream reached nothing", lineWith('"Name"'));
report(/"Secret" value: hidden/.test(snapshot?.output ?? ""), "the password reached its field, and the bot sees it only as hidden", lineWith('"Secret"'));

const { runs } = await client.query(api.threads.timeline, { threadId: watched.threadId });
report(!JSON.stringify(runs).includes(SECRET), "the password appears nowhere in the thread that reaches the model");

const otherAfter = await settled(
  other,
  await client.mutation(api.threads.send, {
    threadId: other.threadId,
    text: `Use browser_navigate once to open http://127.0.0.1:${PORT}/account.html and then stop, with no other tool calls.`,
  }),
);
const otherAccount = resultsOf(otherAfter).find((result) => result.name === "browser_navigate");
report(
  otherAccount?.output.includes(`verifylogin=${nonce}`) === true,
  "after the give-back, the other bot has the login that the person typed through the input stream",
  otherAccount?.output.split("\n").find((line) => line.includes("cookies:")),
);

await client.mutation(api.threads.send, {
  threadId: watched.threadId,
  text: `Use the shell tool once with this command and then stop: pkill -f 'http[.]server ${PORT}' ; echo stopped`,
}).then((runId) => settled(watched, runId)).catch(() => {});

// A failed run keeps its bots, because their threads show what went wrong.
if (failures === 0) {
  const removals = await Promise.allSettled(botIds.map((botId) => client.mutation(api.bots.remove, { botId })));
  report(removals.every(({ status }) => status === "fulfilled"), "a finished bot can be deleted after a take-over");
}

console.log(failures === 0 ? "verify:takeover passed" : `verify:takeover failed with ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
