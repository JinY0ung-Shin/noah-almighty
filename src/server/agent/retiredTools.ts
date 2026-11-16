/**
 * HIDDEN ALIASES: tool names a live server no longer lists but still ANSWERS,
 * each with an error naming the call that replaced it.
 *
 * Why: pi freezes a session's tool list (and a conversation's prompt) when the
 * session is built, and skills, manual text or an older extension may still
 * name the old tool. So a renamed or merged tool keeps its old name callable at
 * Noah's `/mcp` — never in `tools/list` (the old name is simply not registered,
 * so the static catalog, `pi/mcpCatalog.ts`, cannot list it) — and every call of
 * it is refused with a redirect, before any per-call gate and without reaching
 * the server (`mcpHttp/endpoint.ts` spreads {@link RETIRED_TOOL_ALIASES} into
 * `RETIRED_TOOL_MESSAGES`). Nothing runs, so a redirect needs no gate of its own.
 *
 * Reach: pi's `mcp_call` forwards only a name that is IN the session's listed
 * tools (pi itself answers an unknown name: "Unknown tool … find the exact name
 * with mcp_search"). So the redirect reaches the model from sessions whose frozen
 * list still has the old name; a session built after the rename gets pi's own
 * search hint instead. Both end at the new name.
 *
 * Use: `retiredToolAliases("<server>", [{ name, redirect }])`, spread into
 * {@link RETIRED_TOOL_ALIASES}. `redirect` names the new call EXACTLY (tool + the
 * argument that selects the old behaviour + which arguments carry over). A
 * retired name is reserved FOREVER: never mint a tool with it again (a test
 * keeps every retired name out of the catalog).
 */

export interface RetiredToolAlias {
  /** The retired tool's name inside its server, e.g. `new_tab`. */
  name: string;
  /** The model-facing redirect, naming the replacing call exactly. */
  redirect: string;
}

/**
 * The refusal texts of one server's retired names, keyed `<server>/<tool>`
 * (the key form of `RETIRED_TOOL_MESSAGES` and `catalogText.ts`).
 */
export function retiredToolAliases(server: string, aliases: readonly RetiredToolAlias[]): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const alias of aliases) {
    const key = `${server}/${alias.name}`;
    if (Object.hasOwn(out, key)) throw new Error(`retiredToolAliases: ${key} is listed twice`);
    out[key] = `Tool 'mcp__${server}__${alias.name}' was retired and is no longer listed; nothing was run. ${alias.redirect}`;
  }
  return out;
}

/** 2026-11-16: the four tab tools became `tabs`, the two clipboard tools `clipboard` (same ops, same guards). */
export const BROWSER_RETIRED_TOOLS = retiredToolAliases("browser", [
  { name: "list_tabs", redirect: 'It is now mcp__browser__tabs with action "list" — call that.' },
  { name: "new_tab", redirect: 'It is now mcp__browser__tabs with action "new" — call that with the same `url` (and `maxChars`).' },
  { name: "select_tab", redirect: 'It is now mcp__browser__tabs with action "select" — call that with the same `tabId`.' },
  { name: "close_tab", redirect: 'It is now mcp__browser__tabs with action "close" — call that with the same `tabId`.' },
  { name: "copy_image", redirect: 'It is now mcp__browser__clipboard with action "image" — call that with the same `path`.' },
  { name: "copy_text", redirect: 'It is now mcp__browser__clipboard with action "text" — call that with the same `text`.' },
]);

/** Every hidden alias Noah answers, keyed `<server>/<tool>`. */
export const RETIRED_TOOL_ALIASES: Readonly<Record<string, string>> = {
  ...BROWSER_RETIRED_TOOLS,
};
