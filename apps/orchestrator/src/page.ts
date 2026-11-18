import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { pageAim, pageView, type AimedPageInvocation, type PageAim, type PageInputRequest, type PageView } from "@bots/protocol";
import type { PageFacts } from "@bots/convex/automaticRules";
import type { Service } from "./service.ts";

export async function loadPage(service: Service, runId: Id<"runs">): Promise<PageView | null> {
  const row = await service.query(api.pages.ofRun, { runId });
  if (row === null) return null;
  try {
    return pageView.parse(JSON.parse(row.view));
  } catch {
    return null;
  }
}

type PreparedPage =
  | { kind: "invalid"; reason: string }
  | { kind: "computer"; tool: AimedPageInvocation; facts: PageFacts; detail: { subject: string; pageAim: string } };

export function aimPageInput(request: PageInputRequest, page: PageView | null): PreparedPage {
  if (page === null) return { kind: "invalid", reason: "There is no captured page for this call. Take a browser snapshot first." };
  const identity = { snapshotId: page.snapshotId, origin: page.origin };
  if (request.name === "browser_press") {
    if (page.focus === undefined) return { kind: "invalid", reason: "This older snapshot has no focus information. Take a new browser snapshot." };
    const focus = page.focus;
    const target = focus.kind === "target" ? page.targets.find((target) => target.ref === focus.ref) ?? null : null;
    return bindPageInput(request, { kind: "focus", ...identity, focus, target });
  }
  const target = page.targets.find((target) => target.ref === request.args.ref);
  if (target === undefined) return { kind: "invalid", reason: "That control is not in the captured page. Take a new browser snapshot." };
  return bindPageInput(request, { kind: "element", ...identity, target });
}

export function retainedPageInput(request: PageInputRequest, raw: string | null): PreparedPage {
  if (raw === null) return { kind: "invalid", reason: "This older approval has no bound page. It cannot authorize a new action; request a fresh call." };
  try {
    return bindPageInput(request, pageAim.parse(JSON.parse(raw)));
  } catch {
    return { kind: "invalid", reason: "This approval's page binding is unreadable. The action did not run." };
  }
}

function bindPageInput(request: PageInputRequest, aim: PageAim): PreparedPage {
  let tool: AimedPageInvocation;
  if (request.name === "browser_press" && aim.kind === "focus") tool = { ...request, aim };
  else if (request.name !== "browser_press" && aim.kind === "element" && request.args.ref === aim.target.ref) tool = { ...request, aim };
  else return { kind: "invalid", reason: "The action does not match its retained page binding." };
  const target = aim.target;
  const site = aim.origin ?? "this page (site unavailable)";
  const control = target !== null
    ? JSON.stringify(target.words || "unnamed control")
    : aim.kind === "focus" && aim.focus.kind === "none" ? "no focused control" : "an unlisted focused control";
  const action = request.name === "browser_click" ? "Click" : request.name === "browser_type" ? "Type into" : `Press ${request.args.key} with`;
  return { kind: "computer", tool, facts: { origin: aim.origin, target }, detail: { subject: `${action} ${control} on ${site}`, pageAim: JSON.stringify(aim) } };
}
