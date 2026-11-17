import { useId, type ReactNode } from "react";
import { BotFace } from "./BotFace.tsx";
import { COLOR_NAMES, COLORS, SHAPE_NAMES, SHAPES, displayShape, type Character, type CharacterPatch } from "./character.ts";

export function CharacterPreview({ character, name, children }: { character: Character; name: string; children?: ReactNode }) {
  return (
    <div className="character-preview" aria-label="Live preview">
      <BotFace character={character} size={80} />
      <div>{children ?? <p>{name || "Your bot"}</p>}<small>{COLORS[character.color].label} · {SHAPES[displayShape(character.shape)].label}</small></div>
    </div>
  );
}

export function CharacterPicker({ character, onChange, disabled = false }: { character: Character; onChange: (patch: CharacterPatch) => void; disabled?: boolean }) {
  const id = useId();
  const shape = displayShape(character.shape);
  return (
    <div className="character-picker">
      <fieldset aria-label="Color" disabled={disabled}>
        <legend><span>Color</span><small>{COLORS[character.color].label}</small></legend>
        <div className="character-colors">
          {COLOR_NAMES.map((color) => (
            <label className="character-color" key={color}>
              <input type="radio" name={`${id}-color`} value={color} aria-label={COLORS[color].label} checked={color === character.color} onChange={() => onChange({ color })} />
              <span className="character-color-ring"><BotFace character={{ ...character, color }} size={36} /></span>
              <span>{COLORS[color].label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset aria-label="Shape" disabled={disabled}>
        <legend><span>Shape</span><small>{SHAPES[shape].label}</small></legend>
        <div className="character-shapes">
          {SHAPE_NAMES.map((value) => (
            <label className="character-shape" key={value}>
              <input type="radio" name={`${id}-shape`} value={value} aria-label={SHAPES[value].label} checked={value === shape} onChange={() => onChange({ shape: value })} />
              <BotFace character={{ ...character, shape: value }} size={32} />
              <span>{SHAPES[value].label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
