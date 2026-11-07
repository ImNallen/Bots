import { ConvexError } from "convex/values";

const MAX_NAME_LENGTH = 64;
const MAX_TITLE_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 8000;

export function parseBotName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new ConvexError("Name cannot be empty");
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new ConvexError(`Name cannot be longer than ${MAX_NAME_LENGTH} characters`);
  }
  return trimmed;
}

function parseOptionalText(args: { label: string; text: string; max: number }): string | undefined {
  const trimmed = args.text.trim();
  if (trimmed.length > args.max) {
    throw new ConvexError(`${args.label} cannot be longer than ${args.max.toLocaleString("en-US")} characters`);
  }
  return trimmed === "" ? undefined : trimmed;
}

export function parseBotProfile(args: { name: string; title: string; description: string }): {
  name: string;
  title: string | undefined;
  description: string | undefined;
} {
  return {
    name: parseBotName(args.name),
    title: parseOptionalText({ label: "Title", text: args.title, max: MAX_TITLE_LENGTH }),
    description: parseOptionalText({ label: "Description", text: args.description, max: MAX_DESCRIPTION_LENGTH }),
  };
}
