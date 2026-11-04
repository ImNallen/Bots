import { api } from "@bots/convex";
import { ConvexError } from "convex/values";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useEffect, useState, type FormEvent } from "react";
import { useAuthFailure } from "./auth.tsx";

function errorMessage(error: unknown): string {
  if (error instanceof ConvexError && typeof error.data === "string") {
    return error.data;
  }
  return "Something went wrong. Try again.";
}

function ProblemNotice({ title, message }: { title: string; message: string }) {
  return (
    <section className="notice" role="alert">
      <h2>{title}</h2>
      <p>{message}</p>
      <button type="button" onClick={() => window.location.reload()}>
        Try again
      </button>
    </section>
  );
}

function CreateBotForm() {
  const createBot = useMutation(api.bots.create);
  const [name, setName] = useState("");
  const [submission, setSubmission] = useState<
    { kind: "idle" } | { kind: "pending" } | { kind: "failed"; message: string }
  >({ kind: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmission({ kind: "pending" });
    try {
      await createBot({ name });
      setName("");
      setSubmission({ kind: "idle" });
    } catch (error) {
      setSubmission({ kind: "failed", message: errorMessage(error) });
    }
  }

  return (
    <form className="create-bot" onSubmit={(event) => void handleSubmit(event)}>
      <label htmlFor="bot-name">New bot name</label>
      <div className="create-bot-row">
        <input
          id="bot-name"
          value={name}
          autoComplete="off"
          aria-invalid={submission.kind === "failed"}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" disabled={submission.kind === "pending"}>
          {submission.kind === "pending" ? "Creating" : "Create bot"}
        </button>
      </div>
      {submission.kind === "failed" && (
        <p className="error" role="alert">
          {submission.message}
        </p>
      )}
    </form>
  );
}

function BotList() {
  const bots = useQuery(api.bots.list);
  if (bots === undefined) {
    return <p role="status">Loading bots.</p>;
  }
  if (bots.length === 0) {
    return <p className="muted">No bots yet.</p>;
  }
  return (
    <ul className="bot-list">
      {bots.map((bot) => (
        <li key={bot._id}>{bot.name}</li>
      ))}
    </ul>
  );
}

type Session =
  | { kind: "pending" }
  | { kind: "ready"; email: string }
  | { kind: "failed"; message: string };

function SignedIn() {
  const ensureCurrent = useMutation(api.users.ensureCurrent);
  const [session, setSession] = useState<Session>({ kind: "pending" });

  useEffect(() => {
    let cancelled = false;
    ensureCurrent().then(
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
      return <p role="status">Loading your account.</p>;
    case "failed":
      return <ProblemNotice title="Could not load your account" message={session.message} />;
    case "ready":
      return (
        <>
          <p className="signed-in">
            Signed in as <strong>{session.email}</strong>
          </p>
          <CreateBotForm />
          <section>
            <h2>Your bots</h2>
            <BotList />
          </section>
        </>
      );
  }
}

export function Home() {
  const failure = useAuthFailure();
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (failure !== null) {
    return <ProblemNotice title="Could not sign in" message={failure} />;
  }
  if (isLoading) {
    return <p role="status">Signing in.</p>;
  }
  if (!isAuthenticated) {
    return <ProblemNotice title="Could not sign in" message="Convex did not accept the token." />;
  }
  return <SignedIn />;
}
