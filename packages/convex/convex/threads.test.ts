import { describe, expect, it } from "vitest";
import { runsToShow } from "./threads.js";

type Row = { trigger: "user" | "schedule"; name: string };
const user = (name: string): Row => ({ trigger: "user", name });
const report = (name: string): Row => ({ trigger: "schedule", name });
const many = (count: number, make: (name: string) => Row, prefix: string) => Array.from({ length: count }, (_, index) => make(`${prefix}${index}`));

describe("runsToShow", () => {
  it("shows 30 runs of the owner, and stops before the 31st", () => {
    const shown = runsToShow(many(31, user, "u"));
    expect(shown).toHaveLength(30);
    expect(shown.at(-1)?.name).toBe("u29");
  });

  it("does not count reports toward the 30", () => {
    const newest = [...many(40, report, "r"), user("owner"), ...many(29, user, "u")];
    const shown = runsToShow(newest);
    expect(shown).toHaveLength(70);
    expect(shown.map((row) => row.name)).toContain("owner");
  });

  it("keeps the reports that sit among the owner's 30 runs, and stops at the next owner's run", () => {
    const newest = [...many(30, user, "u"), report("older report"), user("past the page")];
    const names = runsToShow(newest).map((row) => row.name);
    expect(names).toContain("older report");
    expect(names).not.toContain("past the page");
  });

  it("reads at most 200 runs, so a month of reports cannot hold the query up", () => {
    expect(runsToShow(many(500, report, "r"))).toHaveLength(200);
    const beyond = [...many(200, report, "r"), user("owner")];
    expect(runsToShow(beyond).map((row) => row.name)).not.toContain("owner");
  });
});
