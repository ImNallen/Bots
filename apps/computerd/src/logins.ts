import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Cdp, CdpConnector } from "./browser.ts";
import { desktopOf, SLOTS, type DesktopLease } from "./desktops.ts";
import { log } from "./log.ts";

type PartitionKey = { topLevelSite: string; hasCrossSiteAncestor: boolean };

// One entry of Storage.getCookies.
export type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: string;
  priority?: string;
  sourceScheme?: string;
  sourcePort?: number;
  partitionKey?: PartitionKey;
};

// One entry of Storage.setCookies. A persistent cookie has expires and a session cookie has none.
export type CookieParam = {
  name: string;
  value: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  expires?: number;
  sameSite?: string;
  priority?: string;
  sourceScheme?: string;
  sourcePort?: number;
  partitionKey?: PartitionKey;
} & ({ url: string; domain?: never } | { domain: string; url?: never });

// A logout is an entry whose param.expires is in the past, so one code path sets and deletes.
export type MovedCookie = { key: string; param: CookieParam; generation: number };
export type Jar = { generation: number; cookies: MovedCookie[] };

// Chromium keeps a cookie for at most this long. So a logout stays in the jar this long, and after that no browser can still hold
// what it was for. A stopped bot has no schedule and can come back after any time, so a shorter limit could leave it logged in. A
// logout entry holds no value, so keeping it costs little.
export const MAX_COOKIE_LIFE_MS = 400 * 24 * 60 * 60 * 1000;

// .invalid can never resolve, so no site ever receives this cookie.
const CURSOR_DOMAIN = "logins.bots.invalid";

function cursorParam(generation: number, now: number): CookieParam {
  return {
    name: "generation",
    value: String(generation),
    url: `https://${CURSOR_DOMAIN}/`,
    path: "/",
    secure: true,
    httpOnly: true,
    expires: Math.floor((now + MAX_COOKIE_LIFE_MS) / 1000),
  };
}

// A domain cookie starts with a dot. A host-only cookie goes by url, because a domain would make it a domain cookie, and __Host-
// refuses those.
export function toParam(cookie: Cookie): CookieParam {
  const { name, value, path, httpOnly, secure, session, expires, sameSite, priority, sourceScheme, sourcePort, partitionKey } = cookie;
  return {
    name,
    value,
    path,
    httpOnly,
    secure,
    ...(cookie.domain.startsWith(".") ? { domain: cookie.domain } : { url: `${secure ? "https" : "http"}://${cookie.domain}${path}` }),
    ...(session ? {} : { expires }),
    ...(sameSite === undefined ? {} : { sameSite }),
    ...(priority === undefined ? {} : { priority }),
    ...(sourceScheme === undefined ? {} : { sourceScheme }),
    ...(sourcePort === undefined ? {} : { sourcePort }),
    ...(partitionKey === undefined ? {} : { partitionKey }),
  };
}

function keyOf(param: CookieParam): string {
  return JSON.stringify([param.name, param.domain ?? param.url?.split("/")[2], param.path, param.partitionKey ?? null]);
}

function isPast(param: CookieParam, now: number): boolean {
  return param.expires !== undefined && param.expires * 1000 <= now;
}

function byKey(cookies: readonly Cookie[]): Map<string, CookieParam> {
  const params = cookies.filter((cookie) => cookie.domain !== CURSOR_DOMAIN).map(toParam);
  return new Map(params.map((param) => [keyOf(param), param]));
}

// A browser restart drops session cookies, and that is not a logout. So a cookie that is gone counts only in the same browser.
export function diffCookies(baseline: readonly Cookie[], current: readonly Cookie[], sameBrowser: boolean, now: number): CookieParam[] {
  const before = byKey(baseline);
  const after = byKey(current);
  const changed = [...after].filter(([key, param]) => before.get(key)?.value !== param.value).map(([, param]) => param);
  const logouts = sameBrowser
    ? [...before]
        .filter(([key, param]) => !after.has(key) && !isPast(param, now))
        .map(([, param]) => ({ ...param, value: "", expires: Math.floor(now / 1000) - 1 }))
    : [];
  return [...changed, ...logouts];
}

