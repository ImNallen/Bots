import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PageView } from "@bots/protocol";
import { aimPageInput, retainedPageInput } from "./page.ts";
import { decideByRules } from "@bots/convex/automaticRules";

const page: PageView = { snapshotId: randomUUID(), origin: null, targets: [{ ref: 1, words: "Draft", control: { kind: "field", field: "line", readOnly: false } }], truncated: false };
const request = { name: "browser_type", args: { ref: 1, text: "draft", submit: false } } as const;

describe("page preparation", () => {
  it("derives aim, policy facts and the subject from one stored observation", () => {
    const prepared = aimPageInput(request, page);
    expect(prepared.kind).toBe("computer");
    if (prepared.kind !== "computer") throw Error("preparation failed");
    expect(prepared.tool.aim.snapshotId).toBe(page.snapshotId);
    expect(prepared.facts).toEqual({ origin: null, target: page.targets[0] });
    expect(prepared.detail.subject).toBe('Type into "Draft" on this page (site unavailable)');
    expect(decideByRules({ invocation: request, aim: null, page: prepared.facts, workspace: "/workspace/bot" }).run).toBe(true);
    expect(retainedPageInput(request, prepared.detail.pageAim)).toEqual(prepared);
    expect(retainedPageInput({ ...request, args: { ...request.args, ref: 2 } }, prepared.detail.pageAim).kind).toBe("invalid");
  });
  it("does not invent an aim for missing facts or old approvals", () => {
    expect(aimPageInput(request, null).kind).toBe("invalid");
    expect(aimPageInput({ ...request, args: { ...request.args, ref: 2 } }, page).kind).toBe("invalid");
    expect(retainedPageInput(request, null).kind).toBe("invalid");
    expect(retainedPageInput(request, "{}").kind).toBe("invalid");
    expect(aimPageInput({ name: "browser_press", args: { key: "Tab" } }, page).kind).toBe("invalid");
    const focused = aimPageInput({ name: "browser_press", args: { key: "Enter" } }, { ...page, focus: { kind: "target", ref: 1 } });
    expect(focused.kind).toBe("computer");
    if (focused.kind === "computer") expect(focused.facts.target).toEqual(page.targets[0]);
  });
});
