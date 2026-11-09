import { OUTPUT_CAP_BYTES } from "@bots/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSearch, type Fetch } from "./search.ts";

const SEARXNG = "http://127.0.0.1:8789";
const QUERY = "sqlite wal mode";
const ELSEWHERE =
  "open https://duckduckgo.com/?q=sqlite%20wal%20mode or https://www.bing.com/search?q=sqlite%20wal%20mode with browser_navigate";

// Shaped like a real answer from searxng/searxng:2026.11.9-57ff753ad, fields and all.
function result(title: string, url: string, content: string | null = "") {
  return {
    template: "default.html",
    title,
    content,
    img_src: "",
    thumbnail: "",
    publishedDate: "2026-08-25T00:00:00",
    engines: ["brave", "google cse"],
    positions: [4, 1],
    score: 2.5,
    category: "general",
    url,
    engine: "brave",
    parsed_url: ["https", new URL(url).hostname, "/", "", "", ""],
  };
}

function answer(results: unknown[], unresponsive: [string, string][] = []) {
  return { query: QUERY, results, answers: [], corrections: [], infoboxes: [], suggestions: ["sqlite journal mode"], unresponsive_engines: unresponsive };
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

function fakeFetch(respond: () => Response | Promise<Response>) {
  const requested: URL[] = [];
  const fetch: Fetch = async (url, init) => {
    requested.push(new URL(url));
    init.signal.throwIfAborted();
    return await respond();
  };
  return { fetch, requested };
}

const hanging: Fetch = (_url, init) =>
  new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));

const search = (fetch: Fetch, signal = new AbortController().signal) => createSearch({ url: SEARXNG, fetch })({ query: QUERY, signal });

afterEach(() => {
  vi.useRealTimers();
});

describe("web_search through SearXNG", () => {
  it("asks SearXNG for JSON, and reads its results in order as a title, an address, and a snippet, naming no engine", async () => {
    const { fetch, requested } = fakeFetch(() =>
      json(
        answer([
          result("Write-Ahead Logging - SQLite", "https://www.sqlite.org/wal.html", "The default method by which SQLite\n implements   atomic commit is a rollback journal."),
          result("  A guide to WAL & checkpoints ", "https://example.org/guide?topic=wal&lang=en", null),
          result("Café au lait - Wiki", "https://wiki.example/Café_au_lait", "A result with an address that needs encoding."),
        ]),
      ),
    );
    expect(await search(fetch)).toEqual({
      outcome: "ok",
      output: [
        'Results for "sqlite wal mode":',
        "",
        "1. Write-Ahead Logging - SQLite",
        "   https://www.sqlite.org/wal.html",
        "   The default method by which SQLite implements atomic commit is a rollback journal.",
        "",
        "2. A guide to WAL & checkpoints",
        "   https://example.org/guide?topic=wal&lang=en",
        "",
        "3. Café au lait - Wiki",
        "   https://wiki.example/Caf%C3%A9_au_lait",
        "   A result with an address that needs encoding.",
      ].join("\n"),
      truncated: false,
    });
    expect(requested.map((url) => [url.origin, url.pathname, url.searchParams.get("q"), url.searchParams.get("format")])).toEqual([
      [SEARXNG, "/search", QUERY, "json"],
    ]);
  });

  it("keeps at most 10 results, and skips one with no title or with an address that web_fetch would not open", async () => {
    const good = Array.from({ length: 11 }, (_, index) => result(`Result ${index + 1}`, `https://a.example/${index + 1}`));
    const { fetch } = fakeFetch(() =>
      json(
        answer([
          { title: "No address" },
          { title: 7, url: "https://a.example/number" },
          result("", "https://a.example/untitled"),
          { ...result("A script", "https://a.example/"), url: "javascript:alert(1)" },
          { ...result("A login", "https://a.example/"), url: "https://user:secret@a.example/" },
          { ...result("A long address", "https://a.example/"), url: `https://a.example/${"x".repeat(2048)}` },
          ...good,
        ]),
      ),
    );
    const { outcome, output } = await search(fetch);
    expect(outcome).toBe("ok");
    expect(output.match(/^\d+\. .*$/gm)).toEqual(Array.from({ length: 10 }, (_, index) => `${index + 1}. Result ${index + 1}`));
    expect(output).not.toMatch(/javascript|secret|untitled|xxxx/);
  });

  it("says which engines failed when nothing came back, and where the bot can look instead", async () => {
    const { fetch } = fakeFetch(() => json(answer([], [["duckduckgo", "CAPTCHA"], ["brave", "too many requests"]])));
    expect(await search(fetch)).toEqual({
      outcome: "error",
      output: `web_search found no results for "sqlite wal mode". These search engines failed: duckduckgo (CAPTCHA), brave (too many requests). To see a results page, ${ELSEWHERE}.`,
      truncated: false,
    });
  });

  it("says that it found nothing when every engine answered with no results", async () => {
    const { fetch } = fakeFetch(() => json(answer([result("", "https://a.example/")])));
    expect(await search(fetch)).toEqual({
      outcome: "error",
      output: `web_search found no results for "sqlite wal mode". To see a results page, ${ELSEWHERE}.`,
      truncated: false,
    });
  });

  it.each([
    [
      "is not running",
      () => Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8789"), { code: "ECONNREFUSED" }) })),
      "did not answer (ECONNREFUSED)",
    ],
    ["is at a port that fetch refuses", () => Promise.reject(new TypeError("fetch failed", { cause: new Error("bad port") })), "did not answer (bad port)"],
    ["answers with an error", () => new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" }), "answered 502 Bad Gateway"],
    ["answers with a page", () => new Response("<html>Too many requests</html>", { status: 200, headers: { "content-type": "text/html" } }), "answered with text that is not JSON"],
    ["answers with JSON of another shape", () => json({ results: "none" }), "answered with JSON of another shape"],
  ])("says that search is unavailable when SearXNG %s", async (_label, respond, why) => {
    const { fetch } = fakeFetch(respond);
    expect(await search(fetch)).toEqual({
      outcome: "error",
      output: `web_search is unavailable just now, because SearXNG ${why}. To search anyway, ${ELSEWHERE}.`,
      truncated: false,
    });
  });

  it("stops when the run is cancelled, before and during the search", async () => {
    const before = new AbortController();
    before.abort();
    const { fetch, requested } = fakeFetch(() => json(answer([])));
    expect(await search(fetch, before.signal)).toMatchObject({ outcome: "cancelled" });
    expect(requested).toEqual([]);

    const during = new AbortController();
    const pending = search(hanging, during.signal);
    during.abort();
    expect(await pending).toEqual({ outcome: "cancelled", output: "The call was cancelled.", truncated: false });
  });

  it("gives up after 15 seconds", async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = search(hanging).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ outcome: "timeout", output: "SearXNG took longer than 15 seconds.", truncated: false });
  });

  it("keeps every output under the output cap", async () => {
    const wide = (index: number) => result("標".repeat(300), `https://a.example/${"%E6%A8%99".repeat(220)}${index}`, "語".repeat(500));
    const { fetch } = fakeFetch(() => json(answer(Array.from({ length: 10 }, (_, index) => wide(index)))));
    const { outcome, output, truncated } = await search(fetch);
    expect(outcome).toBe("ok");
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(OUTPUT_CAP_BYTES);
  });
});
