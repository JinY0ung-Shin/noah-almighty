/**
 * Hidden aliases for RETIRED tool names (a tool merged into another, or renamed).
 *
 * pi freezes a session's tool list and a conversation's prompt, so a session
 * started before the change — and any skill or note that still names the old
 * tool — can call the old name after it is gone. Such a call is answered at
 * `/mcp` (`mcpHttp/endpoint.ts` `RETIRED_TOOL_MESSAGES`, checked before every
 * gate, never reaching the server) with a refusal that NAMES THE NEW CALL, so
 * the model can redo it in one step. The old name is never registered on a
 * server, so `tools/list` (the static pi catalog) never lists it, and it is not
 * in any `*_TOOL_NAMES` / `mcpAllowedTools` list.
 *
 * Reach: pi's `mcp_call` forwards only a name that is IN the session's listed
 * tools (pi itself answers an unknown name: "Unknown tool … find the exact name
 * with mcp_search"). So the redirect reaches the model from sessions whose frozen
 * list still has the old name; a session built after the rename gets pi's own
 * search hint instead. Both end at the new name.
 *
 * A retired name is RESERVED FOREVER (root CLAUDE.md): never register a new
 * tool under it, and never drop its entry here — an entry is cheap and a
 * frozen session may live for months.
 *
 * API: `retiredToolAliases(server, [{ name, redirect }])` returns the
 * `<server>/<tool>` → model-facing message map one server contributes;
 * `RETIRED_TOOL_ALIASES` is every server's map, merged into the endpoint's
 * table. `redirect` is English (agent-facing) and says exactly which call
 * replaces the old one and how its arguments map.
 */

/** One retired tool name of a server and where its calls go now. */
export interface RetiredToolAlias {
  /** The old tool name, without the `mcp__<server>__` prefix. */
  name: string;
  /** Agent-facing text naming the replacement call (full `mcp__…` name, arguments). */
  redirect: string;
}

/** The `<server>/<tool>` → message map of one server's retired tool names. */
export function retiredToolAliases(server: string, aliases: readonly RetiredToolAlias[]): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const { name, redirect } of aliases) {
    const key = `${server}/${name}`;
    if (Object.hasOwn(out, key)) throw new Error(`retired tool alias listed twice: ${key}`);
    out[key] = `Tool 'mcp__${server}__${name}' was retired and is no longer listed; nothing was run. ${redirect}`;
  }
  return out;
}

const ROUTINE_FIELDS = "prompt, name, scheduleKind, date, time, daysOfWeek, intervalMinutes, enabled";

/**
 * system: the routine tools merged into `routine` and the plugin tools into
 * `plugin` (2026-11-16).
 */
export const SYSTEM_RETIRED_TOOLS = retiredToolAliases("system", [
  { name: "list_routines", redirect: 'Call mcp__system__routine with {"action":"list"} instead.' },
  {
    name: "create_routine",
    redirect: `Call mcp__system__routine with "action":"create" and the same arguments (${ROUTINE_FIELDS}) instead.`,
  },
  {
    name: "update_routine",
    redirect: `Call mcp__system__routine with "action":"update", the routine's "id" and the fields to change (${ROUTINE_FIELDS}) instead.`,
  },
  { name: "delete_routine", redirect: 'Call mcp__system__routine with {"action":"delete","id":"<routine id>"} instead.' },
  { name: "list_plugins", redirect: 'Call mcp__system__plugin with {"action":"list"} instead.' },
  {
    name: "add_plugin",
    redirect: 'Call mcp__system__plugin with "action":"add" and the same arguments (repo, ref, label) instead.',
  },
  {
    name: "set_plugin_enabled",
    redirect: 'Call mcp__system__plugin with {"action":"set_enabled","id":"<plugin id>","enabled":true|false} instead.',
  },
]);

/** browser: the four tab tools became `tabs`, the two clipboard tools `clipboard` (2026-11-16; same ops, same guards). */
export const BROWSER_RETIRED_TOOLS = retiredToolAliases("browser", [
  { name: "list_tabs", redirect: 'It is now mcp__browser__tabs with action "list" — call that.' },
  { name: "new_tab", redirect: 'It is now mcp__browser__tabs with action "new" — call that with the same `url` (and `maxChars`).' },
  { name: "select_tab", redirect: 'It is now mcp__browser__tabs with action "select" — call that with the same `tabId`.' },
  { name: "close_tab", redirect: 'It is now mcp__browser__tabs with action "close" — call that with the same `tabId`.' },
  { name: "copy_image", redirect: 'It is now mcp__browser__clipboard with action "image" — call that with the same `path`.' },
  { name: "copy_text", redirect: 'It is now mcp__browser__clipboard with action "text" — call that with the same `text`.' },
]);

/** Every server's retired tool names (merged into `RETIRED_TOOL_MESSAGES`, `mcpHttp/endpoint.ts`). */
export const RETIRED_TOOL_ALIASES: Readonly<Record<string, string>> = {
  ...SYSTEM_RETIRED_TOOLS,
  ...BROWSER_RETIRED_TOOLS,
};
