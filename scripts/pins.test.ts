import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

type Pin = { file: string; node?: string; pnpm?: string };

function find(file: string, pattern: RegExp): string {
  const value = readFileSync(new URL(`../${file}`, import.meta.url), "utf8").match(pattern)?.[1];
  assert.ok(value, `${file} matches ${pattern}`);
  return value;
}

function shellPin(file: string) {
  return { file, node: find(file, /^NODE_VERSION=(\S+)$/m), pnpm: find(file, /^PNPM_VERSION=(\S+)$/m) };
}

const reference = shellPin("infra/control-vm/setup.sh");

const pins: Pin[] = [
  reference,
  shellPin("infra/proxmox/user-vm-setup.sh"),
  shellPin("infra/proxmox/install-computerd.sh"),
  { file: "package.json", pnpm: find("package.json", /"packageManager": "pnpm@([^"+]+)/) },
  { file: ".github/workflows/ci.yml", node: find(".github/workflows/ci.yml", /node-version: (\S+)/) },
];

function agrees(pinned: string | undefined, version: string) {
  return pinned === undefined || pinned === version || version.startsWith(`${pinned}.`);
}

test(`every Node and pnpm pin agrees with ${reference.file}`, () => {
  const disagreeing = pins.filter((pin) => !agrees(pin.node, reference.node) || !agrees(pin.pnpm, reference.pnpm));
  assert.deepEqual(disagreeing, [], `node ${reference.node}, pnpm ${reference.pnpm}`);
});
