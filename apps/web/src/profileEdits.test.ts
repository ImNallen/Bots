import { describe, expect, it } from "vitest";
import { hasChanges, savedProfile, shownProfile, withEdit } from "./profileEdits.ts";

const saved = savedProfile({ name: "Ada" });

describe("savedProfile", () => {
  it("includes only the name", () => {
    const stored = { name: "Ada", title: "Legacy title", description: "Hidden description" };
    expect(savedProfile(stored)).toEqual({ name: "Ada" });
  });
});

describe("edits against a live profile", () => {
  it("shows the saved values until the person types", () => {
    expect(shownProfile(saved, {})).toEqual(saved);
    expect(hasChanges({})).toBe(false);
  });

  it("keeps what the person typed when a live update changes the same field", () => {
    const edits = withEdit({ saved, edits: {}, field: "name", value: "Mine, unsaved." });
    const live = { ...saved, name: "Written in another tab." };
    expect(shownProfile(live, edits).name).toBe("Mine, unsaved.");
  });

  it("follows a live rename until the person edits the name", () => {
    expect(shownProfile({ name: "Atlas" }, {})).toEqual({ name: "Atlas" });
  });

  it("has no changes once the person types the saved value back, so that field follows live updates again", () => {
    const edited = withEdit({ saved, edits: {}, field: "name", value: "Lead" });
    expect(hasChanges(edited)).toBe(true);
    const restored = withEdit({ saved, edits: edited, field: "name", value: "Ada" });
    expect(hasChanges(restored)).toBe(false);
    expect(shownProfile({ ...saved, name: "Lead" }, restored).name).toBe("Lead");
  });

  it("treats clearing a field as a change", () => {
    const edits = withEdit({ saved, edits: {}, field: "name", value: "" });
    expect(hasChanges(edits)).toBe(true);
    expect(shownProfile(saved, edits).name).toBe("");
  });
});
