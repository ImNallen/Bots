// web_search asks the SearXNG beside this orchestrator. SearXNG asks other engines from this machine's address and says which of them
// failed, so one engine that blocks the address no longer breaks a search.
import { capText, webUrl, type ToolResult } from "@bots/protocol";
import { z } from "zod";

const MAX_RESULTS = 10;
const MAX_TITLE = 300;
const MAX_SNIPPET = 500;
const MAX_ADDRESS = 2048;
// SearXNG stops waiting for each engine by itself, so a search this slow means SearXNG is stuck. A setTimeout, not AbortSignal.timeout,
// so that vitest's fake timers drive it.
const DEADLINE_MS = 15_000;

// Only what web_search reads. A result that lacks a field is skipped, and the rest of the search still reads.
const searxngAnswer = z.object({
  results: z.array(z.unknown()),
  unresponsive_engines: z.array(z.tuple([z.string(), z.string()])),
});
const searxngResult = z.object({ title: z.string(), url: z.string(), content: z.string().nullish() });

type SearchResult = { title: string; url: string; snippet: string };

export type Search = (args: { query: string; signal: AbortSignal }) => Promise<ToolResult>;

/** The only I/O, so a test replaces it and needs no SearXNG. */
export type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

function readable(raw: unknown): SearchResult | null {
  const parsed = searxngResult.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const url = webUrl(parsed.data.url)?.href;
  const title = collapse(parsed.data.title).slice(0, MAX_TITLE);
  if (url === undefined || url.length > MAX_ADDRESS || title === "") {
    return null;
  }
  return { title, url, snippet: collapse(parsed.data.content ?? "").slice(0, MAX_SNIPPET) };
}

function elsewhere(query: string): string {
  const q = encodeURIComponent(query);
  return `open https://duckduckgo.com/?q=${q} or https://www.bing.com/search?q=${q} with browser_navigate`;
}

function unavailable(query: string, why: string): ToolResult {
  return { outcome: "error", output: `web_search is unavailable just now, because SearXNG ${why}. To search anyway, ${elsewhere(query)}.`, truncated: false };
}

function show(query: string, answer: z.infer<typeof searxngAnswer>): ToolResult {
  const results = answer.results.flatMap((raw) => readable(raw) ?? []).slice(0, MAX_RESULTS);
  if (results.length === 0) {
    const failed = answer.unresponsive_engines.map(([engine, reason]) => `${engine} (${reason})`).join(", ");
    const engines = failed === "" ? "" : ` These search engines failed: ${failed}.`;
    return { outcome: "error", output: `web_search found no results for ${JSON.stringify(query)}.${engines} To see a results page, ${elsewhere(query)}.`, truncated: false };
  }
  const lines = results.flatMap((result, index) => [
    "",
    `${index + 1}. ${result.title}`,
    `   ${result.url}`,
    ...(result.snippet === "" ? [] : [`   ${result.snippet}`]),
  ]);
  const capped = capText([`Results for ${JSON.stringify(query)}:`, ...lines].join("\n"));
  return { outcome: "ok", output: capped.output, truncated: capped.truncated };
}

function reasonOf(error: unknown): string {
  if (error instanceof SyntaxError) {
    return "answered with text that is not JSON";
  }
  // fetch rejects with "fetch failed" and puts what happened in its cause.
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const code = cause instanceof Error && "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
  return `did not answer (${code ?? (cause instanceof Error ? cause.message : String(cause))})`;
}

/** Never rejects. Every failure is a tool result. */
export function createSearch(args: { url: string; fetch: Fetch }): Search {
  const { url, fetch } = args;
  return async ({ query, signal }) => {
    if (signal.aborted) {
      return { outcome: "cancelled", output: "The call was cancelled before it started.", truncated: false };
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), DEADLINE_MS);
    try {
      const response = await fetch(`${url}/search?${new URLSearchParams({ q: query, format: "json" })}`, {
        signal: AbortSignal.any([signal, deadline.signal]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return unavailable(query, `answered ${`${response.status} ${response.statusText}`.trimEnd()}`);
      }
      const answer = searxngAnswer.safeParse(await response.json());
      return answer.success ? show(query, answer.data) : unavailable(query, "answered with JSON of another shape");
    } catch (error) {
      if (signal.aborted) {
        return { outcome: "cancelled", output: "The call was cancelled.", truncated: false };
      }
      if (deadline.signal.aborted) {
        return { outcome: "timeout", output: `SearXNG took longer than ${DEADLINE_MS / 1000} seconds.`, truncated: false };
      }
      return unavailable(query, reasonOf(error));
    } finally {
      clearTimeout(timer);
    }
  };
}
