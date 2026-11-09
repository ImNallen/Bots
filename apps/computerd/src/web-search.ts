// How web_search reads Bing's results page. Bing is the one results page that answered a plain request with results from the
// computerd container on 2026-11-09: Brave answered 429, DuckDuckGo a 202 block page, and Google, Startpage, Mojeek, Qwant, Yandex,
// and Ecosia no results or 403. Pure, so it is tested from a hand-written page shaped like Bing's.
import { DomUtils, parseDocument } from "htmlparser2";
import { webUrl, type ToolResult } from "@bots/protocol";
import type { Fetched } from "./web-page.ts";

type SearchResult = { title: string; url: string; snippet: string };
type Element = ReturnType<typeof DomUtils.findAll>[number];

const MAX_TITLE = 300;
const MAX_SNIPPET = 500;
const MAX_ADDRESS = 2048;

// Without a market, Bing answered a request from the home connection with results for the first word of the query alone, such as
// SQLite's home page for "sqlite wal mode". With mkt=en-US it answered with results for the whole query.
export function searchUrl(query: string): string {
  return `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=en-US`;
}

/** The results in Bing's order, or an error that says how to see the page itself when none could be read. */
export function showSearch(query: string, fetched: Fetched): ToolResult {
  const results = fetched.status < 400 ? bingResults(fetched.body.toString("utf8")) : [];
  if (results.length === 0) {
    const answered = fetched.status < 400 ? "" : ` Bing answered ${`${fetched.status} ${fetched.statusText}`.trimEnd()}.`;
    return {
      outcome: "error",
      output: `web_search found no results that it could read.${answered} To see the results page, open ${searchUrl(query)} with browser_navigate.`,
      truncated: false,
    };
  }
  const lines = results.flatMap((result, index) => [
    "",
    `${index + 1}. ${result.title}`,
    `   ${result.url}`,
    ...(result.snippet === "" ? [] : [`   ${result.snippet}`]),
  ]);
  return { outcome: "ok", output: [`Results from Bing for ${JSON.stringify(query)}:`, ...lines].join("\n"), truncated: false };
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
const hasClass = (element: Element, name: string) => (DomUtils.getAttributeValue(element, "class") ?? "").split(/\s+/).includes(name);
const isBing = (url: URL) => url.hostname === "bing.com" || url.hostname.endsWith(".bing.com");

// Each result is an li.b_algo. Its title links through https://www.bing.com/ck/a, which answers with a JavaScript redirect that a
// plain fetch cannot follow, so the real address comes from the link's u parameter: "a1" and then the address in base64url.
function bingResults(html: string): SearchResult[] {
  const items = DomUtils.findAll((element) => element.name === "li" && hasClass(element, "b_algo"), parseDocument(html).children);
  return items.flatMap((item) => {
    const heading = DomUtils.findOne((element) => element.name === "h2", item.children);
    const anchor = heading === null ? null : DomUtils.findOne((element) => element.name === "a" && DomUtils.hasAttrib(element, "href"), heading.children);
    if (heading === null || anchor === null) {
      return [];
    }
    const cite = DomUtils.findOne((element) => element.name === "cite", item.children);
    const url = addressOf(DomUtils.getAttributeValue(anchor, "href") ?? "", cite === null ? "" : collapse(DomUtils.textContent(cite)));
    const title = collapse(DomUtils.textContent(anchor)).slice(0, MAX_TITLE);
    if (url === null || title === "") {
      return [];
    }
    return [{ title, url, snippet: snippetOf(item, heading).slice(0, MAX_SNIPPET) }];
  });
}

function addressOf(href: string, cite: string): string | null {
  const link = URL.parse(href, "https://www.bing.com/");
  const encoded = link !== null && isBing(link) && link.pathname === "/ck/a" ? link.searchParams.get("u") : null;
  const decoded = encoded?.startsWith("a1") === true ? webUrl(Buffer.from(encoded.slice(2), "base64url").toString("utf8")) : null;
  const direct = link !== null && !isBing(link) ? webUrl(link.href) : null;
  // A cite is often shortened, as in "https://sqlite.org › wal.html", so only a whole address stands in for the link.
  const whole = /^\S+$/.test(cite) ? webUrl(cite) : null;
  const address = (decoded ?? direct ?? whole)?.href ?? null;
  return address !== null && address.length <= MAX_ADDRESS ? address : null;
}

// The snippet is the caption's paragraph, or else everything in the result but its title and the site's name and address. The
// title and the address are read before this, so removing them from this call's own tree loses nothing.
function snippetOf(item: Element, heading: Element): string {
  const caption = DomUtils.findOne((element) => hasClass(element, "b_caption"), item.children);
  const paragraph = caption === null ? null : DomUtils.findOne((element) => element.name === "p", caption.children);
  if (paragraph !== null) {
    return collapse(DomUtils.textContent(paragraph));
  }
  for (const element of DomUtils.findAll((element) => element === heading || hasClass(element, "b_tpcn") || element.name === "cite", item.children)) {
    DomUtils.removeElement(element);
  }
  return collapse(DomUtils.textContent(item));
}
