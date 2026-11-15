import { applicableStoredState, type InlineUiStateRecord } from "../../shared/inlineUiState.js";
import { parseAnswer } from "../../shared/widget/template.js";
import type { InlineUiStateChange } from "../types.js";

/**
 * The values the user left in an answer's controls that still APPLY to it: a
 * stored value counts only while the answer still declares that `{@state}`
 * with the same declaration text (`sig`) — `applicableStoredState`, the rule
 * the viewer's browser restores by too. In the answer's declaration order (the
 * first declaration of a name wins). A parse that fails yields nothing
 * (nothing can be matched).
 */
export function inlineUiStateChanges(answer: string, values: InlineUiStateRecord): InlineUiStateChange[] {
  let states: { name: string; sig: string }[];
  try {
    states = parseAnswer(answer).states;
  } catch {
    return [];
  }
  const out: InlineUiStateChange[] = [];
  const seen = new Set<string>();
  for (const st of states) {
    if (seen.has(st.name)) continue;
    const entry = applicableStoredState(values, st);
    if (!entry) continue;
    seen.add(st.name);
    out.push({ name: st.name, value: entry.value });
  }
  return out;
}
