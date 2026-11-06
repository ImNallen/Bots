import { api } from "@bots/convex";
import { Navigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { useOpenNewBot } from "./AppShell.tsx";
import { useIsPhone } from "./useIsPhone.ts";

// On a phone the sidebar is this whole page, so this content shows only on a computer.
export function Home() {
  const rows = useQuery(api.bots.overview);
  const isPhone = useIsPhone();
  const openNewBot = useOpenNewBot();
  const newest = rows?.[0];
  if (rows === undefined || isPhone) {
    return null;
  }
  if (newest !== undefined) {
    return <Navigate to="/bots/$botId" params={{ botId: newest._id }} replace />;
  }
  return (
    <div className="start">
      <strong>Make your first bot</strong>
      <button type="button" className="btn btn-go" onClick={openNewBot}>
        New bot
      </button>
    </div>
  );
}
