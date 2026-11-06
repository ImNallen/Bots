import { describe, expect, it } from "vitest";
import { characterOf } from "./character.ts";

const ids = Array.from({ length: 2000 }, (_, index) => `j57${index.toString(36)}ab${(index * 7).toString(36)}`);

describe("characterOf", () => {
  it("gives the same id the same look", () => {
    expect(characterOf({ _id: "k1742bot" })).toEqual(characterOf({ _id: "k1742bot" }));
  });

  it("lets a stored value win over the derived one", () => {
    expect(characterOf({ _id: "k1742bot", shape: "hex", color: "black" })).toEqual({ shape: "hex", color: "black" });
    expect(characterOf({ _id: "k1742bot", color: "grey" }).color).toBe("grey");
    expect(characterOf({ _id: "k1742bot", shape: "egg" }).shape).toBe("egg");
  });

  it("never derives black or grey", () => {
    for (const _id of ids) {
      expect(["black", "grey"]).not.toContain(characterOf({ _id }).color);
    }
  });

  it("spreads ids across every shape and every colour it can derive", () => {
    const looks = ids.map((_id) => characterOf({ _id }));
    expect(new Set(looks.map((look) => look.shape)).size).toBe(13);
    expect(new Set(looks.map((look) => look.color)).size).toBe(9);
  });
});