// An equal value adds no generation, so a push into a bot under take-over cannot come back from it as a new change.
export function mergeJar(jar: Jar, moved: readonly CookieParam[], now: number): Jar {
  const entries = new Map(jar.cookies.map((entry) => [entry.key, entry]));
  const changed = moved.filter((param) => {
    const known = entries.get(keyOf(param))?.param;
    return known === undefined || known.value !== param.value || isPast(known, now) !== isPast(param, now);
  });
  const generation = changed.length === 0 ? jar.generation : Math.max(now, jar.generation + 1);
  for (const param of changed) {
    const key = keyOf(param);
    entries.set(key, { key, param, generation });
  }
  return {
    generation,
    cookies: [...entries.values()].filter((entry) => !isPast(entry.param, now) || now - entry.generation < MAX_COOKIE_LIFE_MS),
  };
}

function cursorOf(browser: readonly Cookie[]): number {
  return Number(browser.find((cookie) => cookie.domain === CURSOR_DOMAIN)?.value) || 0;
}

// A session cookie comes back whatever the cursor says, or a login on such a site would vanish at every idle stop.
export function planApply(jar: Jar, browser: readonly Cookie[], now: number): CookieParam[] {
  const cursor = cursorOf(browser);
  const held = byKey(browser);
  return jar.cookies
    .filter(({ key, param, generation }) => {
      if (isPast(param, now)) {
        return generation > cursor && held.has(key);
      }
      return generation > cursor || (param.expires === undefined && !held.has(key));
    })
    .map((entry) => entry.param);
}

// The cookies at the start of a take-over and the browser that held them. It exists only during a take-over, and it goes last, so
// a crash repeats the diff, and an equal value adds no generation.
type Baseline = { identity: string; cookies: Cookie[] };

export type Logins = {
  // A stopped slot is not an error. It never rejects, because a bot without a login is better than a bot without a browser.
  catchUp: (cdpPort: number) => Promise<void>;
  opened: (botId: string, cdpPort: number) => Promise<void>;
  closed: (botId: string, cdpPort: number) => Promise<void>;
  recover: (acquire: (botId: string) => Promise<DesktopLease>) => Promise<void>;
};

const BROWSER_DEADLINE_MS = 10_000;

