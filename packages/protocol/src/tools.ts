import { z } from "zod";

export const WORKSPACE_ROOT = "/workspace";

const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_PATH_LENGTH = 4096;
const MAX_FILE_CONTENT_BYTES = 1024 * 1024;

const noNul = (value: string) => !value.includes("\0");

const pathArg = z.string().min(1).max(MAX_PATH_LENGTH).refine(noNul, "must not contain a NUL byte");

// These become argv entries, and Linux limits one argv entry to 128 KiB, so the limit here turns E2BIG into an invalid call.
const shellArgs = z.strictObject({
  command: z.string().min(1).max(MAX_COMMAND_BYTES).refine(noNul, "must not contain a NUL byte"),
  timeoutSeconds: z.number().int().min(1).max(600).default(120),
});

const readFileArgs = z.strictObject({ path: pathArg });

const writeFileArgs = z.strictObject({
  path: pathArg,
  content: z.string().max(MAX_FILE_CONTENT_BYTES),
});

const MAX_URL_LENGTH = 8192;
const MAX_TYPED_TEXT = 16 * 1024;

export const BROWSER_KEYS = ["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const;

const browserNavigateArgs = z.strictObject({
  url: z
    .string()
    .max(MAX_URL_LENGTH)
    .refine((url) => /^https?:\/\//i.test(url) && URL.canParse(url), "must be an http or https URL"),
});
const browserSnapshotArgs = z.strictObject({});
const browserClickArgs = z.strictObject({ ref: z.number().int().min(1) });
const browserTypeArgs = z.strictObject({
  ref: z.number().int().min(1),
  text: z.string().max(MAX_TYPED_TEXT),
  submit: z.boolean().default(false),
});
const browserPressArgs = z.strictObject({ key: z.enum(BROWSER_KEYS) });

export const toolInvocation = z.discriminatedUnion("name", [
  z.strictObject({ name: z.literal("shell"), args: shellArgs }),
  z.strictObject({ name: z.literal("read_file"), args: readFileArgs }),
  z.strictObject({ name: z.literal("write_file"), args: writeFileArgs }),
  z.strictObject({ name: z.literal("browser_navigate"), args: browserNavigateArgs }),
  z.strictObject({ name: z.literal("browser_snapshot"), args: browserSnapshotArgs }),
  z.strictObject({ name: z.literal("browser_click"), args: browserClickArgs }),
  z.strictObject({ name: z.literal("browser_type"), args: browserTypeArgs }),
  z.strictObject({ name: z.literal("browser_press"), args: browserPressArgs }),
]);

export type ToolInvocation = z.infer<typeof toolInvocation>;
export type ToolName = ToolInvocation["name"];
export type BrowserInvocation = Extract<ToolInvocation, { name: `browser_${string}` }>;

export function isBrowserInvocation(tool: ToolInvocation): tool is BrowserInvocation {
  return tool.name.startsWith("browser_");
}

const TOOLS = {
  shell: {
    description:
      "Run a bash command as the agent user. Stdout and stderr are combined and capped at 32 KiB. The working directory is the bot's workspace. A command that outlives its timeout is killed with its whole process group. Redirect the output of anything left running in the background, because the pipe closes when the command returns.",
    args: shellArgs,
  },
  read_file: {
    description: "Read a text file, capped at 32 KiB. A relative path resolves against the bot's workspace.",
    args: readFileArgs,
  },
  write_file: {
    description:
      "Write a text file, replacing any existing content and creating parent directories. A relative path resolves against the bot's workspace.",
    args: writeFileArgs,
  },
  browser_navigate: {
    description:
      "Open a URL on this bot's screen, in a browser that all of this user's bots share logins with. Returns a snapshot of the page. The user can watch this screen and take it over. If a page needs a login, ask the user to take over the screen and log in. Never ask for a password in the chat.",
    args: browserNavigateArgs,
  },
  browser_snapshot: {
    description:
      "Read this bot's current page as text. Each element you can act on has a number in brackets, for use as the ref of browser_click and browser_type. A ref holds until the page changes, so take a new snapshot after any action that changes the page. Password values are never shown.",
    args: browserSnapshotArgs,
  },
  browser_click: {
    description: "Click an element from the latest snapshot. Returns a new snapshot.",
    args: browserClickArgs,
  },
  browser_type: {
    description:
      "Replace the text in a field from the latest snapshot. Set submit to press Enter afterward. Returns a new snapshot.",
    args: browserTypeArgs,
  },
  browser_press: {
    description: "Press one key on this bot's current page. Use the arrow keys and Enter to choose from a dropdown. Returns a new snapshot.",
    args: browserPressArgs,
  },
} as const satisfies Record<ToolName, { description: string; args: z.ZodType }>;

export const toolDefinitions = Object.entries(TOOLS).map(([name, tool]) => {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(tool.args, { io: "input" });
  return { type: "function" as const, function: { name, description: tool.description, parameters } };
});

export type ParsedToolCall =
  | { kind: "ok"; invocation: ToolInvocation }
  | { kind: "invalid"; reason: string };

export function parseToolCall(args: { name: string; arguments: string }): ParsedToolCall {
  if (!Object.hasOwn(TOOLS, args.name)) {
    return {
      kind: "invalid",
      reason: `There is no tool named "${args.name}". The tools are ${Object.keys(TOOLS).join(", ")}.`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(args.arguments);
  } catch {
    return { kind: "invalid", reason: `The arguments to ${args.name} are not valid JSON.` };
  }
  const parsed = toolInvocation.safeParse({ name: args.name, args: raw });
  if (!parsed.success) {
    return {
      kind: "invalid",
      reason: `The arguments to ${args.name} do not match its schema: ${z.prettifyError(parsed.error)}`,
    };
  }
  return { kind: "ok", invocation: parsed.data };
}
