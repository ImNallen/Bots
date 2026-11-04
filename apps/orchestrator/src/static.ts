import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

export type StaticFile = {
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
  cacheControl: string;
};

export type StaticFiles = ReadonlyMap<string, StaticFile>;

const INDEX_PATH = "/index.html";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

// Requests only look up this map, so a request path never reaches the filesystem and traversal has nothing to escape.
export async function loadStaticFiles(args: { distDir: string }): Promise<StaticFiles> {
  const entries = await readdir(args.distDir, {
    recursive: true,
    withFileTypes: true,
  }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry): Promise<[string, StaticFile]> => {
        const absolute = join(entry.parentPath, entry.name);
        const urlPath = `/${relative(args.distDir, absolute).split(sep).join("/")}`;
        return [
          urlPath,
          {
            body: new Uint8Array(await readFile(absolute)),
            contentType: CONTENT_TYPES[extname(entry.name)] ?? "application/octet-stream",
            cacheControl: urlPath.startsWith("/assets/")
              ? "public, max-age=31536000, immutable"
              : "no-cache",
          },
        ];
      }),
  );
  return new Map(files);
}

function isSpaRoute(pathname: string): boolean {
  if (pathname.startsWith("/assets/") || /%2e|%2f|%5c|\\/i.test(pathname)) {
    return false;
  }
  return !(pathname.split("/").at(-1) ?? "").includes(".");
}

export function resolveStaticFile(args: {
  files: StaticFiles;
  pathname: string;
}): StaticFile | null {
  const exact = args.files.get(args.pathname === "/" ? INDEX_PATH : args.pathname);
  if (exact !== undefined) {
    return exact;
  }
  return isSpaRoute(args.pathname) ? (args.files.get(INDEX_PATH) ?? null) : null;
}
