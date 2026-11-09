import { OUTPUT_CAP_BYTES } from "@bots/protocol";
import { describe, expect, it } from "vitest";
import { PART_BYTES, showPage, type Fetched } from "./web-page.ts";

const URL_OF_PAGE = "https://site.example/blog/post";

function fetched(body: string | Buffer, overrides: Partial<Fetched> = {}): Fetched {
  return {
    requested: URL_OF_PAGE,
    url: URL_OF_PAGE,
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    body: typeof body === "string" ? Buffer.from(body) : body,
    cut: false,
    ...overrides,
  };
}

const read = (body: string | Buffer, overrides: Partial<Fetched> = {}, start = 0) => showPage(fetched(body, overrides), start);
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("what an HTML page reads as", () => {
  it("leaves out what a reader never sees, and keeps the title", () => {
    const html = `<!doctype html><html><head><title>A  page
      title</title><style>p { color: red }</style><script>var secret = 1;</script></head><body>
      <nav><a href="/home">Home</a></nav>
      <div role="navigation">Menu</div>
      <noscript>Turn on JavaScript</noscript>
      <template><p>template text</p></template>
      <svg><title>svg title</title><text>svg text</text></svg>
      <p hidden>hidden text</p>
      <div aria-hidden="true">aria hidden text</div>
      <span style="display: none">display none text</span>
      <div style="color: blue; visibility:hidden">invisible text</div>
      <dialog>closed dialog text</dialog>
      <dialog open>open dialog text</dialog>
      <p>Visible text</p>
    </body></html>`;
    expect(read(html)).toEqual({ outcome: "ok", output: "Title: A page title\n\nopen dialog text\n\nVisible text", truncated: false });
  });

  it("writes headings, nested lists, table rows, line breaks, and preformatted text as Markdown", () => {
    const html = `<h1>Main</h1><p>Intro   text
      spanning lines.</p><h2>Part</h2><ul><li>One</li><li>Two<ul><li>Two point one</li></ul></li></ul>
      <table><tr><th>Name</th><th>Age</th></tr><tr><td>Ada</td><td>36</td></tr></table>
      <p>Line one<br>Line two</p><pre>
  indented
    code
</pre><div><div><p>after</p></div></div><p></p><p></p><p>end</p>`;
    expect(read(html).output).toBe(
      [
        "# Main",
        "",
        "Intro text spanning lines.",
        "",
        "## Part",
        "",
        "- One",
        "- Two",
        "  - Two point one",
        "",
        "Name | Age",
        "Ada | 36",
        "",
        "Line one",
        "Line two",
        "",
        "  indented",
        "    code",
        "",
        "after",
        "",
        "end",
      ].join("\n"),
    );
  });

  it("writes each link as [text][n] and lists its absolute address once, so two links to one address share a number", () => {
    const html = `<p>Read <a href="../about">about us</a>, then <a href="https://other.example/x?y=1">the other site</a>.</p>
      <p>Again: <a href="/about">About</a>.</p>`;
    expect(read(html).output).toBe(
      [
        "Read [about us][1], then [the other site][2].",
        "",
        "Again: [About][1].",
        "",
        "[1]: https://site.example/about",
        "[2]: https://other.example/x?y=1",
      ].join("\n"),
    );
  });

  it("resolves links against the page's base href", () => {
    const html = `<head><base href="https://cdn.example/docs/"></head><p><a href="guide.html">Guide</a></p>`;
    expect(read(html).output).toBe("[Guide][1]\n\n[1]: https://cdn.example/docs/guide.html");
  });

  it("numbers only links it can open, drops same-page links and links with no text, and uses an image's alt", () => {
    const html = `<p><a href="mailto:a@b.example">Mail us</a> or <a href="javascript:go()">go</a>.</p>
      <p><a href="#section">Jump</a><a href="${URL_OF_PAGE}#top">Top</a><a href="https://x.example/"></a><a href="https://user:pw@x.example/">Login</a></p>
      <p><a href="https://img.example/"><img src="a.png" alt="A picture"></a> and <a href="https://b.example/">[bracketed]</a></p>`;
    expect(read(html).output).toBe(
      ["Mail us or go.", "", "Login", "", "[A picture][1] and [(bracketed)][2]", "", "[1]: https://img.example/", "[2]: https://b.example/"].join("\n"),
    );
  });

  it("decodes named and numeric entities", () => {
    expect(read("<p>&amp; &lt; &copy; &#x1F600; &#8212; &hellip; &nbsp;x</p>").output).toBe("& < © 😀 — … x");
  });
});

