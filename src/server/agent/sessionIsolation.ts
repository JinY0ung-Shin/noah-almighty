/**
 * Separation between concurrent CLI sessions (issue #71).
 *
 * Every live CLI registers itself in `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`
 * and listens on `<TMPDIR>/cc-socks/<pid>.sock`. With one shared config dir the
 * built-in `ListAgents` lists other users' live runs, and `SendMessage{to}` —
 * by registry name or by `uds:<socket path>` — lands in that run as a user turn
 * the model acts on, with no approval (the CLI auto-accepts a peer whose
 * permission-mode class matches, and every Noah run uses "default"). Splitting
 * the dirs does not close it: the socket path is predictable.
 *
 * The fix is receiver-side: every Noah-spawned CLI refuses inbound
 * cross-session messages. The sending side is closed too: `ListAgents` and
 * `SendMessage` (with agent teams retired) are both disallowed
 * (`UNUSED_SDK_BUILTIN_TOOLS`), so a run can neither find nor message a peer —
 * the refusal stays as the receiver-side guarantee in case a CLI version ever
 * offers another sender.
 */
export const CROSS_SESSION_SETTINGS = { crossSessionInbound: "refuse" } as const;
