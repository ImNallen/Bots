import { describe, expect, it } from "vitest";
import { stillUnsaved, hasChanges, savedProfile, shownProfile, withEdit } from "./profileEdits.ts";

const saved = savedProfile({ name: "Ada", title: "Scout", assignment: "Watch the news." });

describe("savedProfile", () => {
  it("shows an absent title and assignment as empty fields", () => {
    expect(savedProfile({ name: "Ada" })).toEqual({ name: "Ada", title: "", assignment: "" });
  });
});

describe("edits against a live profile", () => {
  it("shows the saved values until the person types", () => {
    expect(shownProfile(saved, {})).toEqual(saved);
    expect(hasChanges({})).toBe(false);
  });

  it("keeps what the person typed when a live update changes the same field", () => {
    const edits = withEdit({ saved, edits: {}, field: "assignment", value: "Mine, unsaved." });
    const live = { ...saved, assignment: "Written in another tab." };
    expect(shownProfile(live, edits).assignment).toBe("Mine, unsaved.");
  });

  it("lets a live update reach a field the person did not touch", () => {
    const edits = withEdit({ saved, edits: {}, field: "assignment", value: "Mine, unsaved." });
    const live = { ...saved, title: "Lead" };
    expect(shownProfile(live, edits)).toEqual({ name: "Ada", title: "Lead", assignment: "Mine, unsaved." });
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

describe("stillUnsaved", () => {
  it("clears the fields that were saved", () => {
    const sent = { title: "Lead", assignment: "New." };
    expect(hasChanges(stillUnsaved({ current: sent, sent }))).toBe(false);
  });

  it("keeps a field the person changed again during the save", () => {
    const sent = { title: "Lead", assignment: "New." };
    const current = { title: "Lead", assignment: "New, and more." };
    expect(stillUnsaved({ current, sent })).toEqual({ assignment: "New, and more." });
  });

  it("keeps a field the person started during the save", () => {
    const current = { title: "Lead", name: "Grace" };
    expect(stillUnsaved({ current, sent: { title: "Lead" } })).toEqual({ name: "Grace" });
  });
});
