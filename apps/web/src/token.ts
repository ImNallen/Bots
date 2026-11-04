export type TokenResult =
  | { kind: "ok"; token: string }
  | { kind: "rejected"; status: number; error: string }
  | { kind: "unreachable" };

function readProperty(args: { body: unknown; name: string }): unknown {
  if (typeof args.body !== "object" || args.body === null) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(args.body, args.name)?.value;
}

export async function getToken(): Promise<TokenResult> {
  let response: Response;
  try {
    response = await fetch("/auth/token", { cache: "no-store" });
  } catch {
    return { kind: "unreachable" };
  }
  const body: unknown = await response.json().catch(() => null);
  const token = readProperty({ body, name: "token" });
  if (response.ok && typeof token === "string") {
    return { kind: "ok", token };
  }
  const error = readProperty({ body, name: "error" });
  return {
    kind: "rejected",
    status: response.status,
    error: typeof error === "string" ? error : "unexpected response",
  };
}
