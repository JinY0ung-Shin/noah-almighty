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
 * cross-session messages. In-run agent teams are unaffected — a named
 * subagent lives in the SAME CLI process and is reached through its mailbox,
 * not a peer socket. `ListAgents` is also disallowed
 * (`UNUSED_SDK_BUILTIN_TOOLS`).
 */
export const CROSS_SESSION_SETTINGS = { crossSessionInbound: "refuse" } as const;
