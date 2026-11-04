export type LogFields = { level: "info" | "warn" | "error"; event: string; [field: string]: unknown };

export function log(args: LogFields): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...args })}\n`);
}
