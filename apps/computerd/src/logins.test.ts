import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CdpConnector } from "./browser.ts";
import { desktopOf, type Slot } from "./desktops.ts";
import { createLogins, diffCookies, LOGOUT_KEEP_MS, mergeJar, planApply, toParam, type Cookie, type CookieParam, type Jar, type Logins } from "./logins.ts";

const NOW = 1_800_000_000_000;
const LATER = Math.floor(NOW / 1000) + 3600;
const EARLIER = Math.floor(NOW / 1000) - 3600;

function cookie(name: string, value: string, more: Partial<Cookie> = {}): Cookie {
  return { name, value, domain: "a.test", path: "/", expires: LATER, httpOnly: false, secure: false, session: false, ...more };
}

const session = (name: string, value: string, more: Partial<Cookie> = {}) => cookie(name, value, { expires: -1, session: true, ...more });

function browserCursor(generation: number): Cookie {
  return { ...cookie("generation", String(generation)), domain: "logins.bots.invalid", secure: true };
}

function jarOf(...entries: Array<[CookieParam, number]>): Jar {
  return entries.reduce<Jar>((jar, [param, generation]) => mergeJar(jar, [param], generation), { generation: 0, cookies: [] });
}

describe("toParam", () => {
  it("sends a host-only cookie by url, or __Host- would fail", () => {
    const param = toParam(cookie("__Host-login", "v", { secure: true }));
    expect(param.url).toBe("https://a.test/");
    expect(param.domain).toBeUndefined();
  });

  it("sends a cookie that is not secure by an http url, on its own path", () => {
    expect(toParam(cookie("a", "v", { path: "/app" })).url).toBe("http://a.test/app");
  });

  it("sends a domain cookie by domain", () => {
    const param = toParam(cookie("a", "v", { domain: ".a.test" }));
    expect(param.domain).toBe(".a.test");
    expect(param.url).toBeUndefined();
  });

  it("gives a session cookie no expiry", () => {
    expect(toParam(session("a", "v")).expires).toBeUndefined();
    expect(toParam(cookie("a", "v")).expires).toBe(LATER);
  });

  it("copies what a real page's cookie carries, and nothing that the protocol cannot take", () => {
    const partitionKey = { topLevelSite: "https://top.test", hasCrossSiteAncestor: true };
    const param = toParam({
      ...cookie("a", "v", { secure: true, httpOnly: true, sameSite: "Strict", priority: "High", sourceScheme: "Secure", sourcePort: 8443, partitionKey }),
      size: 2,
    } as Cookie);
    expect(param).toEqual({
      name: "a",
      value: "v",
      path: "/",
      url: "https://a.test/",
      secure: true,
      httpOnly: true,
      expires: LATER,
      sameSite: "Strict",
      priority: "High",
      sourceScheme: "Secure",
      sourcePort: 8443,
      partitionKey,
    });
  });
});

