const MAX_NAME_LENGTH = 64;

export const NAME_PROBLEMS = {
  empty: "Name cannot be empty",
  tooLong: `Name cannot be longer than ${MAX_NAME_LENGTH} characters`,
};

export function parseName(name: string): { kind: "ok"; name: string } | { kind: "refused"; problem: keyof typeof NAME_PROBLEMS } {
  const trimmed = name.trim();
  if (trimmed === "") {
    return { kind: "refused", problem: "empty" };
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    return { kind: "refused", problem: "tooLong" };
  }
  return { kind: "ok", name: trimmed };
}
