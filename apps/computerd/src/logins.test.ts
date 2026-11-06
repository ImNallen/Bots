import { describe, expect, it } from "vitest";
import { diffCookies, LOGOUT_KEEP_MS, mergeJar, planApply, toParam, type Cookie, type CookieParam, type Jar } from "./logins.ts";

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