describe("how a page's bytes become text", () => {
  const latin1 = Buffer.from("<p>café</p>", "latin1");

  it("takes the charset from a byte order mark over the header", () => {
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<p>café</p>")]);
    expect(read(body, { contentType: "text/html; charset=iso-8859-1" }).output).toBe("café");
  });

  it("takes the charset from the header", () => {
    expect(read(latin1, { contentType: "text/html; charset=ISO-8859-1" }).output).toBe("café");
  });

  it("takes the charset from a meta tag when the header has none", () => {
    expect(read(Buffer.concat([Buffer.from('<meta charset="windows-1252">'), latin1]), { contentType: "text/html" }).output).toBe("café");
    const equiv = Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">'), latin1]);
    expect(read(equiv, { contentType: "text/html" }).output).toBe("café");
  });

  it("reads UTF-8 when it does not know the label", () => {
    expect(read("<p>café</p>", { contentType: "text/html; charset=x-unknown" }).output).toBe("café");
  });

  it("passes plain text, JSON, and RSS through as they are, and names their type", () => {
    expect(read("line one\r\nline two\n", { contentType: "text/plain" }).output).toBe("Type: text/plain\n\nline one\nline two\n");
    const json = '{\n  "a": [1, 2]\n}';
    expect(read(json, { contentType: "application/json" }).output).toBe(`Type: application/json\n\n${json}`);
    const rss = '<?xml version="1.0"?><rss><channel><item><title>News</title><link>https://n.example/1</link></item></channel></rss>';
    expect(read(rss, { contentType: "application/rss+xml; charset=utf-8" })).toEqual({ outcome: "ok", output: `Type: application/rss+xml\n\n${rss}`, truncated: false });
  });

  it("refuses a PDF and a picture with their type and size", () => {
    expect(read(Buffer.alloc(Math.round(2.1 * 1024 * 1024)), { contentType: "application/pdf" })).toEqual({
      outcome: "error",
      output: "This is application/pdf, 2.1 MB, which web_fetch cannot read.",
      truncated: false,
    });
    expect(read(Buffer.alloc(3000), { contentType: "image/png" }).output).toBe("This is image/png, 3 KB, which web_fetch cannot read.");
  });

  it("decides from the body when there is no Content-Type", () => {
    expect(read("  <!DOCTYPE html><title>Sniffed</title><p>hi</p>", { contentType: undefined }).output).toBe("Title: Sniffed\n\nhi");
    expect(read("just words", { contentType: undefined }).output).toBe("Type: text/plain\n\njust words");
    expect(read(Buffer.from([0x25, 0x50, 0x00, 0xff, 0x10]), { contentType: undefined }).output).toBe(
      "This is application/octet-stream, 5 bytes, which web_fetch cannot read.",
    );
  });
});

describe("what a page's header says", () => {
  it("reports a 404 or a 429 as an error that still shows the page's text and its status", () => {
    expect(read("<title>Not here</title><p>Sorry, nothing at this address.</p>", { status: 404, statusText: "Not Found" })).toEqual({
      outcome: "error",
      output: "Title: Not here\nStatus: 404 Not Found\n\nSorry, nothing at this address.",
      truncated: false,
    });
    expect(read("<p>Slow down.</p>", { status: 429, statusText: "Too Many Requests" })).toMatchObject({ outcome: "error", output: "Status: 429 Too Many Requests\n\nSlow down." });
  });

  it("names where a redirect led, says when the page was cut, and says when it has no text", () => {
    expect(read("<p>x</p>", { url: "https://site.example/moved" }).output).toBe("Redirected to: https://site.example/moved\n\nx");
    expect(read("<p>x</p>", { cut: true })).toEqual({ outcome: "ok", output: "The page was too large, so only its start was read.\n\nx", truncated: true });
    expect(read("<script>render()</script>")).toEqual({ outcome: "ok", output: "The page has no text that web_fetch can read.", truncated: false });
  });
});

