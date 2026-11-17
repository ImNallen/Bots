import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import type { FunctionArgs } from "convex/server";
import type { OptimisticLocalStore } from "convex/browser";
import { useMutation } from "convex/react";
import { useRef, useState } from "react";
import type { CharacterPatch } from "./character.ts";
import { errorMessage } from "./session.tsx";

function optimisticCharacter(store: OptimisticLocalStore, { botId, ...patch }: FunctionArgs<typeof api.bots.setCharacter>) {
  const bot = store.getQuery(api.bots.get, { botId });
  if (bot) store.setQuery(api.bots.get, { botId }, { ...bot, ...patch });
  const list = store.getQuery(api.bots.list, {});
  if (list) store.setQuery(api.bots.list, {}, list.map((bot) => bot._id === botId ? { ...bot, ...patch } : bot));
  const rows = store.getQuery(api.bots.overview, {});
  if (rows) store.setQuery(api.bots.overview, {}, rows.map((row) => row._id === botId ? { ...row, ...patch } : row));
}

type AppearanceIntent = CharacterPatch & { botId: Id<"bots"> };
type Failure = { patch: AppearanceIntent; message: string };

export function useCharacterMutation() {
  const mutate = useMutation(api.bots.setCharacter).withOptimisticUpdate(optimisticCharacter);
  const latest = useRef(0);
  const [failure, setFailure] = useState<Failure | null>(null);

  function save(patch: AppearanceIntent) {
    const token = ++latest.current;
    setFailure(null);
    void mutate(patch).catch((error: unknown) => {
      if (token === latest.current) setFailure({ patch, message: errorMessage(error) });
    });
  }

  return { save, failure };
}
