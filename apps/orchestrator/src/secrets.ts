import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_VERSION = 1;

export type EncryptedKey = {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
  last4: string;
};

// The owner's id is authenticated data, so a ciphertext moved to another user's row fails to decrypt.
export function encryptApiKey(args: { masterKey: Buffer; ownerId: string; apiKey: string }): EncryptedKey {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, args.masterKey, iv);
  cipher.setAAD(Buffer.from(args.ownerId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(args.apiKey, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    keyVersion: KEY_VERSION,
    last4: args.apiKey.slice(-4),
  };
}

export function decryptApiKey(args: {
  masterKey: Buffer;
  ownerId: string;
  encrypted: Pick<EncryptedKey, "ciphertext" | "iv" | "tag">;
}): string {
  const decipher = createDecipheriv(ALGORITHM, args.masterKey, Buffer.from(args.encrypted.iv, "base64"));
  decipher.setAAD(Buffer.from(args.ownerId, "utf8"));
  decipher.setAuthTag(Buffer.from(args.encrypted.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(args.encrypted.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function hashComputerToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
