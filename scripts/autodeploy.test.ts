import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, type Green } from "./autodeploy.ts";

const deployed = "a".repeat(40);
const tip = "b".repeat(40);
const commit = "c".repeat(40);
const green = (overrides: Partial<Green> = {}): Green => ({
  commit,
  onMain: true,
  deployedContains: false,
  changed: ["apps/orchestrator/src/main.ts"],
  ...overrides,
});

test("main at the deployed commit is up to date", () => {
  assert.deepEqual(decide({ deployed, tip: deployed, green: null }), { kind: "up-to-date" });
});

test("a green commit with code changes deploys", () => {
  assert.deepEqual(decide({ deployed, tip, green: green() }), { kind: "deploy", commit });
});

test("a change that touches docs and code deploys", () => {
  const changed = ["docs/roadmap.md", "infra/control-vm/deploy.sh"];
  assert.deepEqual(decide({ deployed, tip, green: green({ changed }) }), { kind: "deploy", commit });
});

test("with no deployed commit, the green commit deploys", () => {
  assert.deepEqual(decide({ deployed: null, tip, green: green({ changed: [] }) }), { kind: "deploy", commit });
});

test("a change to docs and Markdown only skips to the green commit", () => {
  const changed = ["docs/roadmap.md", "README.md", "infra/control-vm/README.md"];
  assert.deepEqual(decide({ deployed, tip, green: green({ changed }) }), {
    kind: "skip",
    commit,
    reason: "only docs changed",
  });
});

test("main with no successful run waits", () => {
  assert.equal(decide({ deployed, tip, green: null }).kind, "wait");
});

test("a green commit that is not on main waits", () => {
  assert.equal(decide({ deployed, tip, green: green({ onMain: false }) }).kind, "wait");
});

test("a green commit at or behind the deployed commit waits", () => {
  assert.equal(decide({ deployed, tip, green: green({ commit: deployed, deployedContains: true, changed: [] }) }).kind, "wait");
  assert.equal(decide({ deployed, tip, green: green({ deployedContains: true }) }).kind, "wait");
});
