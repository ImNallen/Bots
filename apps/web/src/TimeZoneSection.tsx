import { api } from "@bots/convex";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Icon } from "./Icon.tsx";
import { browserTimeZone } from "./routines.ts";
import { errorMessage } from "./session.tsx";

export function TimeZoneSection() {
  const user = useQuery(api.users.current);
  const setTimeZone = useMutation(api.users.setTimeZone);
  const [save, setSave] = useState<{ kind: "idle" } | { kind: "pending" } | { kind: "saved" } | { kind: "failed"; message: string }>({ kind: "idle" });
  if (user === undefined) {
    return <p role="status">Loading your time zone.</p>;
  }
  const current = user?.timeZone ?? browserTimeZone();
  const zones = [...new Set([current, ...Intl.supportedValuesOf("timeZone")])].toSorted();

  async function choose(timeZone: string) {
    setSave({ kind: "pending" });
    try {
      await setTimeZone({ timeZone });
      setSave({ kind: "saved" });
    } catch (error) {
      setSave({ kind: "failed", message: errorMessage(error) });
    }
  }

  return (
    <>
      <div className="card">
        <label className="card-row">
          <span>Your time zone</span>
          <span className="select">
            <select value={current} disabled={save.kind === "pending"} onChange={(event) => void choose(event.target.value)}>
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
            <Icon name="chevron" />
          </span>
        </label>
      </div>
      {save.kind === "failed" ? (
        <p className="error panel-note" role="alert">
          {save.message}
        </p>
      ) : (
        <p className="panel-note" role="status">
          {save.kind === "saved" ? "Saved. " : ""}A weekly routine runs at its hour in this zone.
        </p>
      )}
    </>
  );
}
