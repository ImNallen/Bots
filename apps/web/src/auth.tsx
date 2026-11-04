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

type TokenFailure = Exclude<TokenResult, { kind: "ok" }>;

function describeFailure(failure: TokenFailure): string {
  switch (failure.kind) {
    case "rejected":
      return `The orchestrator refused a token (${failure.status}, ${failure.error}).`;
    case "unreachable":
      return "The orchestrator could not be reached.";
  }
}

type AuthContextValue = {
  failure: string | null;
  setFailure: (message: string) => void;
};

const AuthContext = createContext<AuthContextValue>({ failure: null, setFailure: () => {} });

function useOrchestratorAuth() {
  const { failure, setFailure } = useContext(AuthContext);
  // Identity comes from the connection, so there is nothing to wait for before asking. Every call
  // fetches a new token, which also satisfies Convex when it passes forceRefreshToken.
  const fetchAccessToken = useCallback(async () => {
    const result = await getToken();
    if (result.kind === "ok") {
      return result.token;
    }
    setFailure(describeFailure(result));
    return null;
  }, [setFailure]);
  return useMemo(
    () => ({ isLoading: false, isAuthenticated: failure === null, fetchAccessToken }),
    [failure, fetchAccessToken],
  );
}

export function useAuthFailure(): string | null {
  return useContext(AuthContext).failure;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [failure, setFailure] = useState<string | null>(null);
  const value = useMemo(() => ({ failure, setFailure }), [failure]);
  return (
    <AuthContext.Provider value={value}>
      <ConvexProviderWithAuth client={convex} useAuth={useOrchestratorAuth}>
        {children}
      </ConvexProviderWithAuth>
    </AuthContext.Provider>
  );
}
