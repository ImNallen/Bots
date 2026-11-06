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

// Chromium keeps a cookie for at most 400 days, so after this no browser can still hold what a logout was for. A stopped bot has
// no schedule and can come back after any time, so a shorter limit could leave it logged in. A logout entry holds no value.
export const LOGOUT_KEEP_MS = 400 * 24 * 60 * 60 * 1000;

// .invalid can never resolve, so no site ever receives this cookie.
const CURSOR_DOMAIN = "logins.bots.invalid";

export function cursorParam(generation: number, now: number): CookieParam {
  return {
    name: "generation",
    value: String(generation),
    url: `https://${CURSOR_DOMAIN}/`,
    path: "/",
    secure: true,
    httpOnly: true,
    expires: Math.floor((now + LOGOUT_KEEP_MS) / 1000),
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
    cookies: [...entries.values()].filter((entry) => !isPast(entry.param, now) || now - entry.generation < LOGOUT_KEEP_MS),
  };
}

export function cursorOf(browser: readonly Cookie[]): number {
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
