import { createSdkMcpServer, tool } from "./mcpServer.js";
import { z } from "zod";
import type { Store } from "../store.js";
import { text } from "./mcpTools.js";

/** Per-conversation context the knowledge tools act within. */
export interface KnowledgeToolsContext {
  /** The avatar (== owner user) whose gap inbox these tools touch. */
  avatarUserId: string;
  /** True when the current viewer is the avatar's owner. */
  viewerIsOwner: boolean;
  /** The colleague currently chatting (for attributing requests). */
  askerUserId?: string | null;
  askerName?: string | null;
}

/** MCP server name; tools surface to the model as `mcp__knowledge__<tool>`. */
export const KNOWLEDGE_SERVER_NAME = "knowledge";

/** Tool names the model may call, in `allowedTools` form. */
export const KNOWLEDGE_TOOL_NAMES = [
  "mcp__knowledge__request_info",
  "mcp__knowledge__pending_requests",
  "mcp__knowledge__resolve_request",
] as const;

const OWNER_ONLY = "This tool can only be used by the avatar owner.";

/**
 * Build the knowledge-backfill tool definitions bound to a single
 * conversation's store + context. Exposed separately from the server so the
 * handlers can be exercised directly in tests. Owner-only tools are enforced
 * here (the model can call them, but a non-owner gets a refusal result).
 */
export function buildKnowledgeTools(store: Store, ctx: KnowledgeToolsContext) {
  return [
      tool(
        "request_info",
        "Records, as a request to relay to the owner, information that only the owner would likely know — when another user asked something the avatar could not answer. This is not a box for the avatar's own questions to the owner.",
        { question: z.string().describe("A one-sentence question with enough context for the owner to answer") },
        async (args) => {
          // INTENTIONALLY NOT self-gated (unlike the two sibling tools): a
          // non-owner viewer filing a question FOR the owner is this tool's whole
          // purpose. The write lands only in the owner's own inbox and is deduped
          // byte-identical (store.addKnowledgeRequest), so it is not an abuse surface.
          const req = store.addKnowledgeRequest(ctx.avatarUserId, {
            question: args.question,
            askerUserId: ctx.askerUserId ?? null,
            askerName: ctx.askerName ?? null,
          });
          return text(`Relayed the information request to the owner. (request id: ${req.id})`);
        },
      ),
      tool(
        "pending_requests",
        "Retrieves the list of information requests relayed to the owner that have not yet been answered. (owner only)",
        {},
        async () => {
          if (!ctx.viewerIsOwner) {
            return text(OWNER_ONLY, true);
          }
          const open = store.listKnowledgeRequests(ctx.avatarUserId, "open");
          if (open.length === 0) {
            return text("There are no pending information requests.");
          }
          const body = open
            .map(
              (r, i) =>
                `${i + 1}. (id: ${r.id}) ${r.question}${r.askerName ? ` — asker: ${r.askerName}` : ""}`,
            )
            .join("\n");
          return text(`${open.length} pending information request(s):\n${body}`);
        },
      ),
      tool(
        "resolve_request",
        "Closes a pending information request as resolved. When the owner says they've 'handled' / 'ignore' / 'skip' / 'don't need' a specific request, call this with that request's id. (owner only)",
        { request_id: z.string().describe("id of the information request to close (obtained from pending_requests)") },
        async (args) => {
          if (!ctx.viewerIsOwner) {
            return text(OWNER_ONLY, true);
          }
          const resolved = store.resolveKnowledgeRequest(ctx.avatarUserId, args.request_id);
          if (!resolved) {
            return text(
              `Could not find request id ${args.request_id}. (It may already be resolved or no longer pending.)`,
              true,
            );
          }
          return text(`Closed the information request as resolved. (id: ${args.request_id})`);
        },
      ),
  ];
}

/**
 * Build the in-process MCP server exposing the knowledge-backfill tools, bound
 * to a single conversation's store + context.
 */
export function buildKnowledgeServer(store: Store, ctx: KnowledgeToolsContext) {
  return createSdkMcpServer({
    name: KNOWLEDGE_SERVER_NAME,
    version: "0.1.0",
    tools: buildKnowledgeTools(store, ctx),
  });
}
