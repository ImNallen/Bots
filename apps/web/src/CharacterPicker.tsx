import { BotFace } from "./BotFace.tsx";
import { type BotColor, type Character } from "./character.ts";

const COLORS: readonly { color: BotColor; label: string }[] = [
  { color: "green", label: "Sage" },
  { color: "blue", label: "Blue" },
  { color: "orange", label: "Peach" },
];

export function CharacterPicker({ character, onChange }: { character: Character; onChange: (next: Character) => void }) {
  const choices = COLORS.some((choice) => choice.color === character.color)
    ? COLORS : [...COLORS, { color: character.color, label: character.color }];
  return (
    <div className="picker pick-colors" role="group" aria-label="Bot color">
      {choices.map(({ color, label }) => (
        <button key={color} type="button" aria-label={label} aria-pressed={color === character.color} onClick={() => onChange({ ...character, color })}>
          <BotFace character={{ ...character, color }} size={34} />
        </button>
      ))}
    </div>
  );
}
