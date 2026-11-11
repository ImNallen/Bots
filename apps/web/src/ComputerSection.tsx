import { api } from "@bots/convex";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Dialog } from "./Dialog.tsx";
import { errorMessage } from "./session.tsx";

const PROGRESS: Record<string, string> = {
  removing: "Deleting the old computer.",
  cloning: "Creating a fresh computer.",
  configuring: "Setting up the fresh computer.",
  filtering: "Setting up its network.",
  starting: "Starting the fresh computer.",
  restarting: "Restarting the fresh computer.",
  "waiting-for-lock": "Waiting for the computer to finish its current operation.",
  "waiting-for-agent": "Waiting for the fresh computer to start.",
  updating: "Installing computer software.",
  repairing: "Repairing the computer connection.",
  "making-token": "Preparing a secure connection.",
  registering: "Registering the fresh computer.",
  connecting: "Waiting for the fresh computer to connect.",
  ready: "The fresh computer is connected. Finishing reset.",
  failed: "The reset could not finish yet. It will retry automatically.",
};

export function ComputerSection() {
  const computer = useQuery(api.computers.current);
  const reset = useMutation(api.computers.reset);
  const [confirming, setConfirming] = useState(false);
  const [request, setRequest] = useState<{ kind: "idle" } | { kind: "pending" } | { kind: "failed"; message: string }>({ kind: "idle" });
  const resetting = computer?.kind === "resetting";
  async function submit() {
    setRequest({ kind: "pending" });
    try {
      await reset({});
      setConfirming(false);
      setRequest({ kind: "idle" });
    } catch (error) {
      setRequest({ kind: "failed", message: errorMessage(error) });
    }
  }
  return (
    <div className="card computer-setting">
      <h3>Computer</h3>
      <p>All your bots share this computer. Resetting deletes all computer files, workspaces, and browser logins. Your bots, chats, memories, and routines stay.</p>
      {computer === undefined ? <p role="status">Loading computer.</p> : computer.kind === "unavailable" ? <p>Reset is unavailable. This account has no provisioned VM. Local Docker computers cannot be reset here.</p> : resetting ? (
        <div role="status" aria-live="polite">
          <p>Resetting computer. Active work has stopped. Bots can work again when the fresh computer connects.</p>
          <p>{PROGRESS[computer.stage] ?? "Preparing the reset."}</p>
          {computer.detail && <p className="error">Reset is retrying: {computer.detail}</p>}
        </div>
      ) : null}
      <button type="button" className="btn btn-danger" disabled={computer?.kind !== "available" || request.kind === "pending"} onClick={() => setConfirming(true)}>{resetting ? "Resetting computer…" : "Reset computer"}</button>
      {confirming && <Dialog title="Reset computer?" onClose={() => { if (request.kind !== "pending") setConfirming(false); }} footer={<>
        <button type="button" className="btn" data-autofocus disabled={request.kind === "pending"} onClick={() => setConfirming(false)}>Cancel</button>
        <button type="button" className="btn btn-danger" disabled={request.kind === "pending"} onClick={() => void submit()}>{request.kind === "pending" ? "Requesting reset…" : "Delete all computer files and reset"}</button>
      </>}>
        <p>ALL your bots share this computer. Resetting stops active work for ALL bots and permanently deletes ALL computer files, workspaces, and browser logins.</p>
        <p>Your bots, chats, memories, and routine definitions stay. Routine occurrences during the reset are skipped.</p>
        {request.kind === "failed" && <p role="alert" className="error">{request.message}</p>}
      </Dialog>}
    </div>
  );
}