export function createLogins(args: { dir: string; connector: CdpConnector; now?: () => number }): Logins {
  const { dir, connector, now = Date.now } = args;
  const jarFile = join(dir, "logins.json");
  const takeovers = join(dir, "takeovers");
  const baselineFile = (botId: string) => join(takeovers, `${botId}.json`);
  const openStreams = new Map<string, number>();
  const caughtUp = new Map<number, { identity: string; generation: number }>();
  const turns = new Map<number, Promise<void>>();
  let jar = readJar(jarFile);
  let tail: Promise<void> = Promise.resolve();

  // A push and a merge must not interleave, so everything that writes the jar or a baseline takes its turn here.
  function inOrder(event: string, step: () => Promise<void>): Promise<void> {
    tail = tail.then(step).catch((error: unknown) => warn(event, error));
    return tail;
  }

  // Null when the port refuses, which is a stopped slot. Closing the socket ends every call that is waiting on it.
  async function withBrowser<T>(cdpPort: number, use: (client: Cdp) => Promise<T>): Promise<T | null> {
    const client = await connector(cdpPort).catch(() => null);
    if (client === null) {
      return null;
    }
    const deadline = setTimeout(() => client.close(), BROWSER_DEADLINE_MS);
    deadline.unref();
    try {
      return await use(client);
    } finally {
      clearTimeout(deadline);
      client.close();
    }
  }

  async function applyTo(cdpPort: number): Promise<void> {
    await withBrowser(cdpPort, async (client) => {
      const current = await jar;
      const known = caughtUp.get(cdpPort);
      if (known?.identity === client.identity && known.generation === current.generation) {
        return;
      }
      const browser = await cookiesOf(client);
      const plan = planApply(current, browser, now());
      const rejected = await setCookies(client, plan);
      // Last, and on its own. A real VM showed that Chromium writes cookies to disk in the order they were set, so a cursor on disk
      // means that the batch before it is on disk too.
      if (current.generation > cursorOf(browser)) {
        await client.send("Storage.setCookies", { cookies: [cursorParam(current.generation, now())] });
      }
      caughtUp.set(cdpPort, { identity: client.identity, generation: current.generation });
      if (plan.length > 0) {
        log({ level: "info", event: "logins-applied", cdpPort, applied: plan.length - rejected, rejected });
      }
    });
  }

  // One browser at a time on each port, so an older catch-up cannot put back an older cursor after a newer one.
  function catchUp(cdpPort: number): Promise<void> {
    const turn = (turns.get(cdpPort) ?? Promise.resolve())
      .then(() => applyTo(cdpPort))
      .catch((error: unknown) => warn("logins-catch-up-failed", error));
    turns.set(cdpPort, turn);
    return turn;
  }

  async function publish(botId: string, cdpPort: number): Promise<void> {
    const baseline = await readBaseline(baselineFile(botId));
    if (baseline === null) {
      await rm(baselineFile(botId), { force: true });
      return;
    }
    const read = await withBrowser(cdpPort, async (client) => ({ identity: client.identity, cookies: await cookiesOf(client) }));
    if (read === null) {
      log({ level: "warn", event: "logins-publish-waits", botId });
      return;
    }
    const moved = diffCookies(baseline.cookies, read.cookies, baseline.identity === read.identity, now());
    const before = await jar;
    const next = mergeJar(before, moved, now());
    if (next.generation !== before.generation) {
      await writeSecret(jarFile, next);
    }
    jar = Promise.resolve(next);
    // A stopped or new bot catches up when it next starts, and a slot that changes hands during this gets the same jar.
    await Promise.all(SLOTS.map((slot) => catchUp(desktopOf(slot).cdpPort)));
    await rm(baselineFile(botId), { force: true });
    log({ level: "info", event: "logins-published", botId, moved: moved.length, generation: next.generation });
  }

  return {
    catchUp,
    opened: (botId, cdpPort) =>
      inOrder("logins-open-failed", async () => {
        openStreams.set(botId, (openStreams.get(botId) ?? 0) + 1);
        await catchUp(cdpPort);
        if ((await readBaseline(baselineFile(botId))) !== null) {
          return;
        }
        const baseline = await withBrowser(cdpPort, async (client) => ({ identity: client.identity, cookies: await cookiesOf(client) }));
        if (baseline === null) {
          log({ level: "warn", event: "logins-no-baseline", botId });
          return;
        }
        await writeSecret(baselineFile(botId), baseline);
      }),
    closed: (botId, cdpPort) =>
      inOrder("logins-publish-failed", async () => {
        const left = (openStreams.get(botId) ?? 1) - 1;
        if (left > 0) {
          openStreams.set(botId, left);
          return;
        }
        openStreams.delete(botId);
        await publish(botId, cdpPort);
      }),
    recover: (acquire) =>
      inOrder("logins-recover-failed", async () => {
        const files = await readdir(takeovers).catch(() => [] as string[]);
        for (const file of files.filter((name) => name.endsWith(".json"))) {
          const botId = file.slice(0, -".json".length);
          try {
            const lease = await acquire(botId);
            try {
              await publish(botId, lease.cdpPort);
            } finally {
              lease.release();
            }
          } catch (error) {
            warn("logins-recover-failed", error);
          }
        }
      }),
  };
}

async function cookiesOf(client: Cdp): Promise<Cookie[]> {
  return (await client.send("Storage.getCookies")).cookies as Cookie[];
}

// Chromium refuses a whole batch for one cookie that it cannot take, and sets none of it. Returns how many it still refuses alone.
async function setCookies(client: Cdp, cookies: readonly CookieParam[]): Promise<number> {
  if (cookies.length === 0) {
    return 0;
  }
  try {
    await client.send("Storage.setCookies", { cookies });
    return 0;
  } catch {
    let rejected = 0;
    for (const cookie of cookies) {
      await client.send("Storage.setCookies", { cookies: [cookie] }).catch(() => {
        rejected += 1;
      });
    }
    return rejected;
  }
}

async function readJson(file: string): Promise<unknown> {
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    // A parse error quotes the file, and the file holds cookie values, so this logs only that it happened.
    log({ level: "warn", event: "logins-file-unreadable" });
    return null;
  }
}

// A lost jar is safe. The next generation comes from the clock, so it is still ahead of every browser's cursor.
async function readJar(file: string): Promise<Jar> {
  const parsed = (await readJson(file)) as Jar | null;
  return typeof parsed?.generation === "number" && Array.isArray(parsed.cookies) ? parsed : { generation: 0, cookies: [] };
}

async function readBaseline(file: string): Promise<Baseline | null> {
  const parsed = (await readJson(file)) as Baseline | null;
  return Array.isArray(parsed?.cookies) ? parsed : null;
}

async function writeSecret(file: string, content: Jar | Baseline): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(`${file}.tmp`, JSON.stringify(content), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

function warn(event: string, error: unknown): void {
  log({ level: "warn", event, message: error instanceof Error ? error.message : "unknown error" });
}
