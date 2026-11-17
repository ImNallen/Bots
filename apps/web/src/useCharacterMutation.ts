import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import type { FunctionArgs } from "convex/server";
import type { OptimisticLocalStore } from "convex/browser";
import { useMutation } from "convex/react";
import { useRef, useState } from "react";
import type { BotColor, BotShape, CharacterPatch } from "./character.ts";
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
type FieldFailures = {
  shape?: { botId: Id<"bots">; value: BotShape; message: string };
  color?: { botId: Id<"bots">; value: BotColor; message: string };
};

export function useCharacterMutation() {
  const mutate = useMutation(api.bots.setCharacter).withOptimisticUpdate(optimisticCharacter);
  const latest = useRef({ shape: 0, color: 0 });
  const [failures, setFailures] = useState<FieldFailures>({});

  function save(patch: AppearanceIntent) {
    const shapeToken = patch.shape === undefined ? undefined : ++latest.current.shape;
    const colorToken = patch.color === undefined ? undefined : ++latest.current.color;
    setFailures((current) => ({
      ...current,
      ...(patch.shape === undefined ? {} : { shape: undefined }),
      ...(patch.color === undefined ? {} : { color: undefined }),
    }));
    void mutate(patch).catch((error: unknown) => {
      const message = errorMessage(error);
      setFailures((current) => ({
        ...current,
        ...(patch.shape !== undefined && shapeToken === latest.current.shape
          ? { shape: { botId: patch.botId, value: patch.shape, message } } : {}),
        ...(patch.color !== undefined && colorToken === latest.current.color
          ? { color: { botId: patch.botId, value: patch.color, message } } : {}),
      }));
    });
  }

  const failure: Failure | null = failures.shape
    ? { patch: { botId: failures.shape.botId, shape: failures.shape.value, ...(failures.color ? { color: failures.color.value } : {}) }, message: failures.shape.message }
    : failures.color
      ? { patch: { botId: failures.color.botId, color: failures.color.value }, message: failures.color.message }
      : null;
  return { save, failure };
}
