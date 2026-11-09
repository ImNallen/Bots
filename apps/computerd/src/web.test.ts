import { Readable } from "node:stream";
import { OUTPUT_CAP_BYTES, type WebInvocation } from "@bots/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Resolve } from "./addresses.ts";
import { createWeb, type Network, type Opened } from "./web.ts";

type Page = Partial<Omit<Opened, "body">> & { body?: string | Readable };
type Answers = readonly string[] | Error | (() => readonly string[]);

function fakeNetwork(args: { dns: Record<string, Answers>; pages: Record<string, Page | Error | (() => Promise<Opened>)> }) {
  const opened: { url: string; host: string; ip: string }[] = [];
  const resolve: Resolve = async (hostname) => {
    const answers = args.dns[hostname];
    if (answers === undefined) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    }
    if (answers instanceof Error) {
      throw answers;
    }
    return (typeof answers === "function" ? answers() : answers).map((address) => ({ address }));
  };
  const network: Network = {
    resolve,
    open: async ({ url, address }) => {
      opened.push({ url: url.href, host: url.host, ip: address.ip });
      const page = args.pages[url.href];
      if (page === undefined) {
        return { status: 404, statusText: "Not Found", location: undefined, contentType: "text/plain", body: Readable.from(["no such page"]) };
      }
      if (page instanceof Error) {
        throw page;
      }
      if (typeof page === "function") {
        return await page();
      }
      const body = page.body instanceof Readable ? page.body : Readable.from([Buffer.from(page.body ?? "")]);
      return { status: 200, statusText: "OK", location: undefined, contentType: "text/html", ...page, body };
    },
  };
  return { network, opened };
}

const fetchOf = (url: string, start = 0): WebInvocation => ({ name: "web_fetch", args: { url, start } });
const signal = new AbortController().signal;
const PUBLIC = "93.184.216.34";

afterEach(() => {
  vi.useRealTimers();
});

describe("web_fetch's addresses", () => {
  it.each([
    ["http://127.0.0.1:9301/json/close/x", "127.0.0.1 is not one"],
    ["http://[::1]/", "::1 is not one"],
    ["http://2130706433/", "127.0.0.1 is not one"],
    ["http://0x7f.1/", "127.0.0.1 is not one"],
    ["http://localhost/", "localhost is at 127.0.0.1, which is not one"],
    ["http://10.78.0.2:8788/", "10.78.0.2 is not one"],
  ])("refuses %s without opening anything", async (url, reason) => {
    const { network, opened } = fakeNetwork({ dns: { localhost: ["127.0.0.1", "::1"] }, pages: {} });
    const result = await createWeb({ network }).execute({ tool: fetchOf(url), signal });
    expect(result).toEqual({ outcome: "error", output: expect.stringContaining(reason), truncated: false });
    expect(opened).toEqual([]);
  });

  it("checks a redirect before it connects, so a public page that redirects to the link opens only the first hop", async () => {
    const { network, opened } = fakeNetwork({
      dns: { "a.example": [PUBLIC], "inside.example": ["10.78.0.2"] },
      pages: { "http://a.example/": { status: 302, location: "http://inside.example:8788/" } },
    });
    const result = await createWeb({ network }).execute({ tool: fetchOf("http://a.example/"), signal });
    expect(result).toMatchObject({ outcome: "error", output: expect.stringContaining("inside.example is at 10.78.0.2, which is not one") });
    expect(opened).toEqual([{ url: "http://a.example/", host: "a.example", ip: PUBLIC }]);
  });

  it("connects to exactly the address it checked, so a name that answers publicly and then privately is refused at its second hop", async () => {
    const answers = [[PUBLIC], ["127.0.0.1"]];
    const { network, opened } = fakeNetwork({
      dns: { "flip.example": () => answers.shift() ?? [] },
      pages: { "http://flip.example/": { status: 301, location: "/again" } },
    });
    const result = await createWeb({ network }).execute({ tool: fetchOf("http://flip.example/"), signal });
    expect(result).toMatchObject({ outcome: "error", output: expect.stringContaining("flip.example is at 127.0.0.1") });
    expect(opened).toEqual([{ url: "http://flip.example/", host: "flip.example", ip: PUBLIC }]);
  });

  it("connects only to an address that publicAddressFor checked, which the typecheck enforces", () => {
    const unchecked = { ip: "127.0.0.1", family: 4 } as const;
    // @ts-expect-error A plain object is not a PublicAddress.
    const request: Parameters<Network["open"]>[0] = { url: new URL("http://127.0.0.1/"), address: unchecked, signal };
    expect(request.address.ip).toBe("127.0.0.1");
  });
});

