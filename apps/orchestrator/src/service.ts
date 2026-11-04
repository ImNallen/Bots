import { ConvexClient, ConvexHttpClient } from "convex/browser";
import type { FunctionReference, FunctionReturnType, OptionalRestArgs } from "convex/server";
import type { TokenIssuer } from "./tokens.ts";

const REFRESH_BEFORE_EXPIRY_SECONDS = 60;

export type Service = {
  query: <Q extends FunctionReference<"query">>(
    fn: Q,
    ...args: OptionalRestArgs<Q>
  ) => Promise<FunctionReturnType<Q>>;
  mutation: <M extends FunctionReference<"mutation">>(
    fn: M,
    ...args: OptionalRestArgs<M>
  ) => Promise<FunctionReturnType<M>>;
  subscribe: <Q extends FunctionReference<"query">>(
    fn: Q,
    args: Q["_args"],
    onUpdate: (value: FunctionReturnType<Q>) => void,
  ) => () => void;
};

// One-shot calls use HTTP so that an unreachable Convex fails now and the caller decides. The WebSocket client queues forever.
export function createService(args: { url: string; issuer: TokenIssuer }): Service {
  const http = new ConvexHttpClient(args.url);
  const live = new ConvexClient(args.url, { logger: false });
  live.setAuth(async () => (await args.issuer.forService()).token);

  let expiresAt = 0;
  async function refreshedHttp(): Promise<ConvexHttpClient> {
    if (expiresAt - REFRESH_BEFORE_EXPIRY_SECONDS < Date.now() / 1000) {
      const issued = await args.issuer.forService();
      http.setAuth(issued.token);
      expiresAt = issued.expiresAt;
    }
    return http;
  }

  return {
    query: async (fn, ...callArgs) => (await refreshedHttp()).query(fn, ...callArgs),
    mutation: async (fn, ...callArgs) => (await refreshedHttp()).mutation(fn, ...callArgs),
    subscribe: (fn, callArgs, onUpdate) => live.onUpdate(fn, callArgs, onUpdate),
  };
}
