export type TokenResult =
  | { kind: "ok"; token: string }
  | { kind: "rejected"; status: number; error: string }
  | { kind: "unreachable" };

export async function getToken(): Promise<TokenResult> {
  let response: Response;
  try {
    response = await fetch("/auth/token", { cache: "no-store" });
  } catch {
    return { kind: "unreachable" };
  }
  const body: unknown = await response.json().catch(() => null);
  if (typeof body === "object" && body !== null) {
    if (response.ok && "token" in body && typeof body.token === "string") {
      return { kind: "ok", token: body.token };
    }
    if ("error" in body && typeof body.error === "string") {
      return { kind: "rejected", status: response.status, error: body.error };
    }
  }
  return { kind: "rejected", status: response.status, error: "unexpected response" };
}
