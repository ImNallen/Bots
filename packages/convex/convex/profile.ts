import { ConvexError } from "convex/values";
import { NAME_PROBLEMS, parseName } from "./names.js";
import { DESCRIPTION_PROBLEMS, parseDescription } from "./memories.js";

export function parseBotName(name: string): string {
  const parsed = parseName(name);
  if (parsed.kind === "refused") {
    throw new ConvexError(NAME_PROBLEMS[parsed.problem]);
  }
  return parsed.name;
}

export function parseBotIdentity(args: { name: string }): { name: string } {
  return { name: parseBotName(args.name) };
}

export function parseBotProfile(args: { name: string; description: string }): {
  name: string;
  description: string | undefined;
} {
  const description = parseDescription(args.description);
  if (description.kind === "refused") {
    throw new ConvexError(DESCRIPTION_PROBLEMS[description.problem].owner);
  }
  return {
    ...parseBotIdentity(args),
    description: description.text,
  };
}