describe("diffCookies", () => {
  const names = (params: CookieParam[]) => params.map((param) => param.name).sort();

  it.each([
    { what: "a new cookie moves", before: [], after: [cookie("a", "1")], moved: ["a"] },
    { what: "a changed value moves", before: [cookie("a", "1")], after: [cookie("a", "2")], moved: ["a"] },
    { what: "an equal value does not move", before: [cookie("a", "1")], after: [cookie("a", "1")], moved: [] },
    { what: "only a later expiry does not move", before: [cookie("a", "1")], after: [cookie("a", "1", { expires: LATER + 99 })], moved: [] },
    { what: "another path is another cookie", before: [cookie("a", "1")], after: [cookie("a", "1"), cookie("a", "1", { path: "/b" })], moved: ["a"] },
    { what: "another host is another cookie", before: [cookie("a", "1")], after: [cookie("a", "1"), cookie("a", "1", { domain: "b.test" })], moved: ["a"] },
    {
      what: "another partition is another cookie",
      before: [cookie("a", "1")],
      after: [cookie("a", "1"), cookie("a", "1", { partitionKey: { topLevelSite: "https://t.test", hasCrossSiteAncestor: true } })],
      moved: ["a"],
    },
    { what: "the cursor never moves", before: [], after: [browserCursor(5)], moved: [] },
  ])("$what", ({ before, after, moved }) => {
    expect(names(diffCookies(before, after, true, NOW))).toEqual(moved);
  });

  it("moves a cookie that is gone from the same browser as a logout that holds no value", () => {
    const [logout] = diffCookies([cookie("a", "secret", { httpOnly: true })], [], true, NOW);
    expect(logout?.value).toBe("");
    expect(logout?.httpOnly).toBe(true);
    expect((logout?.expires as number) * 1000).toBeLessThanOrEqual(NOW);
  });

  it("moves a session cookie that is gone from the same browser as a logout", () => {
    const [logout] = diffCookies([session("a", "1")], [], true, NOW);
    expect((logout?.expires as number) * 1000).toBeLessThanOrEqual(NOW);
  });

  it("does not take a browser restart for a logout", () => {
    expect(diffCookies([session("a", "1"), cookie("b", "1")], [], false, NOW)).toEqual([]);
  });

  it("does not take a cookie that expired by itself for a logout", () => {
    expect(diffCookies([cookie("a", "1", { expires: EARLIER })], [], true, NOW)).toEqual([]);
  });

  it("does not take a lost cursor for a logout", () => {
    expect(diffCookies([browserCursor(5)], [], true, NOW)).toEqual([]);
  });

  it("still moves a new cookie from a browser that restarted", () => {
    expect(names(diffCookies([session("a", "1")], [cookie("b", "1")], false, NOW))).toEqual(["b"]);
  });
});

describe("mergeJar", () => {
  const live = toParam(cookie("a", "1"));

  it("adds a new generation for a change", () => {
    const jar = mergeJar({ generation: 0, cookies: [] }, [live], NOW);
    expect(jar.generation).toBe(NOW);
    expect(jar.cookies).toHaveLength(1);
    expect(jar.cookies[0]?.generation).toBe(NOW);
  });

  it("keeps one entry for each key", () => {
    const jar = mergeJar(jarOf([live, NOW]), [toParam(cookie("a", "2"))], NOW + 5);
    expect(jar.cookies.map((entry) => entry.param.value)).toEqual(["2"]);
    expect(jar.generation).toBe(NOW + 5);
  });

  it("adds no generation for an equal value, so a push cannot come back as a change", () => {
    const first = jarOf([live, NOW]);
    expect(mergeJar(first, [live], NOW + 5)).toEqual(first);
  });

  it("adds no generation for a repeated logout", () => {
    const logout = diffCookies([cookie("a", "1")], [], true, NOW);
    const first = mergeJar({ generation: 0, cookies: [] }, logout, NOW);
    expect(mergeJar(first, diffCookies([cookie("a", "1")], [], true, NOW + 5), NOW + 5).generation).toBe(first.generation);
  });

  it("counts a cookie that comes back after a logout as a change, even with the same empty value", () => {
    const logout = diffCookies([cookie("a", "")], [], true, NOW);
    const first = mergeJar({ generation: 0, cookies: [] }, logout, NOW);
    expect(mergeJar(first, [toParam(cookie("a", ""))], NOW + 5).generation).toBe(NOW + 5);
  });

  it("raises the generation past a clock that went back, so no browser's cursor can be ahead of it", () => {
    const first = jarOf([live, NOW]);
    expect(mergeJar(first, [toParam(cookie("a", "2"))], NOW - 1000).generation).toBe(NOW + 1);
  });

  it("gives a lost jar a generation that a browser's older cursor still sees as new", () => {
    const rebuilt = mergeJar({ generation: 0, cookies: [] }, [live], NOW);
    expect(planApply(rebuilt, [browserCursor(NOW - 1000)], NOW)).toHaveLength(1);
  });

  it("keeps a logout until it can no longer matter, and then drops it", () => {
    const logout = diffCookies([cookie("a", "1")], [], true, NOW);
    const first = mergeJar({ generation: 0, cookies: [] }, logout, NOW);
    const other = toParam(cookie("b", "1", { expires: Math.floor(NOW / 1000) + 2 * LOGOUT_KEEP_MS }));
    expect(mergeJar(first, [other], NOW + LOGOUT_KEEP_MS - 1).cookies).toHaveLength(2);
    expect(mergeJar(first, [other], NOW + LOGOUT_KEEP_MS).cookies.map((entry) => entry.param.name)).toEqual(["b"]);
  });

  it("keeps a session cookie, which has no expiry of its own", () => {
    const first = jarOf([toParam(session("a", "1")), NOW]);
    expect(mergeJar(first, [], NOW + 2 * LOGOUT_KEEP_MS).cookies).toHaveLength(1);
  });
});

