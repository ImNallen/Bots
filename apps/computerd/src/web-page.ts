// How a fetched document reads to the model. Pure, so every rule here is tested from a string with no network.
//
// The text is Markdown with reference-style links: a link reads [text][n], and the part lists each [n]: address it cites once,
// after the text. A model reads that well, and a long address appears once however often the page links to it.
import { Parser } from "htmlparser2";
import { webUrl, type ToolResult } from "@bots/protocol";

export type Fetched = {
  /** The URL the model asked for, normalized. */
  requested: string;
  /** Where the page came from after redirects. It is the base for relative links. */
  url: string;
  status: number;
  statusText: string;
  contentType: string | undefined;
  body: Buffer;
  /** The body was longer than web.ts reads, and the rest was never read. */
  cut: boolean;
};

/** One part's text plus the lines that list its links, in UTF-8 bytes. Every part replays on every later model call. */
export const PART_BYTES = 16 * 1024;

const MAX_TITLE = 300;
const MAX_LINK_TEXT = 300;
const MAX_LINK_ADDRESS = 2048;

/**
 * Classifies, decodes, extracts, and renders one part. outcome is error for a status of 400 or more, still with the page's text,
 * because a block page or a 404 page says why, and for a type it cannot read.
 */
export function showPage(fetched: Fetched, start: number): ToolResult {
  const reading = classify(fetched.contentType, fetched.body);
  if (reading.kind === "unreadable") {
    return { outcome: "error", output: `This is ${reading.mediaType}, ${sizeOf(fetched)}, which web_fetch cannot read.`, truncated: false };
  }
  const text = decode(fetched.body, reading.charset, reading.kind === "html");
  const page = reading.kind === "html" ? htmlPage(text, fetched.url) : textPage(text);
  const part = renderPart(page, start);
  const header = headerLines(fetched, page, reading);
  const output = [...header, ...(header.length > 0 && part.lines.length > 0 ? [""] : []), ...part.lines].join("\n");
  return { outcome: fetched.status >= 400 ? "error" : "ok", output, truncated: part.next !== null || fetched.cut };
}

/** A cut can never fall inside a link marker, because a marker is one piece. Offsets count UTF-16 code units over the pieces. */
type Piece = { kind: "text"; text: string } | { kind: "link"; text: string; link: number };

type Page = {
  title: string | null;
  pieces: readonly Piece[];
  /** links[n - 1] is the address of [n], numbered by first appearance in the whole page, so a number holds across parts. */
  links: readonly string[];
  length: number;
};

type Reading =
  | { kind: "html"; charset: string | undefined }
  | { kind: "text"; mediaType: string; charset: string | undefined }
  | { kind: "unreadable"; mediaType: string };

function classify(contentType: string | undefined, body: Buffer): Reading {
  const [rawType = "", ...params] = (contentType ?? "").split(";");
  const mediaType = rawType.trim().toLowerCase();
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(params.join(";"))?.[1];
  if (mediaType === "") {
    return sniff(body);
  }
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
    return { kind: "html", charset };
  }
  const json = mediaType === "application/json" || mediaType.endsWith("+json");
  const xml = mediaType === "application/xml" || mediaType.endsWith("+xml");
  return mediaType.startsWith("text/") || json || xml ? { kind: "text", mediaType, charset } : { kind: "unreadable", mediaType };
}

function sniff(body: Buffer): Reading {
  const head = body.subarray(0, 1024);
  const opening = head.toString("latin1").replace(/^(ï»¿|þÿ|ÿþ)/, "").trimStart().slice(0, 15).toLowerCase();
  if (/^<(!doctype html|html|head|body)\b/.test(opening)) {
    return { kind: "html", charset: undefined };
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
  } catch {
    return { kind: "unreadable", mediaType: "application/octet-stream" };
  }
  return head.includes(0) ? { kind: "unreadable", mediaType: "application/octet-stream" } : { kind: "text", mediaType: "text/plain", charset: undefined };
}

// Garbled text still beats no text, so a label that TextDecoder does not know falls back to UTF-8.
function decode(body: Buffer, charset: string | undefined, html: boolean): string {
  const label = bomCharset(body) ?? charset ?? (html ? metaCharset(body) : undefined) ?? "utf-8";
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

function bomCharset(body: Buffer): string | undefined {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    return "utf-8";
  }
  if (body[0] === 0xfe && body[1] === 0xff) {
    return "utf-16be";
  }
  return body[0] === 0xff && body[1] === 0xfe ? "utf-16le" : undefined;
}

