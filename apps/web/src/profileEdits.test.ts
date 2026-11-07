import { describe, expect, it } from "vitest";
import { hasChanges, savedProfile, shownProfile, withEdit } from "./profileEdits.ts";

const saved = savedProfile({ name: "Ada", title: "Scout" });

describe("savedProfile", () => {
  it("shows an absent title as an empty field", () => {
    expect(savedProfile({ name: "Ada" })).toEqual({ name: "Ada", title: "" });
  });
});

describe("edits against a live profile", () => {
  it("shows the saved values until the person types", () => {
    expect(shownProfile(saved, {})).toEqual(saved);
    expect(hasChanges({})).toBe(false);
  });

  it("keeps what the person typed when a live update changes the same field", () => {
    const edits = withEdit({ saved, edits: {}, field: "title", value: "Mine, unsaved." });
    const live = { ...saved, title: "Written in another tab." };
    expect(shownProfile(live, edits).title).toBe("Mine, unsaved.");
  });

  it("lets a live update reach a field the person did not touch", () => {
    const edits = withEdit({ saved, edits: {}, field: "title", value: "Mine, unsaved." });
    const live = { ...saved, name: "Atlas" };
    expect(shownProfile(live, edits)).toEqual({ name: "Atlas", title: "Mine, unsaved." });
  });

  it("has no changes once the person types the saved value back, so that field follows live updates again", () => {
    const edited = withEdit({ saved, edits: {}, field: "title", value: "Lead" });
    expect(hasChanges(edited)).toBe(true);
    const restored = withEdit({ saved, edits: edited, field: "title", value: "Scout" });
    expect(hasChanges(restored)).toBe(false);
    expect(shownProfile({ ...saved, title: "Lead" }, restored).title).toBe("Lead");
  });

  it("treats clearing a field as a change", () => {
    const edits = withEdit({ saved, edits: {}, field: "title", value: "" });
    expect(hasChanges(edits)).toBe(true);
    expect(shownProfile(saved, edits).title).toBe("");
  });
});
