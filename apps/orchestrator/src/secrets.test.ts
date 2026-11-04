import { describe, expect, it } from "vitest";
import { decryptApiKey, encryptApiKey, hashComputerToken } from "./secrets.ts";

const masterKey = Buffer.alloc(32, 9);
const apiKey = "mistral-secret-key-abcd";

describe("API key encryption", () => {
  const encrypted = encryptApiKey({ masterKey, ownerId: "owner-a", apiKey });

  it("round trips for the same owner", () => {
    expect(decryptApiKey({ masterKey, ownerId: "owner-a", encrypted })).toBe(apiKey);
  });

  it("stores the last four characters and no plaintext", () => {
    expect(encrypted.last4).toBe("abcd");
    expect(JSON.stringify({ ...encrypted, last4: "" })).not.toContain(apiKey);
    expect(Buffer.from(encrypted.ciphertext, "base64").toString("utf8")).not.toContain("mistral");
  });

  it("fails under another owner's AAD, so a row cannot be swapped", () => {
    expect(() => decryptApiKey({ masterKey, ownerId: "owner-b", encrypted })).toThrow();
  });

  it("fails under another master key", () => {
    expect(() => decryptApiKey({ masterKey: Buffer.alloc(32, 1), ownerId: "owner-a", encrypted })).toThrow();
  });

  it("fails when the ciphertext or tag was altered", () => {
    const flipped = Buffer.from(encrypted.ciphertext, "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() =>
      decryptApiKey({
        masterKey,
        ownerId: "owner-a",
        encrypted: { ...encrypted, ciphertext: flipped.toString("base64") },
      }),
    ).toThrow();
  });

  it("uses a fresh IV each time", () => {
    expect(encryptApiKey({ masterKey, ownerId: "owner-a", apiKey }).iv).not.toBe(encrypted.iv);
  });
});

describe("hashComputerToken", () => {
  it("is the hex sha256 of the token", () => {
    expect(hashComputerToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
