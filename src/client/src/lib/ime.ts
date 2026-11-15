// IME composition guard shared by every key handler that acts on Enter/Escape
// (or any key that would read the field's value).
//
// While a Korean (or any) IME composes a syllable, the keydown it sends belongs
// to the composition: acting on it submits or closes with the LAST syllable
// still uncommitted. `isComposing` says so on most browsers; some (older Safari,
// Chrome on a few IMEs) report only the legacy `keyCode === 229` ("Process").
// Both are checked, and a React synthetic event is read through `nativeEvent`
// (React's own event type does not carry `isComposing`).

type KeyEventLike = {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
};

/** True while an IME owns this keydown — the handler should leave the key alone. */
export function isImeComposing(event: KeyEventLike): boolean {
  return Boolean(event.isComposing || event.nativeEvent?.isComposing) || event.keyCode === 229;
}
