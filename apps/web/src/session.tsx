import { api } from "@bots/convex";
import { Link } from "@tanstack/react-router";
import { ConvexError } from "convex/values";
import { useConvexAuth, useMutation } from "convex/react";
import { useEffect, useState, type ReactNode } from "react";
import { useAuthFailure } from "./auth.tsx";

export function errorMessage(error: unknown): string {
  if (error instanceof ConvexError && typeof error.data === "string") {
    return error.data;
  }
  return "Something went wrong. Try again.";
}

export function ProblemNotice({ title, message }: { title: string; message: string }) {
  return (
    <section className="notice" role="alert">
      <h2>{title}</h2>
      <p>{message}</p>
      <button type="button" className="btn btn-go" onClick={() => window.location.reload()}>
        Try again
      </button>
    </section>
  );
}

export function NotFoundNotice({ title }: { title: string }) {
  return (
    <section className="notice">
      <h2>{title}</h2>
      <Link to="/" className="btn btn-go">
        Go to your bots
      </Link>
    </section>
  );
}

type Session =
  | { kind: "pending" }
  | { kind: "ready"; email: string }
  | { kind: "failed"; message: string };

function EnsuredUser({ children }: { children: (args: { email: string }) => ReactNode }) {
  const ensureCurrent = useMutation(api.users.ensureCurrent);
  const [session, setSession] = useState<Session>({ kind: "pending" });

  useEffect(() => {
    let cancelled = false;
    ensureCurrent({}).then(
      (user) => {
        if (!cancelled) {
          setSession({ kind: "ready", email: user.email });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setSession({ kind: "failed", message: errorMessage(error) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ensureCurrent]);

  switch (session.kind) {
    case "pending":
      return (
        <p className="session-status" role="status">
          Loading your account.
        </p>
      );
    case "failed":
      return <ProblemNotice title="Could not load your account" message={session.message} />;
    case "ready":
      return children({ email: session.email });
  }
}

export function SignedIn({ children }: { children: (args: { email: string }) => ReactNode }) {
  const failure = useAuthFailure();
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (failure !== null) {
    return <ProblemNotice title="Could not sign in" message={failure} />;
  }
  if (isLoading) {
    return (
      <p className="session-status" role="status">
        Signing in.
      </p>
    );
  }
  if (!isAuthenticated) {
    return <ProblemNotice title="Could not sign in" message="Convex did not accept the token." />;
  }
  return <EnsuredUser>{children}</EnsuredUser>;
}
