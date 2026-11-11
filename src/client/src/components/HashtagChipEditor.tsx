// Chip editor for capability hashtags: type + Enter/comma/space to add, click
// × or Backspace-on-empty to remove. Ports buildHashtagEditor from explore.js.
// Pass `tags` + `onTagsChange` for the current value; the parent reads it on save.
import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import Icon from "./Icon";
import { normalizeTags } from "../lib/format";
import { usePropState } from "../lib/hooks";
import { notify } from "../lib/state";
import "./HashtagChipEditor.css";

let nextHashtagEditorId = 0;

// One shared default: a fresh `[]` per render would read as a changed prop.
const NO_TAGS: string[] = [];

export interface HashtagChipEditorProps {
  tags?: string[];
  /** The new list, on every add/remove (the `tags` the parent holds). */
  onTagsChange?: (tags: string[]) => void;
  disabled?: boolean;
}

export default function HashtagChipEditor({ tags: tagsProp = NO_TAGS, onTagsChange, disabled = false }: HashtagChipEditorProps) {
  const [tags, setTagsState] = usePropState(tagsProp);
  const [value, setValue] = useState("");
  const [editorId] = useState(() => `hashtag-editor-${++nextHashtagEditorId}`);
  const inputEl = useRef<HTMLInputElement | null>(null);
  const statusText = tags.length ? `${tags.length}개 해시태그가 선택되었습니다.` : "선택된 해시태그가 없습니다.";

  function setTags(next: string[]): void {
    setTagsState(next);
    onTagsChange?.(next);
  }

  function addFromInput(): void {
    if (disabled) return;
    const parts = value
      // Split on the same separators the server uses (incl. fullwidth , 、).
      .split(/[\s,，、]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const truncated = parts.some((p) => p.replace(/^[#*•·\-\s]+/u, "").length > 30);
    const before = tags.length;
    const next = normalizeTags([...tags, ...parts]);
    setTags(next);
    setValue("");
    if (truncated) {
      notify("해시태그는 최대 30자까지만 사용할 수 있어 일부가 잘렸습니다.", "info");
    } else if (parts.length && next.length === before) {
      // normalizeTags caps at 12 and drops duplicates; tell the user when their
      // input added nothing (the sibling profile-tab path already reports this).
      notify("해시태그는 최대 12개까지만 추가할 수 있어 더 추가되지 않았습니다.", "info");
    }
  }

  function onKeydown(e: KeyboardEvent<HTMLInputElement>): void {
    if (disabled) return;
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addFromInput();
    } else if (e.key === " " && value.trim()) {
      e.preventDefault();
      addFromInput();
    } else if (e.key === "Backspace" && !value && tags.length) {
      setTags(tags.slice(0, -1));
    }
  }

  function onEditorKeydown(e: KeyboardEvent<HTMLDivElement>): void {
    if (disabled) return;
    if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
      e.preventDefault();
      inputEl.current?.focus();
    }
  }

  function remove(index: number): void {
    if (disabled) return;
    setTags(tags.filter((_, i) => i !== index));
  }

  function focusInput(e: MouseEvent<HTMLDivElement>): void {
    if (disabled) return;
    if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("tag-chips")) {
      inputEl.current?.focus();
    }
  }

  // Clicks on editor whitespace focus the chip input; keyboard users tab
  // directly to the input/buttons.
  return (
    <div
      className="hashtag-editor cmp-hashtag-chip-editor"
      role="group"
      aria-label="역량 해시태그 편집"
      aria-describedby={`${editorId}-status`}
      aria-disabled={disabled ? "true" : "false"}
      onClick={focusInput}
      onKeyDown={onEditorKeydown}
    >
      <div className="tag-chips" role="list" aria-label="현재 해시태그">
        {tags.map((tag, i) => (
          <span key={tag + i} className="tag accent hashtag-chip" role="listitem">
            <span>#{tag}</span>
            <button type="button" className="chip-x" aria-label={`${tag} 제거`} disabled={disabled} onClick={() => remove(i)}>
              <Icon name="close" size={12} />
            </button>
          </span>
        ))}
      </div>
      <span className="sr-only" id={`${editorId}-status`} role="status" aria-live="polite">
        {statusText} Enter, 쉼표, 공백으로 추가할 수 있습니다.
      </span>
      <input
        className="tag-input"
        type="text"
        placeholder="태그 입력 후 Enter"
        aria-label="역량 해시태그 추가"
        aria-describedby={`${editorId}-status`}
        disabled={disabled}
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        ref={inputEl}
        onKeyDown={onKeydown}
        onBlur={() => {
          if (value.trim()) addFromInput();
        }}
      />
    </div>
  );
}
