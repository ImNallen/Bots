import { describe, expect, it } from "vitest";
import { runEventBody } from "./validators.js";

describe("the validator of a stored assistant turn", () => {
  const [usage] = runEventBody.members.flatMap((member) => ("usage" in member.fields ? [member.fields.usage] : []));

  it("takes a usage with the cached tokens and one without, and still requires the other two counts", () => {
    expect(Object.entries(usage?.fields ?? {}).map(([name, field]) => [name, field.kind, field.isOptional])).toEqual([
      ["promptTokens", "float64", "required"],
      ["completionTokens", "float64", "required"],
      ["cachedTokens", "float64", "optional"],
    ]);
  });
});
