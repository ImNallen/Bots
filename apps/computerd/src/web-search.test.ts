import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { Fetched } from "./web-page.ts";
import { searchUrl, showSearch } from "./web-search.ts";

const fixture = await readFile(new URL("./fixtures/web/bing-results.html", import.meta.url));

function page(body: string | Buffer, overrides: Partial<Fetched> = {}): Fetched {
  const url = searchUrl("sqlite wal mode");
  return { requested: url, url, status: 200, statusText: "OK", contentType: "text/html; charset=utf-8", body: Buffer.from(body), cut: false, ...overrides };
}

describe("web_search's results", () => {
  it("reads Bing's results in order, each as a title, its real address, and a snippet", () => {
    expect(showSearch("sqlite wal mode", page(fixture))).toEqual({
      outcome: "ok",
      output: [
        'Results from Bing for "sqlite wal mode":',
        "",
        "1. Write-Ahead Logging - SQLite",
        "   https://www.sqlite.org/wal.html",
        "   Aug 25, 2026 · The default method by which SQLite implements atomic commit and rollback is a rollback journal. Beginning with version 3.7.0, a new WAL option is available …",
        "",
        "2. A guide to WAL & checkpoints",
        "   https://example.org/guide?topic=wal&lang=en",
        "   Checkpoints move pages from the WAL file back into the database.",
        "",
        "3. Café au lait - Wiki",
        "   https://wiki.example/Caf%C3%A9_au_lait",
        "   A result whose caption has no paragraph, only this text.",
        "",
        "4. A link that decodes to a script, with a whole address in its cite",
        "   https://only-in-cite.example/page",
        "   Its cite stands in for the link.",
        "",
        "5. A result that links straight to its page",
        "   https://direct.example/a?b=c",
        "   Bing sometimes links a result directly.",
      ].join("\n"),
      truncated: false,
    });
  });

  it("asks Bing for the whole query in one market", () => {
    expect(searchUrl("rust & tokio: select!")).toBe("https://www.bing.com/search?q=rust%20%26%20tokio%3A%20select!&mkt=en-US");
  });

  it.each([
    ["a page with no results", page('<ol id="b_results"><li class="b_no"><h1>There are no results for sqlite wal mode</h1></li></ol>'), ""],
    ["a block page", page("<title>Slow down</title><p>Too many requests.</p>", { status: 429, statusText: "Too Many Requests" }), " Bing answered 429 Too Many Requests."],
    ["a page whose results changed their markup", page('<div class="result"><h2><a href="https://a.example/">A</a></h2></div>'), ""],
  ])("says that it found nothing it could read on %s, and how to see the page itself", (_label, fetched, answered) => {
    expect(showSearch("sqlite wal mode", fetched)).toEqual({
      outcome: "error",
      output: `web_search found no results that it could read.${answered} To see the results page, open https://www.bing.com/search?q=sqlite%20wal%20mode&mkt=en-US with browser_navigate.`,
      truncated: false,
    });
  });
});