describe("planApply", () => {
  const value = (params: CookieParam[]) => params.map((param) => `${param.name}=${param.value}`).sort();

  it("plans every entry for a new browser with no cursor", () => {
    expect(value(planApply(jarOf([toParam(cookie("a", "1")), NOW]), [], NOW))).toEqual(["a=1"]);
  });

  it("plans only entries newer than the cursor", () => {
    const jar = jarOf([toParam(cookie("a", "1")), NOW], [toParam(cookie("b", "1")), NOW + 5]);
    expect(value(planApply(jar, [browserCursor(NOW)], NOW + 5))).toEqual(["b=1"]);
  });

  it("leaves a cookie that a bot rotated, once the cursor has passed it", () => {
    const jar = jarOf([toParam(cookie("a", "1")), NOW]);
    expect(planApply(jar, [browserCursor(NOW), cookie("a", "rotated")], NOW + 5)).toEqual([]);
  });

  it("brings back a session cookie that a restart dropped, whatever the cursor says", () => {
    const jar = jarOf([toParam(session("a", "1")), NOW]);
    expect(value(planApply(jar, [browserCursor(NOW)], NOW + 5))).toEqual(["a=1"]);
  });

  it("leaves a session cookie that the browser still has", () => {
    const jar = jarOf([toParam(session("a", "1")), NOW]);
    expect(planApply(jar, [browserCursor(NOW), session("a", "rotated")], NOW + 5)).toEqual([]);
  });

  it("sends a logout to a browser that holds the cookie", () => {
    const jar = mergeJar({ generation: 0, cookies: [] }, diffCookies([cookie("a", "1")], [], true, NOW), NOW);
    const [plan] = planApply(jar, [cookie("a", "1")], NOW + 5);
    expect(plan?.value).toBe("");
  });

  it("sends no logout to a browser with no such cookie, since it has nothing to do", () => {
    const jar = mergeJar({ generation: 0, cookies: [] }, diffCookies([cookie("a", "1")], [], true, NOW), NOW);
    expect(planApply(jar, [], NOW + 5)).toEqual([]);
  });

  it("does not bring back a session cookie that was logged out, once the cursor has passed it", () => {
    const jar = mergeJar({ generation: 0, cookies: [] }, diffCookies([session("a", "1")], [], true, NOW), NOW);
    expect(planApply(jar, [browserCursor(NOW)], NOW + 5)).toEqual([]);
  });

  it("treats a cursor it cannot read as no cursor, so everything applies again", () => {
    const jar = jarOf([toParam(cookie("a", "1")), NOW]);
    expect(value(planApply(jar, [{ ...browserCursor(0), value: "garbage" }], NOW + 5))).toEqual(["a=1"]);
  });
});

// Behaves as a real VM showed Chromium does. A past expiry deletes, a batch with one bad cookie sets none of it, a restart gives a
// new identity and drops session cookies, and what was not flushed is lost.
class FakeBrowser {
  identity: string = crypto.randomUUID();
  cookies: Cookie[] = [];
  disk: Cookie[] = [];

  site(item: Cookie): void {
    this.cookies = [...this.cookies.filter((known) => !sameCookie(known, item)), item];
  }

