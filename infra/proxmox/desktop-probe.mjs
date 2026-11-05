// Runs in a user VM, under the Node of computerd's release. verify-desktop.sh sends this through the guest agent.
// usage: desktop-probe.mjs COMMAND ...ARGS, and each command prints one line or exits with a message.
import { writeFileSync } from "node:fs";
import { connect } from "node:net";
import { crc32, deflateSync } from "node:zlib";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function rfbSession(port) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let buffered = Buffer.alloc(0);
    const waiters = [];
    const pump = () => {
      while (waiters.length > 0 && buffered.length >= waiters[0].count) {
        const waiter = waiters.shift();
        const out = buffered.subarray(0, waiter.count);
        buffered = buffered.subarray(waiter.count);
        waiter.done(Buffer.from(out));
      }
    };
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      pump();
    });
    socket.on("error", reject);
    const read = (count) => new Promise((done) => {
      waiters.push({ count, done });
      pump();
    });
    (async () => {
      await read(12);
      socket.write("RFB 003.008\n");
      const types = await read((await read(1))[0]);
      if (!types.includes(1)) throw new Error("the stream asks for a password");
      socket.write(Buffer.from([1]));
      if ((await read(4)).readUInt32BE(0) !== 0) throw new Error("the stream refused the session");
      socket.write(Buffer.from([1]));
      const init = await read(24);
      await read(init.readUInt32BE(20));
      resolve({ socket, read, width: init.readUInt16BE(0), height: init.readUInt16BE(2) });
    })().catch(reject);
  });
}

async function frameOf(session) {
  const { socket, read, width, height } = session;
  const format = Buffer.alloc(20);
  format.set([32, 24, 0, 1], 4);
  format.writeUInt16BE(255, 8);
  format.writeUInt16BE(255, 10);
  format.writeUInt16BE(255, 12);
  format.set([16, 8, 0], 14);
  socket.write(format);
  const encodings = Buffer.alloc(8);
  encodings[0] = 2;
  encodings.writeUInt16BE(1, 2);
  socket.write(encodings);
  const request = Buffer.alloc(10);
  request[0] = 3;
  request.writeUInt16BE(width, 6);
  request.writeUInt16BE(height, 8);
  socket.write(request);
  const pixels = Buffer.alloc(width * height * 4);
  while ((await read(1))[0] !== 0);
  const rectangles = (await read(3)).readUInt16BE(1);
  for (let index = 0; index < rectangles; index += 1) {
    const header = await read(12);
    const [x, y, w, h] = [0, 2, 4, 6].map((offset) => header.readUInt16BE(offset));
    const data = await read(w * h * 4);
    for (let row = 0; row < h; row += 1) {
      data.copy(pixels, (y + row) * width * 4 + x * 4, row * w * 4, (row + 1) * w * 4);
    }
  }
  return pixels;
}

function png(pixels, width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4;
      const to = y * (width * 3 + 1) + 1 + x * 3;
      raw[to] = pixels[from + 2];
      raw[to + 1] = pixels[from + 1];
      raw[to + 2] = pixels[from];
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function browser(port) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = fail;
  });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) pending.get(message.id)(message);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((done, fail) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, (message) => (message.error ? fail(new Error(message.error.message)) : done(message.result)));
      socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  const page = async (url) => {
    const { targetId } = await send("Target.createTarget", { url });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Runtime.enable", {}, sessionId);
    const evaluate = async (expression) =>
      (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
    for (let round = 0; round < 50 && (await evaluate("document.readyState")) !== "complete"; round += 1) await sleep(100);
    return { evaluate };
  };
  return { send, page };
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "rfb-size": {
    const session = await rfbSession(Number(args[0]));
    console.log(`${session.width}x${session.height}`);
    break;
  }
  // Prints "open" if the session lasts the whole time, so a parent can tell a stream that a viewer lost.
  case "rfb-hold": {
    const session = await rfbSession(Number(args[0]));
    let open = true;
    session.socket.on("close", () => {
      open = false;
    });
    console.log("connected");
    await sleep(Number(args[1]) * 1000);
    console.log(open ? "open" : "closed");
    break;
  }
  case "rfb-frame": {
    const session = await rfbSession(Number(args[0]));
    writeFileSync(args[1], png(await frameOf(session), session.width, session.height));
    console.log(args[1]);
    break;
  }
  // Sends a click and keys through a stream, then reads what the focused page's input received.
  case "rfb-type": {
    const [cdpPort, vncPort] = args.map(Number);
    const { page } = await browser(cdpPort);
    const tab = await page("data:text/html,<input id=field autofocus style='width:100%25;height:100%25'>");
    await sleep(1000);
    const session = await rfbSession(vncPort);
    const pointer = Buffer.alloc(6);
    pointer[0] = 5;
    pointer.writeUInt16BE(640, 2);
    pointer.writeUInt16BE(400, 4);
    session.socket.write(pointer);
    pointer[1] = 1;
    session.socket.write(pointer);
    pointer[1] = 0;
    session.socket.write(pointer);
    await sleep(1000);
    for (const key of "xyz") {
      const event = Buffer.alloc(8);
      event[0] = 4;
      event.writeUInt32BE(key.charCodeAt(0), 4);
      event[1] = 1;
      session.socket.write(Buffer.from(event));
      event[1] = 0;
      session.socket.write(Buffer.from(event));
      await sleep(200);
    }
    await sleep(1500);
    console.log(`value=${await tab.evaluate("document.getElementById('field').value")}`);
    break;
  }
  case "sandbox": {
    const { page } = await browser(Number(args[0]));
    const tab = await page("chrome://sandbox");
    console.log(await tab.evaluate("document.body.innerText"));
    break;
  }
  case "windows": {
    const { send } = await browser(Number(args[0]));
    const { targetInfos } = await send("Target.getTargets");
    for (const target of targetInfos.filter((entry) => entry.type === "page")) {
      const { bounds } = await send("Browser.getWindowForTarget", { targetId: target.targetId });
      console.log(JSON.stringify({ url: target.url, ...bounds }));
    }
    break;
  }
  case "open": {
    const { page } = await browser(Number(args[0]));
    const tab = await page(args[1]);
    console.log(await tab.evaluate("document.title"));
    break;
  }
  case "cookie-set": {
    const { send } = await browser(Number(args[0]));
    await send("Storage.setCookies", {
      cookies: [
        {
          name: args[1],
          value: args[2],
          domain: "example.com",
          path: "/",
          secure: true,
          httpOnly: true,
          expires: Math.floor(Date.now() / 1000) + 86_400,
        },
      ],
    });
    console.log("set");
    break;
  }
  case "cookie-get": {
    const { send } = await browser(Number(args[0]));
    const { cookies } = await send("Storage.getCookies");
    console.log(cookies.find((cookie) => cookie.name === args[1])?.value ?? "none");
    break;
  }
  default:
    throw new Error(`there is no command named ${command}`);
}
process.exit(0);
