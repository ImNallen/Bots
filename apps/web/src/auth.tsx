import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getToken, type TokenResult } from "./token.ts";

function parseConvexUrl(raw: unknown): string {
  if (typeof raw !== "string" || !URL.canParse(raw)) {
    throw new Error("VITE_CONVEX_URL must be a URL. Run pnpm bootstrap.");
  }
  return raw;
}

const convex = new ConvexReactClient(parseConvexUrl(import.meta.env.VITE_CONVEX_URL));

const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 8000;

function describeRejection(rejection: Extract<TokenResult, { kind: "rejected" }>): string {
  return `The orchestrator refused a token (${rejection.status}, ${rejection.error}).`;
}

type AuthContextValue = {
  failure: string | null;
  reconnecting: boolean;
  setFailure: (message: string) => void;
  setReconnecting: (reconnecting: boolean) => void;
};

const AuthContext = createContext<AuthContextValue>({
  failure: null,
  reconnecting: false,
  setFailure: () => {},
  setReconnecting: () => {},
});

function useOrchestratorAuth() {
  const { failure, setFailure, setReconnecting } = useContext(AuthContext);
  // Identity comes from the connection, so there is nothing to wait for before asking. Every call
  // fetches a new token, which also satisfies Convex when it passes forceRefreshToken.
  // An orchestrator restart is routine, so this keeps Convex waiting until one answers. Only a refusal is final.
  const fetchAccessToken = useCallback(async () => {
    for (let delayMs = FIRST_RETRY_MS; ; delayMs = Math.min(delayMs * 2, MAX_RETRY_MS)) {
      const result = await getToken();
      switch (result.kind) {
        case "ok":
          setReconnecting(false);
          return result.token;
        case "rejected":
          setReconnecting(false);
          setFailure(describeRejection(result));
          return null;
        case "unreachable":
          setReconnecting(true);
          await new Promise((done) => setTimeout(done, delayMs));
      }
    }
  }, [setFailure, setReconnecting]);
  return useMemo(
    () => ({ isLoading: false, isAuthenticated: failure === null, fetchAccessToken }),
    [failure, fetchAccessToken],
  );
}

export function useAuthFailure(): string | null {
  return useContext(AuthContext).failure;
}

export function useAuthReconnecting(): boolean {
  return useContext(AuthContext).reconnecting;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [failure, setFailure] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const value = useMemo(() => ({ failure, reconnecting, setFailure, setReconnecting }), [failure, reconnecting]);
  return (
    <AuthContext.Provider value={value}>
      <ConvexProviderWithAuth client={convex} useAuth={useOrchestratorAuth}>
        {children}
      </ConvexProviderWithAuth>
    </AuthContext.Provider>
  );
}
