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

export const toolInvocation = z.discriminatedUnion("name", [
  z.strictObject({ name: z.literal("shell"), args: shellArgs }),
  z.strictObject({ name: z.literal("read_file"), args: readFileArgs }),
  z.strictObject({ name: z.literal("write_file"), args: writeFileArgs }),
]);

export type ToolInvocation = z.infer<typeof toolInvocation>;
export type ToolName = ToolInvocation["name"];

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
