// The web tools run inside the computerd process, never through sudo and never near a desktop, so they work on a VM and in Docker on
// a Mac alike.
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { pipeline, type Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { capText, webUrl, type ToolResult, type WebInvocation } from "@bots/protocol";
import { publicAddressFor, type PublicAddress, type Resolve } from "./addresses.ts";
import { showPage, type Fetched } from "./web-page.ts";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
// Under the link's 60 seconds for a tool that is not shell, so a slow site reads as timeout and never as unavailable. A setTimeout,
// not AbortSignal.timeout, so that vitest's fake timers drive it.
const FETCH_DEADLINE_MS = 30_000;
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

// Bing answered this User-Agent with results on 2026-11-09. No Cookie, no Authorization, and no Referer, ever. Only encodings that
// node:zlib decodes are offered.
const REQUEST_HEADERS = {
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
  "accept-language": "en-US,en;q=0.9",
  "accept-encoding": "gzip, br",
} as const;

/** Already parsed out of node's IncomingMessage, so no node:http type crosses Network. */
export type Opened = {
  status: number;
  statusText: string;
  location: string | undefined;
  contentType: string | undefined;
  /** Decoded from its Content-Encoding. Destroying it ends the download. */
  body: Readable;
};

/**
 * The only I/O the web tools do, so a test replaces it whole and opens no socket. open sends one GET for url to exactly address,
 * with the name in the Host header and in TLS's server name, so the certificate is checked against the name.
 */
export type Network = {
  resolve: Resolve;
  open: (args: { url: URL; address: PublicAddress; signal: AbortSignal }) => Promise<Opened>;
};

export type Web = {
  /** Never rejects. Every failure is a tool result. */
  execute: (args: { tool: WebInvocation; signal: AbortSignal }) => Promise<ToolResult>;
};

function planFor(tool: WebInvocation): { url: string; show: (fetched: Fetched) => ToolResult } {
  switch (tool.name) {
    case "web_fetch":
      return { url: tool.args.url, show: (fetched) => showPage(fetched, tool.args.start) };
  }
}

type Loaded = { kind: "fetched"; fetched: Fetched } | { kind: "refused"; reason: string } | { kind: "failed"; host: string; error: unknown };

const failed = (output: string): ToolResult => ({ outcome: "error", output, truncated: false });

// A call shares nothing with any other: no cookies, no cache, and no connection, so it needs no botId.
export function createWeb(args: { network: Network }): Web {
  const { network } = args;

  async function load(requested: string, signal: AbortSignal): Promise<Loaded> {
    let url = webUrl(requested);
    if (url === null) {
      return { kind: "refused", reason: `${requested.slice(0, 2048)} is not an http or https URL without a user name or password.` };
    }
    const first = url.href;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      try {
        const check = await publicAddressFor(url.hostname, network.resolve);
        if (check.kind === "refused") {
          return check;
        }
        const opened = await network.open({ url, address: check.address, signal });
        if (REDIRECTS.has(opened.status) && opened.location !== undefined) {
          opened.body.destroy();
          const next = webUrl(opened.location, url.href);
          if (next === null) {
            return { kind: "refused", reason: `The page redirected to ${opened.location.slice(0, 2048)}, which cannot be opened.` };
          }
          url = next;
          continue;
        }
        const { body, cut } = await readCapped(opened.body, MAX_BODY_BYTES);
        const { status, statusText, contentType } = opened;
        return { kind: "fetched", fetched: { requested: first, url: url.href, status, statusText, contentType, body, cut } };
      } catch (error) {
        return { kind: "failed", host: url.hostname, error };
      }
    }
    return { kind: "refused", reason: `The page redirected more than ${MAX_REDIRECTS} times.` };
  }

  return {
    async execute({ tool, signal }) {
      if (signal.aborted) {
        return { outcome: "cancelled", output: "The call was cancelled before it started.", truncated: false };
      }
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), FETCH_DEADLINE_MS);
      const combined = AbortSignal.any([signal, deadline.signal]);
      const stopped = new Promise<"stopped">((resolve) => combined.addEventListener("abort", () => resolve("stopped"), { once: true }));
      try {
        const plan = planFor(tool);
        const loaded = await Promise.race([load(plan.url, combined), stopped]);
        if (signal.aborted) {
          return { outcome: "cancelled", output: "The call was cancelled.", truncated: false };
        }
        if (loaded === "stopped" || deadline.signal.aborted) {
          return { outcome: "timeout", output: `The page took longer than ${FETCH_DEADLINE_MS / 1000} seconds.`, truncated: false };
        }
        switch (loaded.kind) {
          case "refused":
            return failed(loaded.reason);
          case "failed":
            return failed(networkFailure(loaded.error, loaded.host));
          case "fetched": {
            const shown = plan.show(loaded.fetched);
            const capped = capText(shown.output);
            return { ...shown, output: capped.output, truncated: shown.truncated || capped.truncated };
          }
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Reads until limit bytes, then destroys the stream and reports cut. A body that errors rejects, as a network failure. */
async function readCapped(body: Readable, limit: number): Promise<{ body: Buffer; cut: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    if (chunk.length > limit - size) {
      chunks.push(chunk.subarray(0, limit - size));
      body.destroy();
      return { body: Buffer.concat(chunks), cut: true };
    }
    chunks.push(chunk);
    size += chunk.length;
  }
  return { body: Buffer.concat(chunks), cut: false };
}

const CERTIFICATE_ERRORS = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_REVOKED",
]);

function networkFailure(error: unknown, host: string): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  switch (code) {
    case "ENOTFOUND":
      return `${host} has no address.`;
    case "EAI_AGAIN":
      return `${host} could not be looked up just now.`;
    case "ECONNREFUSED":
      return `${host} refused the connection.`;
    case "ECONNRESET":
      return `${host} closed the connection.`;
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return `${host} could not be reached.`;
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return `${host} has a certificate that does not match its name.`;
  }
  if (code !== undefined && CERTIFICATE_ERRORS.has(code)) {
    return `${host} has a certificate that cannot be trusted (${code}).`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Reading ${host} failed: ${code === undefined ? "" : `${code} `}${message}`.slice(0, 1024);
}

function decoded(response: IncomingMessage): Readable {
  const encoding = (response.headers["content-encoding"] ?? "identity").trim().toLowerCase();
  const decoder =
    encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : null;
  if (decoder === null) {
    if (encoding !== "identity" && encoding !== "") {
      response.destroy(new Error(`the page came in the encoding ${encoding}`));
    }
    return response;
  }
  return pipeline(response, decoder, () => {});
}

export const nodeNetwork: Network = {
  resolve: (hostname) => lookup(hostname, { all: true, order: "verbatim" }),
  open: ({ url, address, signal }) =>
    new Promise((resolve, reject) => {
      const name = url.hostname.replace(/^\[|\]$/g, "");
      const secure = url.protocol === "https:";
      const request = (secure ? httpsRequest : httpRequest)({
        host: address.ip,
        family: address.family,
        port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
        method: "GET",
        path: `${url.pathname}${url.search}`,
        headers: { host: url.host, ...REQUEST_HEADERS },
        servername: isIP(name) === 0 ? name : undefined,
        agent: false,
        signal,
      });
      request.on("response", (response) => {
        const location = response.headers.location;
        resolve({
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? "",
          location,
          contentType: response.headers["content-type"],
          body: decoded(response),
        });
      });
      request.on("error", reject);
      request.end();
    }),
};
