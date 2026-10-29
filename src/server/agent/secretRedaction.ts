// Secret-VALUE redaction for tool results before the model sees them.
//
// Secret values can legitimately appear in a tool result — a relayed plugin or
// 공용 MCP server echoing its credential, a page echoing a password the browser
// bridge typed. The pi run endpoint applies this to EVERY Noah MCP result of a
// run (`transformResult`, agent/pi/runPiAgent.ts) and the browser tools to
// their own replies, so values never enter the model context, the stored
// transcript, or the visible chat. This is ACCIDENT-PREVENTION, not
// containment: a source that can use a secret can also transform it (base64,
// split) past a literal replace.

/**
 * Values shorter than this are never redacted: replacing every occurrence of
 * a 2-character secret would shred unrelated output (false positives) while
 * providing no real secrecy anyway.
 */
export const MIN_REDACT_VALUE_LENGTH = 6;

/**
 * Replace every occurrence of each secret VALUE (length ≥ MIN) in the given
 * tool output with `[REDACTED:<NAME>]`, walking strings inside arrays/objects.
 * Returns the (possibly new) value plus whether anything changed — unchanged
 * structures are returned as-is so callers can skip rewriting the result.
 */
export function redactSecretValues(
  value: unknown,
  secrets: Record<string, string>,
): { value: unknown; changed: boolean } {
  // Longest value first so an overlapping shorter secret can't split a longer
  // one into un-redacted fragments.
  const entries = Object.entries(secrets)
    .filter(([, v]) => typeof v === "string" && v.length >= MIN_REDACT_VALUE_LENGTH)
    .sort((a, b) => b[1].length - a[1].length);
  if (entries.length === 0) {
    return { value, changed: false };
  }
  let changed = false;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      let out = node;
      for (const [name, secret] of entries) {
        if (out.includes(secret)) {
          out = out.split(secret).join(`[REDACTED:${name}]`);
          changed = true;
        }
      }
      return out;
    }
    if (Array.isArray(node)) {
      const mapped = node.map(walk);
      return mapped.some((v, i) => v !== node[i]) ? mapped : node;
    }
    if (node && typeof node === "object") {
      const src = node as Record<string, unknown>;
      let mutated = false;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(src)) {
        const w = walk(v);
        out[k] = w;
        if (w !== v) mutated = true;
      }
      return mutated ? out : node;
    }
    return node;
  };
  const result = walk(value);
  return { value: result, changed };
}
