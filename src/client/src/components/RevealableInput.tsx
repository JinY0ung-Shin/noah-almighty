import { useState, type HTMLInputAutoCompleteAttribute } from "react";
import Icon from "./Icon";
import { usePropState } from "../lib/hooks";

export interface RevealableInputProps {
  value?: string;
  /** The field's new text, on every keystroke (the `value` the parent holds). */
  onValueChange?: (value: string) => void;
  name?: string;
  placeholder?: string;
  ariaLabel?: string;
  ariaDescribedby?: string;
  ariaInvalid?: boolean;
  autocomplete?: string;
  revealLabel?: string;
  disabled?: boolean;
  /** Called after `onValueChange`, for a parent that only needs to know something was typed. */
  onInput?: (() => void) | null;
}

export default function RevealableInput({
  value: valueProp = "",
  onValueChange,
  name = "",
  placeholder = "",
  ariaLabel = "",
  ariaDescribedby,
  ariaInvalid = false,
  autocomplete = "off",
  revealLabel = "값",
  disabled = false,
  onInput = null,
}: RevealableInputProps) {
  // Works on its own too: the text is held here and follows the parent's `value`.
  const [value, setValue] = usePropState(valueProp);
  const [revealedState, setRevealed] = useState(false);
  // A field that gets locked goes back to hidden, and stays hidden when unlocked.
  if (disabled && revealedState) setRevealed(false);
  const revealed = revealedState && !disabled;
  const toggleLabel = revealed ? `${revealLabel} 숨기기` : `${revealLabel} 보기`;

  return (
    <div className="password-field">
      <input
        name={name}
        type={revealed ? "text" : "password"}
        placeholder={placeholder}
        autoComplete={autocomplete as HTMLInputAutoCompleteAttribute}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedby}
        aria-invalid={ariaInvalid ? "true" : undefined}
        disabled={disabled}
        value={value}
        onChange={(event) => {
          setValue(event.currentTarget.value);
          onValueChange?.(event.currentTarget.value);
          onInput?.();
        }}
      />
      <button
        className="password-toggle"
        type="button"
        disabled={disabled}
        aria-label={toggleLabel}
        title={toggleLabel}
        onClick={() => setRevealed(!revealed)}
      >
        <Icon name={revealed ? "eye-off" : "eye"} />
      </button>
    </div>
  );
}
