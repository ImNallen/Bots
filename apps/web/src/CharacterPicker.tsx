import { BotFace } from "./BotFace.tsx";
import { COLOR_NAMES, SHAPE_NAMES, tintOf, type Character } from "./character.ts";

export function CharacterPicker(props: { character: Character; onChange: (next: Character) => void }) {
  const { character, onChange } = props;
  return (
    <div className="picker">
      <div className="pick pick-shapes" role="group" aria-label="Shape">
        {SHAPE_NAMES.map((shape) => (
          <button
            key={shape}
            type="button"
            aria-label={shape}
            aria-pressed={shape === character.shape}
            onClick={() => onChange({ ...character, shape })}
          >
            <BotFace character={{ ...character, shape }} size={28} />
          </button>
        ))}
      </div>
      <div className="pick pick-colors" role="group" aria-label="Colour">
        {COLOR_NAMES.map((color) => (
          <button
            key={color}
            type="button"
            className="tint"
            {...tintOf(color)}
            aria-label={color}
            aria-pressed={color === character.color}
            onClick={() => onChange({ ...character, color })}
          >
            <span className="swatch" />
          </button>
        ))}
      </div>
    </div>
  );
}
