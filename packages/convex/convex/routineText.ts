import { textProblem, type TextProblem } from "./memories.js";

export const ROUTINE_LIMITS = { title: 60, summary: 200, steps: 6, step: 200, instruction: 2000 } as const;

// What the owner reads is title, summary, and steps. What the routine runs is instruction.
export type RoutineText = { title: string; summary: string; steps: string[]; instruction: string };

type Field = "title" | "summary" | "step" | "instruction";
type Problem = TextProblem | "empty";

const FIELDS: Record<Field, { words: string; max: number; oneLine: boolean }> = {
  title: { words: "title", max: ROUTINE_LIMITS.title, oneLine: true },
  summary: { words: "description", max: ROUTINE_LIMITS.summary, oneLine: true },
  step: { words: "step", max: ROUTINE_LIMITS.step, oneLine: true },
  instruction: { words: "instruction", max: ROUTINE_LIMITS.instruction, oneLine: false },
};

function problemOf(field: Field, text: string): Problem | null {
  const { max, oneLine } = FIELDS[field];
  if (text === "") {
    return "empty";
  }
  return oneLine && /[\r\n]/.test(text) ? "characters" : textProblem(text, max);
}

function reasonFor(field: Field, problem: Problem): string {
  const { words, max, oneLine } = FIELDS[field];
  switch (problem) {
    case "empty":
      return `A routine's ${words} cannot be empty.`;
    case "tooLong":
      return `A routine's ${words} cannot be longer than ${max.toLocaleString("en-US")} characters. Write a shorter one.`;
    case "characters":
      return `A routine's ${words} cannot hold invisible or control characters${oneLine ? " or line breaks" : ""}. Write it without them.`;
    case "secret":
      return "This looks like a password, key, token, or card number. Do not try again. A routine browses logged out, so it needs no login.";
  }
}

export type ParsedRoutineText<T> = { kind: "ok"; text: T } | { kind: "refused"; reason: string };

export function parseRoutineText<T extends Partial<RoutineText>>(text: T): ParsedRoutineText<T> {
  const parsed: Partial<RoutineText> = { ...text };
  for (const field of ["title", "summary", "instruction"] as const) {
    const value = text[field]?.trim();
    if (value === undefined) {
      continue;
    }
    const problem = problemOf(field, value);
    if (problem !== null) {
      return { kind: "refused", reason: reasonFor(field, problem) };
    }
    parsed[field] = value;
  }
  if (text.steps !== undefined) {
    if (text.steps.length === 0 || text.steps.length > ROUTINE_LIMITS.steps) {
      return { kind: "refused", reason: `A routine has 1 to ${ROUTINE_LIMITS.steps} steps.` };
    }
    const steps = text.steps.map((step) => step.trim());
    for (const step of steps) {
      const problem = problemOf("step", step);
      if (problem !== null) {
        return { kind: "refused", reason: reasonFor("step", problem) };
      }
    }
    parsed.steps = steps;
  }
  return { kind: "ok", text: parsed as T };
}

export function routineTitle(routine: { title?: string; instruction: string }): string {
  if (routine.title !== undefined) {
    return routine.title;
  }
  const characters = [...routine.instruction.replace(/\s+/g, " ").trim()];
  return characters.length <= ROUTINE_LIMITS.title ? characters.join("") : `${characters.slice(0, ROUTINE_LIMITS.title - 1).join("").trimEnd()}…`;
}