describe("web_fetch's redirects", () => {
  it("follows a relative Location against the current page, and names where it ended", async () => {
    const { network, opened } = fakeNetwork({
      dns: { "a.example": [PUBLIC] },
      pages: {
        "https://a.example/docs/start": { status: 307, location: "../guide?page=2" },
        "https://a.example/guide?page=2": { body: "<title>Guide</title><p>Welcome.</p>" },
      },
    });
    const result = await createWeb({ network }).execute({ tool: fetchOf("https://a.example/docs/start"), signal });
    expect(result).toEqual({ outcome: "ok", output: "Redirected to: https://a.example/guide?page=2\nTitle: Guide\n\nWelcome.", truncated: false });
    expect(opened.map((hop) => hop.url)).toEqual(["https://a.example/docs/start", "https://a.example/guide?page=2"]);
  });

  it("stops after 5 redirects", async () => {
    const pages = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`https://a.example/${index}`, { status: 302, location: `/${index + 1}` }]));
    const { network, opened } = fakeNetwork({ dns: { "a.example": [PUBLIC] }, pages });
    const result = await createWeb({ network }).execute({ tool: fetchOf("https://a.example/0"), signal });
    expect(result).toEqual({ outcome: "error", output: "The page redirected more than 5 times.", truncated: false });
    expect(opened).toHaveLength(6);
  });

  it.each(["ftp://a.example/file", "https://user:secret@b.example/", "javascript:alert(1)"])("refuses a redirect to %s", async (location) => {
    const { network, opened } = fakeNetwork({ dns: { "a.example": [PUBLIC], "b.example": [PUBLIC] }, pages: { "https://a.example/": { status: 302, location } } });
    const result = await createWeb({ network }).execute({ tool: fetchOf("https://a.example/"), signal });
    expect(result).toEqual({ outcome: "error", output: `The page redirected to ${location}, which cannot be opened.`, truncated: false });
    expect(opened).toHaveLength(1);
  });
});

describe("web_fetch's limits and failures", () => {
  it("reads at most 4 MiB, stops the download, and says the page was cut", async () => {
    let produced = 0;
    const endless = new Readable({
      read() {
        produced += 64 * 1024;
        this.push(Buffer.alloc(64 * 1024, "a"));
      },
    });
    const { network } = fakeNetwork({ dns: { "big.example": [PUBLIC] }, pages: { "https://big.example/": { contentType: "text/plain", body: endless } } });
    const result = await createWeb({ network }).execute({ tool: fetchOf("https://big.example/"), signal });
    expect(result.outcome).toBe("ok");
    expect(result.truncated).toBe(true);
    expect(result.output).toContain("The page was too large, so only its start was read.");
    expect(endless.destroyed).toBe(true);
    expect(produced).toBeLessThan(5 * 1024 * 1024);
  });

  it("gives up after 30 seconds", async () => {
    vi.useFakeTimers();
    const { network } = fakeNetwork({ dns: { "slow.example": [PUBLIC] }, pages: { "https://slow.example/": () => new Promise<Opened>(() => {}) } });
    const pending = createWeb({ network }).execute({ tool: fetchOf("https://slow.example/"), signal });
    await vi.advanceTimersByTimeAsync(29_000);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual({ outcome: "timeout", output: "The page took longer than 30 seconds.", truncated: false });
  });

  it("is cancelled before it starts, and while it reads", async () => {
    const { network, opened } = fakeNetwork({ dns: { "a.example": [PUBLIC] }, pages: { "https://a.example/": { body: new Readable({ read() {} }) } } });
    const web = createWeb({ network });
    expect(await web.execute({ tool: fetchOf("https://a.example/"), signal: AbortSignal.abort() })).toEqual({
      outcome: "cancelled",
      output: "The call was cancelled before it started.",
      truncated: false,
    });
    expect(opened).toEqual([]);
    const controller = new AbortController();
    const reading = web.execute({ tool: fetchOf("https://a.example/"), signal: controller.signal });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    controller.abort();
    expect(await reading).toEqual({ outcome: "cancelled", output: "The call was cancelled.", truncated: false });
  });

  it.each([
    ["a name with no address", "https://gone.example/", "gone.example has no address."],
    ["a refused connection", "https://shut.example/", "shut.example refused the connection."],
    ["a certificate for another name", "https://wrong.example/", "wrong.example has a certificate that does not match its name."],
    ["an expired certificate", "https://old.example/", "old.example has a certificate that cannot be trusted (CERT_HAS_EXPIRED)."],
    ["a body that breaks off", "https://broken.example/", "broken.example closed the connection."],
    ["any other failure", "https://garbled.example/", "Reading garbled.example failed: Z_DATA_ERROR incorrect header check"],
  ])("turns %s into an error result", async (_label, url, output) => {
    const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
    const broken = new Readable({
      read() {
        this.destroy(failure("ECONNRESET", "socket hang up"));
      },
    });
    const { network } = fakeNetwork({
      dns: { "shut.example": [PUBLIC], "wrong.example": [PUBLIC], "old.example": [PUBLIC], "broken.example": [PUBLIC], "garbled.example": [PUBLIC] },
      pages: {
        "https://shut.example/": failure("ECONNREFUSED", "connect ECONNREFUSED"),
        "https://wrong.example/": failure("ERR_TLS_CERT_ALTNAME_INVALID", "Hostname/IP does not match certificate's altnames"),
        "https://old.example/": failure("CERT_HAS_EXPIRED", "certificate has expired"),
        "https://broken.example/": { body: broken },
        "https://garbled.example/": failure("Z_DATA_ERROR", "incorrect header check"),
      },
    });
    expect(await createWeb({ network }).execute({ tool: fetchOf(url), signal })).toEqual({ outcome: "error", output, truncated: false });
  });

  it("keeps every output under the output cap", async () => {
    const links = Array.from({ length: 3000 }, (_, index) => `<a href="https://a.example/${"x".repeat(1500)}/${index}">${"word ".repeat(80)}</a>`).join(" ");
    const { network } = fakeNetwork({
      dns: { "a.example": [PUBLIC] },
      pages: { "https://a.example/": { body: `<title>${"t".repeat(5000)}</title><p>${links}</p>` } },
    });
    const result = await createWeb({ network }).execute({ tool: fetchOf("https://a.example/"), signal });
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(OUTPUT_CAP_BYTES);
    expect(result.output).not.toContain("bytes omitted");
  });
});