describe("a long page", () => {
  const paragraphs = Array.from({ length: 400 }, (_, index) => ({
    html: `<p>Paragraph ${index} has some words in it, and it links to <a href="https://site.example/p/${index % 50}">page ${index % 50}</a> for more.</p>`,
    text: `Paragraph ${index} has some words in it, and it links to [page ${index % 50}][${(index % 50) + 1}] for more.`,
  }));
  const whole = paragraphs.map((paragraph) => paragraph.text).join("\n\n");
  const html = paragraphs.map((paragraph) => paragraph.html).join("");

  function partsOf(source: string): { text: string; links: Map<number, string>; output: string }[] {
    const parts = [];
    let start: number | null = 0;
    while (start !== null) {
      const { output } = read(source, {}, start);
      const footer = /\n\nThis part is characters (\d+) to (\d+) of (\d+)\. For the next part, call web_fetch with the same url and start (\d+)\.$/.exec(output);
      const body = footer === null ? output : output.slice(0, footer.index);
      const listed = /\n\n((?:\[\d+\]: \S+\n?)+)$/.exec(body);
      const links = new Map((listed?.[1] ?? "").trim().split("\n").filter(Boolean).map((line) => {
        const [, number, address] = /^\[(\d+)\]: (\S+)$/.exec(line) ?? [];
        return [Number(number), address ?? ""] as const;
      }));
      parts.push({ text: listed === null ? body : body.slice(0, listed.index), links, output });
      start = footer === null ? null : Number(footer[4]);
    }
    return parts;
  }

  it("comes in parts that rebuild the whole text, each under PART_BYTES and listing exactly the links it cites, numbered the same in every part", () => {
    const parts = partsOf(html);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.map((part) => part.text).join("")).toBe(whole);
    for (const part of parts) {
      const cited = new Set([...part.text.matchAll(/\]\[(\d+)\]/g)].map((match) => Number(match[1])));
      expect([...part.links.keys()].sort((a, b) => a - b)).toEqual([...cited].sort((a, b) => a - b));
      for (const [number, address] of part.links) {
        expect(address).toBe(`https://site.example/p/${number - 1}`);
      }
      const listed = [...part.links].map(([number, address]) => `[${number}]: ${address}`).join("\n");
      expect(bytes(part.text) + bytes(listed)).toBeLessThanOrEqual(PART_BYTES);
      expect(bytes(part.output)).toBeLessThanOrEqual(OUTPUT_CAP_BYTES);
    }
    expect(read(html)).toMatchObject({ truncated: true });
    expect(read(html, {}, whole.length - 10)).toMatchObject({ truncated: false });
  });

  it("never starts a part inside a link marker", () => {
    const marker = whole.indexOf("[page 7][8]", 2000);
    const { output } = read(html, {}, marker + 4);
    expect(output.startsWith("[page 7][8] for more.")).toBe(true);
    expect(output).toContain(`This part is characters ${marker} to `);
  });

  it("says when a start is past the end", () => {
    expect(read(html, {}, whole.length + 5)).toEqual({
      outcome: "ok",
      output: `This page has ${whole.length} characters, so a part cannot start at ${whole.length + 5}.`,
      truncated: false,
    });
  });

  it("keeps a page of wide characters under the output cap", () => {
    const { output, truncated } = read(`<p>${"漢字かな交じり文".repeat(5000)}</p>`);
    expect(truncated).toBe(true);
    expect(bytes(output)).toBeLessThanOrEqual(OUTPUT_CAP_BYTES);
    expect(output).toMatch(/This part is characters 0 to \d+ of 40000\./);
  });

  it("reads a page of 250,000 tiny elements in a few seconds at most, because a page cannot hold computerd's event loop", { timeout: 60_000 }, () => {
    const started = performance.now();
    const { outcome, output } = read(`<p>${"<span>x</span><br>".repeat(250_000)}</p>`);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(outcome).toBe("ok");
    expect(output).toMatch(/^x\nx\nx\n/);
  });
});
