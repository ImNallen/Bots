import { api } from "@bots/convex";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";
import { MistralKeySection } from "./MistralKeySection.tsx";
import { SignedIn, errorMessage } from "./session.tsx";

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
        <li key={bot._id}>
          <Link to="/bots/$botId" params={{ botId: bot._id }}>
            {bot.name}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function Home() {
  return (
    <SignedIn>
      {({ email }) => (
        <>
          <p className="signed-in">
            Signed in as <strong>{email}</strong>
          </p>
          <CreateBotForm />
          <section>
            <h2>Your bots</h2>
            <BotList />
          </section>
          <MistralKeySection />
        </>
      )}
    </SignedIn>
  );
}
