export function log(args: { level: "info" | "warn" | "error"; event: string; [field: string]: unknown }): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...args })}\n`);
}