// Both <meta charset="x"> and <meta http-equiv="Content-Type" content="text/html; charset=x">.
function metaCharset(body: Buffer): string | undefined {
  return /<meta[^>]*?charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(body.subarray(0, 1024).toString("latin1"))?.[1];
}

const SKIPPED = new Set([
  "script", "style", "noscript", "template", "svg", "math", "iframe", "object", "embed", "canvas", "select", "button", "textarea", "nav",
]);

// Elements that start and end a line. BLANK_AROUND also leave a blank line around them.
const BLOCKS = new Set([
  "address", "article", "aside", "blockquote", "caption", "dd", "details", "dialog", "div", "dl", "dt", "fieldset", "figcaption",
  "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "ol", "p", "pre", "section", "summary",
  "table", "tbody", "tfoot", "thead", "tr", "ul",
]);
const BLANK_AROUND = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "table", "ul", "ol", "dl", "hr"]);

function isHidden(name: string, attribs: Record<string, string>): boolean {
  return (
    attribs.hidden !== undefined ||
    attribs["aria-hidden"]?.toLowerCase() === "true" ||
    attribs.role?.toLowerCase() === "navigation" ||
    /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attribs.style ?? "") ||
    (name === "dialog" && attribs.open === undefined)
  );
}

/** Builds the run of pieces, owing line breaks, spaces, and a line's prefix until real text arrives, so nothing trails or doubles. */
function createWriter() {
  const pieces: Piece[] = [];
  let started = false;
  let owedBreaks = 0;
  let owedSpace = false;
  let prefix: string | null = null;
  let separator: string | null = null;

  function push(piece: Piece): void {
    const last = pieces.at(-1);
    if (piece.kind === "text" && last?.kind === "text") {
      last.text += piece.text;
    } else {
      pieces.push(piece);
    }
  }

  function lead(): string {
    const last = pieces.at(-1);
    const ended = last?.kind === "text" ? (/\n*$/.exec(last.text)?.[0].length ?? 0) : 0;
    const breaks = "\n".repeat(Math.max(0, owedBreaks - ended));
    const gap = !started ? "" : owedBreaks > 0 ? breaks : (separator ?? (owedSpace ? " " : ""));
    const text = gap + (prefix ?? "");
    started = true;
    owedBreaks = 0;
    owedSpace = false;
    prefix = null;
    separator = null;
    return text;
  }

  return {
    text(raw: string): void {
      const collapsed = raw.replace(/\s+/g, " ");
      const words = collapsed.trim();
      owedSpace ||= collapsed.startsWith(" ");
      if (words !== "") {
        push({ kind: "text", text: lead() + words });
        owedSpace = collapsed.endsWith(" ");
      }
    },
    pre(raw: string): void {
      if (raw !== "") {
        push({ kind: "text", text: lead() + raw.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n") });
      }
    },
    link(text: string, link: number): void {
      const gap = lead();
      if (gap !== "") {
        push({ kind: "text", text: gap });
      }
      push({ kind: "link", text, link });
    },
    space(): void {
      owedSpace = true;
    },
    // A heading or a list item owes its own break, so a block inside it before any text adds none.
    block(breaks: number): void {
      if (prefix === null) {
        owedBreaks = Math.max(owedBreaks, breaks);
      }
    },
    lineBreak(): void {
      if (started) {
        owedBreaks = Math.min(2, owedBreaks + 1);
      }
    },
    prefix(text: string | null): void {
      prefix = text;
    },
    separator(text: string): void {
      separator = text;
    },
    pieces: (): Piece[] => pieces,
  };
}

type Anchor = { depth: number; href: string; text: string; alt: string };

/**
 * One pass of htmlparser2's Parser over the decoded string. htmlparser2 owns the tokenizer, raw-text elements, and the entity table,
 * and it closes every element it opens, implied or void, so a stack of open elements stays in step with it.
 */
function htmlPage(html: string, url: string): Page {
  const out = createWriter();
  const page = URL.parse(url);
  const links: string[] = [];
  const numbers = new Map<string, number>();
  const open: { name: string; skipped: boolean }[] = [];
  const rows: { cells: number }[] = [];
  let skipped = 0;
  let lists = 0;
  let pre = 0;
  let preStarts = false;
  let base = url;
  let sawBase = false;
  let title: string | null = null;
  let titleText: string | null = null;
  let anchor: Anchor | null = null;

  function count(name: string, step: 1 | -1): void {
    if (name === "ul" || name === "ol") {
      lists += step;
    } else if (name === "tr") {
      if (step === 1) {
        rows.push({ cells: 0 });
      } else {
        rows.pop();
      }
    } else if (name === "pre") {
      pre += step;
      preStarts = step === 1;
    }
  }

  function layout(name: string, edge: "open" | "close"): void {
    if (name === "br") {
      if (edge === "open") {
        out.lineBreak();
      }
    } else if (/^h[1-6]$/.test(name) || name === "li") {
      if (edge === "close") {
        out.prefix(null);
      }
      out.block(name === "li" ? 1 : 2);
      if (edge === "open") {
        out.prefix(name === "li" ? `${"  ".repeat(Math.max(0, lists - 1))}- ` : `${"#".repeat(Number(name[1]))} `);
      }
    } else if (name === "ul" || name === "ol") {
      out.block((edge === "open" ? lists === 1 : lists === 0) ? 2 : 1);
    } else if ((name === "td" || name === "th") && edge === "open") {
      const row = rows.at(-1);
      if (row !== undefined && row.cells > 0) {
        out.separator(" | ");
      }
      if (row !== undefined) {
        row.cells += 1;
      }
    } else if (BLOCKS.has(name)) {
      out.block(BLANK_AROUND.has(name) ? 2 : 1);
    }
  }

  function endAnchor(ended: Anchor): void {
    const words = (ended.text.replace(/\s+/g, " ").trim() || ended.alt.replace(/\s+/g, " ").trim()).slice(0, MAX_LINK_TEXT);
    const address = webUrl(ended.href.trim(), base);
    if (words === "" || (address !== null && address.hash !== "" && page !== null && withoutHash(address) === withoutHash(page))) {
      return;
    }
    if (/^\s/.test(ended.text)) {
      out.space();
    }
    if (address === null || address.href.length > MAX_LINK_ADDRESS) {
      out.text(words);
    } else {
      const number = numbers.get(address.href) ?? links.push(address.href);
      numbers.set(address.href, number);
      out.link(`[${words.replaceAll("[", "(").replaceAll("]", ")")}][${number}]`, number);
    }
    if (/\s$/.test(ended.text)) {
      out.space();
    }
  }

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const skip = skipped > 0 || SKIPPED.has(name) || isHidden(name, attribs);
        open.push({ name, skipped: skip });
        if (skip) {
          skipped += 1;
          return;
        }
        count(name, 1);
        if (name === "title" && title === null && titleText === null) {
          titleText = "";
        } else if (name === "base" && !sawBase && attribs.href !== undefined) {
          sawBase = true;
          base = URL.parse(attribs.href, url)?.href ?? url;
        } else if (anchor !== null) {
          if (name === "img" && anchor.alt === "") {
            anchor.alt = attribs.alt ?? "";
          }
        } else if (name === "a" && attribs.href !== undefined) {
          anchor = { depth: open.length, href: attribs.href, text: "", alt: "" };
        } else {
          layout(name, "open");
        }
      },
      ontext(text) {
        if (skipped > 0) {
          return;
        }
        if (titleText !== null) {
          titleText += text;
        } else if (anchor !== null) {
          anchor.text += text;
        } else if (pre > 0) {
          out.pre(preStarts ? text.replace(/^\r?\n/, "") : text);
          preStarts = false;
        } else {
          out.text(text);
        }
      },
      onclosetag(name) {
        const depth = open.length;
        if (open.pop()?.skipped === true) {
          skipped -= 1;
          return;
        }
        count(name, -1);
        if (name === "title" && titleText !== null) {
          title = titleText.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) || null;
          titleText = null;
        } else if (anchor !== null) {
          if (depth === anchor.depth) {
            const ended = anchor;
            anchor = null;
            endAnchor(ended);
          }
        } else {
          layout(name, "close");
        }
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  const pieces = out.pieces();
  return { title, pieces, links, length: pieces.reduce((sum, piece) => sum + piece.text.length, 0) };
}

function withoutHash(url: URL): string {
  return url.href.slice(0, url.href.length - url.hash.length);
}

function textPage(text: string): Page {
  const normalized = text.replace(/\r\n?/g, "\n");
  return { title: null, pieces: normalized === "" ? [] : [{ kind: "text", text: normalized }], links: [], length: normalized.length };
}

const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");
const linkLine = (page: Page, link: number) => `[${link}]: ${page.links[link - 1] ?? ""}`;

/**
 * Walks the pieces from start and stops before PART_BYTES would be passed, counting each piece's bytes plus, the first time the
 * part cites a link, the bytes of its link line. A text piece that does not fit is cut at its last line break, or else its last
 * space, in the final fifth of the room left. A start inside a link marker moves back to the marker's start.
 */
function renderPart(page: Page, start: number): { lines: string[]; next: number | null } {
  if (start > 0 && start >= page.length) {
    return { lines: [`This page has ${page.length} characters, so a part cannot start at ${start}.`], next: null };
  }
  let offset = 0;
  let index = 0;
  while (index < page.pieces.length && offset + (page.pieces[index]?.text.length ?? 0) <= start) {
    offset += page.pieces[index]?.text.length ?? 0;
    index += 1;
  }
  const first = page.pieces[index];
  let from = first?.kind === "link" ? offset : start;
  if (/[\udc00-\udfff]/.test(first?.text[from - offset] ?? "") && from > offset) {
    from -= 1;
  }
  let position = from;
  let room = PART_BYTES;
  const text: string[] = [];
  const cited = new Set<number>();
  for (; index < page.pieces.length; index += 1) {
    const piece = page.pieces[index] as Piece;
    const rest = piece.text.slice(position - offset);
    if (piece.kind === "link") {
      const cost = bytesOf(rest) + (cited.has(piece.link) ? 0 : bytesOf(linkLine(page, piece.link)) + 1);
      if (cost > room && text.length > 0) {
        break;
      }
      text.push(rest);
      cited.add(piece.link);
      room -= cost;
    } else {
      const cost = bytesOf(rest);
      if (cost > room) {
        const cut = cutPoint(rest, room);
        if (cut > 0) {
          text.push(rest.slice(0, cut));
          position += cut;
        }
        break;
      }
      text.push(rest);
      room -= cost;
    }
    offset += piece.text.length;
    position = offset;
  }
  const next = position < page.length ? position : null;
  const lines = text.length === 0 ? [] : [text.join("")];
  if (cited.size > 0) {
    lines.push("", ...[...cited].sort((a, b) => a - b).map((link) => linkLine(page, link)));
  }
  if (next !== null) {
    lines.push("", `This part is characters ${from} to ${next} of ${page.length}. For the next part, call web_fetch with the same url and start ${next}.`);
  }
  return { lines, next };
}

/** The most code units of text that fit in room bytes, moved back to a line break or a space when one is near the end. */
function cutPoint(text: string, room: number): number {
  let fits = 0;
  let bytes = 0;
  for (const character of text) {
    bytes += bytesOf(character);
    if (bytes > room) {
      break;
    }
    fits += character.length;
  }
  const floor = Math.floor(fits * 0.8);
  const newline = text.lastIndexOf("\n", fits - 1);
  if (newline >= floor && newline > 0) {
    return newline + 1;
  }
  const space = text.lastIndexOf(" ", fits - 1);
  return space >= floor && space > 0 ? space + 1 : fits;
}

function headerLines(fetched: Fetched, page: Page, reading: Reading): string[] {
  return [
    ...(fetched.url === fetched.requested ? [] : [`Redirected to: ${fetched.url.slice(0, MAX_LINK_ADDRESS)}`]),
    ...(page.title === null ? [] : [`Title: ${page.title}`]),
    ...(fetched.status >= 200 && fetched.status < 300 ? [] : [`Status: ${fetched.status} ${fetched.statusText}`.trimEnd()]),
    ...(reading.kind === "text" ? [`Type: ${reading.mediaType}`] : []),
    ...(fetched.cut ? ["The page was too large, so only its start was read."] : []),
    ...(page.length === 0 ? ["The page has no text that web_fetch can read."] : []),
  ];
}

function sizeOf(fetched: Fetched): string {
  const bytes = fetched.body.length;
  if (fetched.cut) {
    return `more than ${(bytes / 1024 / 1024).toFixed(0)} MB`;
  }
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
