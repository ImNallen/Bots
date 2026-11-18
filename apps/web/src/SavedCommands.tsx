import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { errorMessage } from "./session.tsx";

export function SavedCommands({ botId }: { botId: Id<"bots"> }) {
  const saved = useQuery(api.approvals.savedCommands, { botId });
  const revoke = useMutation(api.approvals.revokeCommand);
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  async function remove(entryId: string) {
    setPending(entryId);
    setProblem(null);
    try {
      await revoke({ botId, entryId });
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setPending(null);
    }
  }
  if (saved === undefined) return <p>Loading saved commands…</p>;
  return <div className="saved-commands">
    <h4>Saved commands</h4>
    {saved === null || saved.entries.length === 0 ? <p>No saved commands.</p> : <>
      <p>{saved.active ? "Active at Automatic only." : "Inactive. These commands apply only at Automatic on their original computer."}</p>
      <p>Workspace <code>{saved.scope.workspace}</code>. Resetting the computer clears these permissions.</p>
      {saved.entries.map(entry => <div className="saved-command" key={entry.id}>
        <pre tabIndex={0}>{entry.command}</pre>
        <button type="button" className="btn" disabled={pending !== null} onClick={() => void remove(entry.id)}>{pending === entry.id ? "Revoking" : "Revoke"}</button>
      </div>)}
      <p>Revoking stops future calls. A call already authorized to send may still run.</p>
    </>}
    {problem !== null && <p className="error" role="alert">{problem}</p>}
  </div>;
}