  flush(): void {
    this.disk = this.cookies.filter((known) => !known.session);
  }

  restart(): void {
    this.identity = crypto.randomUUID();
    this.cookies = this.disk;
  }

  value(name: string): string | undefined {
    return this.cookies.find((known) => known.name === name)?.value;
  }
}

const sameCookie = (a: Cookie, b: Cookie) => a.name === b.name && a.domain === b.domain && a.path === b.path;
const REFUSED = "refused-by-the-browser";

function fromParam(param: CookieParam): Cookie {
  return {
    ...param,
    domain: param.domain ?? (param.url as string).split("/")[2] as string,
    expires: param.expires ?? -1,
    session: param.expires === undefined,
  };
}

describe("createLogins", () => {
  let dir: string;
  let clock: number;
  let browsers: Map<number, FakeBrowser>;
  let hook: (() => Promise<void> | void) | null;
  let calls: string[];
  let written: string[];

  const portOf = (slot: Slot) => desktopOf(slot).cdpPort;
  const A = portOf(1);
  const B = portOf(2);
  const C = portOf(3);

  const connector: CdpConnector = async (cdpPort) => {
    const browser = browsers.get(cdpPort);
    if (browser === undefined) {
      throw new Error("this computer has no running browser");
    }
    calls.push("connect");
    return {
      identity: browser.identity,
      onClose: () => {},
      close: () => {},
      send: async (method, params = {}) => {
        await hook?.();
        calls.push(method);
        if (method === "Storage.getCookies") {
          return { cookies: browser.cookies };
        }
        const cookies = params.cookies as CookieParam[];
        if (cookies.some((param) => param.name === REFUSED)) {
          throw new Error("Invalid cookie fields");
        }
        for (const param of cookies) {
          const item = fromParam(param);
          browser.cookies = browser.cookies.filter((known) => !sameCookie(known, item));
          if (item.session || item.expires * 1000 > clock) {
            browser.cookies.push(item);
          }
        }
        return {};
      },
    };
  };

  const computerd = (): Logins => createLogins({ dir, connector, now: () => clock });
  const running = (cdpPort: number): FakeBrowser => {
    const browser = new FakeBrowser();
    browsers.set(cdpPort, browser);
    return browser;
  };
  const jarOnDisk = async (): Promise<Jar> => JSON.parse(await readFile(join(dir, "logins.json"), "utf8")) as Jar;
  const leftBaselines = () => readdir(join(dir, "takeovers")).catch(() => [] as string[]);
  const leaseOn = (cdpPort: number) => async () => ({ slot: (cdpPort - 9300) as Slot, cdpPort, release: () => {} });
  const login = (value = "logged-in") => cookie("login", value, { httpOnly: true, secure: true });

  beforeEach(async () => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((line) => {
      written.push(String(line));
      return true;
    });
    dir = await mkdtemp(join(tmpdir(), "logins-test-"));
    clock = NOW;
    browsers = new Map();
    hook = null;
    calls = [];
  });

  async function takeOverAndLogIn(logins: Logins, value = "logged-in"): Promise<void> {
    await logins.opened("a", A);
    (browsers.get(A) as FakeBrowser).site(login(value));
    await logins.closed("a", A);
  }

  it("gives a login to a running bot at give-back, and to a stopped or new bot when it starts", async () => {
    const [a, b] = [running(A), running(B)];
    const logins = computerd();
    await takeOverAndLogIn(logins);
    expect(a.value("login")).toBe("logged-in");
    expect(b.value("login")).toBe("logged-in");

    const started = running(C);
    expect(started.value("login")).toBeUndefined();
    await logins.catchUp(C);
    expect(started.value("login")).toBe("logged-in");
  });

  it("keeps the jar and the baseline to computerd alone", async () => {
    running(A);
    const logins = computerd();
    await logins.opened("a", A);
    expect((await stat(join(dir, "takeovers", "a.json"))).mode & 0o777).toBe(0o600);
    (browsers.get(A) as FakeBrowser).site(login());
    await logins.closed("a", A);
    expect((await stat(join(dir, "logins.json"))).mode & 0o777).toBe(0o600);
    expect(await leftBaselines()).toEqual([]);
  });

  it("moves only what the take-over changed, so an old session elsewhere stays out", async () => {
    const [a, b] = [running(A), running(B)];
    a.site(cookie("old", "from-before"));
    await takeOverAndLogIn(computerd());
    expect(b.value("login")).toBe("logged-in");
    expect(b.value("old")).toBeUndefined();
  });

  it("logs counts and never a cookie's name or value", async () => {
    const [a, b] = [running(A), running(B)];
    const logins = computerd();
    await logins.opened("a", A);
    a.site(cookie("secretname", "secretvalue"));
    a.site(cookie(REFUSED, "secretvalue2"));
    await logins.closed("a", A);
    expect(b.value("secretname")).toBe("secretvalue");
    expect(written.join("")).toContain("logins-published");
    expect(written.join("")).not.toMatch(/secretname|secretvalue|refused-by/);
  });

  it("carries a logout to the other bots, and does not bring it back", async () => {
    const [a, b] = [running(A), running(B)];
    const logins = computerd();
    await takeOverAndLogIn(logins);
    await logins.opened("a", A);
    a.cookies = [];
    clock += 1000;
    await logins.closed("a", A);
    expect(b.value("login")).toBeUndefined();

    const later = running(C);
    await logins.catchUp(C);
    expect(later.value("login")).toBeUndefined();
  });

  it("does not let a push into a bot under take-over come back as a new generation", async () => {
    const [a, b] = [running(A), running(B)];
    const logins = computerd();
    await logins.opened("b", B);
    await takeOverAndLogIn(logins);
    expect(b.value("login")).toBe("logged-in");
    const { generation } = await jarOnDisk();
    clock += 1000;
    await logins.closed("b", B);
    expect((await jarOnDisk()).generation).toBe(generation);
    expect(a.value("login")).toBe("logged-in");
  });

  it("publishes once when a newer tab replaces an older one, from the first baseline", async () => {
    const [a, b] = [running(A), running(B)];
    a.site(cookie("old", "1"));
    const logins = computerd();
    await logins.opened("a", A);
    a.site(login());
    await logins.opened("a", A);
    await logins.closed("a", A);
    expect(b.value("login")).toBeUndefined();
    await logins.closed("a", A);
    expect(b.value("login")).toBe("logged-in");
    expect(await leftBaselines()).toEqual([]);
  });

  it("does not take a browser restart during a take-over for a logout", async () => {
    const [a, b] = [running(A), running(B)];
    a.site(session("kept", "1"));
    b.site(session("kept", "1"));
    const logins = computerd();
    await logins.opened("a", A);
    a.flush();
    a.restart();
    a.site(login());
    await logins.closed("a", A);
    expect(b.value("kept")).toBe("1");
    expect(b.value("login")).toBe("logged-in");
  });

  it("brings a session login back after a restart, and leaves what a bot rotated", async () => {
    const [a, b] = [running(A), running(B)];
    const logins = computerd();
    await logins.opened("a", A);
    a.site(session("sess", "1"));
    a.site(cookie("rotating", "from-owner"));
    await logins.closed("a", A);
    b.site(cookie("rotating", "rotated-by-bot"));
    b.flush();
    b.restart();
    expect(b.value("sess")).toBeUndefined();
    await logins.catchUp(B);
    expect(b.value("sess")).toBe("1");
    expect(b.value("rotating")).toBe("rotated-by-bot");
  });

  it("applies again when a browser stopped before its flush, because the cursor went with the cookies", async () => {
    running(A);
    const b = running(B);
    const logins = computerd();
    await takeOverAndLogIn(logins);
    b.restart();
    expect(b.value("login")).toBeUndefined();
    await logins.catchUp(B);
    expect(b.value("login")).toBe("logged-in");
  });

  it("returns with no cookie call when nothing has changed, because every acquire calls it", async () => {
    running(A);
    const logins = computerd();
    await takeOverAndLogIn(logins);
    await logins.catchUp(A);
    calls = [];
    await logins.catchUp(A);
    expect(calls).toEqual(["connect"]);
  });

  it("looks again when the browser restarted, though the jar did not change", async () => {
    const a = running(A);
    const logins = computerd();
    await takeOverAndLogIn(logins);
    a.restart();
    calls = [];
    await logins.catchUp(A);
    expect(calls).toContain("Storage.getCookies");
  });

  it("treats a refused port as a stopped slot, so a push still reaches the rest", async () => {
    const a = running(A);
    const c = running(C);
    const logins = computerd();
    await takeOverAndLogIn(logins);
    expect(a.value("login")).toBe("logged-in");
    expect(c.value("login")).toBe("logged-in");
    expect(written.join("")).not.toContain("logins-catch-up-failed");
  });

  it("retries a refused batch one by one, and still moves the cursor", async () => {
    const [a, b] = [running(A), running(B)];
    const logins = computerd();
    await logins.opened("a", A);
    a.site(login());
    a.site(cookie(REFUSED, "x"));
    await logins.closed("a", A);
    expect(b.value("login")).toBe("logged-in");
    expect(b.value(REFUSED)).toBeUndefined();
    expect(written.join("")).toContain('"rejected":1');
    b.flush();
    b.restart();
    calls = [];
    await logins.catchUp(B);
    expect(calls).not.toContain("Storage.setCookies");
  });

  it("resolves when a browser fails during a catch-up, and tries again next time", async () => {
    running(A);
    const b = running(B);
    const logins = computerd();
    await takeOverAndLogIn(logins);
    b.cookies = [];
    b.identity = "restarted";
    hook = () => {
      throw new Error("the browser closed the connection");
    };
    await expect(logins.catchUp(B)).resolves.toBeUndefined();
    hook = null;
    await logins.catchUp(B);
    expect(b.value("login")).toBe("logged-in");
  });

  it("keeps the baseline when the browser cannot be read at give-back, and the next give-back publishes", async () => {
    const [a, b] = [running(A), running(B)];
    const logins = computerd();
    await logins.opened("a", A);
    a.site(login());
    browsers.delete(A);
    await logins.closed("a", A);
    expect(b.value("login")).toBeUndefined();
    expect(await leftBaselines()).toEqual(["a.json"]);

    browsers.set(A, a);
    await logins.opened("a", A);
    await logins.closed("a", A);
    expect(b.value("login")).toBe("logged-in");
    expect(await leftBaselines()).toEqual([]);
  });

  it("starts from an empty jar when the file cannot be read, and logs none of it", async () => {
    await writeFile(join(dir, "logins.json"), '{"generation": 5, "cookies": [{"secretvalue');
    running(A);
    const b = running(B);
    await takeOverAndLogIn(computerd());
    expect(b.value("login")).toBe("logged-in");
    expect((await jarOnDisk()).generation).toBe(NOW);
    expect(written.join("")).toContain("logins-file-unreadable");
    expect(written.join("")).not.toContain("secretvalue");
  });

  it("orders a give-back and the next take-over, so a push and a merge never interleave", async () => {
    const a = running(A);
    const logins = computerd();
    const order: string[] = [];
    await logins.opened("a", A);
    a.site(login());
    const closing = logins.closed("a", A).then(() => order.push("closed"));
    const opening = logins.opened("a", A).then(() => order.push("opened"));
    await Promise.all([closing, opening]);
    expect(order).toEqual(["closed", "opened"]);
    const baseline = JSON.parse(await readFile(join(dir, "takeovers", "a.json"), "utf8")) as { cookies: Cookie[] };
    expect(baseline.cookies.map((known) => known.name)).toContain("login");
  });

  describe("a kill at each browser call", () => {
    // A killed process runs no further step, so the old instance hangs where it stopped, and a new one starts over the same files.
    function killAtCall(target: number): { killed: () => boolean } {
      let seen = 0;
      let dead = false;
      hook = () => {
        seen += 1;
        if (seen > target) {
          dead = true;
          return new Promise(() => {});
        }
      };
      return { killed: () => dead };
    }

    const until = async (done: () => boolean) => {
      while (!done()) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    };

    it("still publishes a give-back, with one generation", async () => {
      let killAt = 0;
      for (; ; killAt += 1) {
        dir = await mkdtemp(join(tmpdir(), "logins-kill-"));
        const [a, b] = [running(A), running(B)];
        const first = computerd();
        await first.opened("a", A);
        a.site(login());
        const { killed } = killAtCall(killAt);
        let finished = false;
        void first.closed("a", A).then(() => {
          finished = true;
        });
        await until(() => finished || killed());
        hook = null;

        await computerd().recover(leaseOn(A));
        expect(b.value("login"), `a kill at call ${killAt}`).toBe("logged-in");
        expect(await leftBaselines(), `a kill at call ${killAt}`).toEqual([]);
        expect((await jarOnDisk()).generation, `a kill at call ${killAt}`).toBe(NOW);
        if (!killed()) {
          break;
        }
      }
      expect(killAt).toBeGreaterThanOrEqual(5);
    });

    it("leaves nothing wrong behind a kill during the start of a take-over", async () => {
      let killAt = 0;
      for (; ; killAt += 1) {
        dir = await mkdtemp(join(tmpdir(), "logins-kill-"));
        const [a, b] = [running(A), running(B)];
        a.site(cookie("old", "1"));
        const first = computerd();
        const { killed } = killAtCall(killAt);
        let finished = false;
        void first.opened("a", A).then(() => {
          finished = true;
        });
        await until(() => finished || killed());
        hook = null;

        await computerd().recover(leaseOn(A));
        expect(b.value("old"), `a kill at call ${killAt}`).toBeUndefined();
        expect(await leftBaselines(), `a kill at call ${killAt}`).toEqual([]);
        if (!killed()) {
          break;
        }
      }
      expect(killAt).toBeGreaterThanOrEqual(1);
    });

    it("repeats the diff after a kill just before the baseline goes, with no new generation and nothing overwritten", async () => {
      const [a, b] = [running(A), running(B)];
      const first = computerd();
      await first.opened("a", A);
      const baseline = await readFile(join(dir, "takeovers", "a.json"), "utf8");
      a.site(login());
      await first.closed("a", A);
      const { generation } = await jarOnDisk();
      b.site(login("rotated-by-bot"));

      await writeFile(join(dir, "takeovers", "a.json"), baseline);
      clock += 1000;
      await computerd().recover(leaseOn(A));
      expect((await jarOnDisk()).generation).toBe(generation);
      expect(b.value("login")).toBe("rotated-by-bot");
      expect(await leftBaselines()).toEqual([]);
    });

    it("keeps a baseline whose bot cannot start, for the next start of computerd", async () => {
      const a = running(A);
      const first = computerd();
      await first.opened("a", A);
      a.site(login());
      await computerd().recover(() => Promise.reject(new Error("every screen on this computer is in use")));
      expect(await leftBaselines()).toEqual(["a.json"]);
      const b = running(B);
      await computerd().recover(leaseOn(A));
      expect(b.value("login")).toBe("logged-in");
    });

    it("releases the lease after a recovery, and ignores a temp file that a kill left", async () => {
      const a = running(A);
      const first = computerd();
      await first.opened("a", A);
      a.site(login());
      await writeFile(join(dir, "takeovers", "z.json.tmp"), "partial");
      let released = 0;
      const seen: string[] = [];
      await computerd().recover(async (botId) => {
        seen.push(botId);
        return { slot: 1, cdpPort: A, release: () => (released += 1) };
      });
      expect(seen).toEqual(["a"]);
      expect(released).toBe(1);
    });
  });
});
