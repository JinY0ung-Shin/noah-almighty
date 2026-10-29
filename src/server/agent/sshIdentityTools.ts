import { createSdkMcpServer, tool } from "./mcpServer.js";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AgentOwner } from "../types.js";
import { generateSshKeyPair } from "../sshIdentity.js";
import { text } from "./mcpTools.js";

export interface SshIdentityToolsContext {
  /** The avatar (== owner) whose SSH identity is managed. */
  avatarUserId: string;
  /** The avatar owner, used only for key comments and audit attribution. */
  owner: AgentOwner;
  /** True only when the present viewer IS the owner and the run is interactive. */
  viewerIsOwner: boolean;
}

export const SSH_IDENTITY_SERVER_NAME = "ssh_identity";

export const SSH_IDENTITY_TOOL_NAMES = [
  "mcp__ssh_identity__show_public_key",
  "mcp__ssh_identity__generate_key",
] as const;

const OWNER_ONLY = "This tool can only be used in conversations where the avatar owner is present.";

function defaultComment(ctx: SshIdentityToolsContext): string {
  return `avatar-chat-${ctx.owner.username || ctx.avatarUserId}`;
}

export function buildSshIdentityTools(store: Store, ctx: SshIdentityToolsContext) {
  return [
    tool(
      "show_public_key",
      "Show the stored SSH public key. Never returns the private key. (owner only)",
      {},
      async () => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const publicKey = store.getUserById(ctx.avatarUserId)?.sshPublicKey?.trim();
        if (!publicKey) {
          return text("No stored SSH public key. You can create a new key with generate_key.");
        }
        return text(`Stored SSH public key:\n${publicKey}`);
      },
    ),
    tool(
      "generate_key",
      "Generate a new Ed25519 SSH key pair, store the private key encrypted as the SSH_PRIVATE_KEY secret, and return only the public key. Does not overwrite an existing SSH key. (owner only)",
      {
        comment: z.string().max(80).optional().describe("A short comment to append to the end of the public key"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const user = store.getUserById(ctx.avatarUserId);
        const secretNames = store.listUserSecretNames(ctx.avatarUserId);
        if (secretNames.includes("SSH_PRIVATE_KEY") || user?.sshPublicKey) {
          const publicKey = user?.sshPublicKey?.trim();
          return text(
            publicKey
              ? `An SSH key is already configured. Existing public key:\n${publicKey}`
              : "The SSH_PRIVATE_KEY secret is already configured. To create a new key, first delete the existing SSH_PRIVATE_KEY in settings.",
            true,
          );
        }

        let pair: Awaited<ReturnType<typeof generateSshKeyPair>>;
        try {
          pair = await generateSshKeyPair(args.comment || defaultComment(ctx));
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return text(`Could not generate the SSH key: ${msg}`, true);
        }
        store.setSshKeyPair(ctx.avatarUserId, pair.privateKey, pair.publicKey);
        store.audit({
          actorUserId: ctx.owner.id,
          actorName: ctx.owner.username,
          action: "ssh_identity_generate_key",
          status: "ok",
          detail: JSON.stringify({ fingerprint: pair.fingerprint }),
        });
        return text(
          `Generated and stored an SSH key. The private key is stored as the SSH_PRIVATE_KEY secret and will not be shown again.\n` +
            `Fingerprint: ${pair.fingerprint}\n` +
            `Public key:\n${pair.publicKey}`,
        );
      },
    ),
  ];
}

export function buildSshIdentityServer(store: Store, ctx: SshIdentityToolsContext) {
  return createSdkMcpServer({
    name: SSH_IDENTITY_SERVER_NAME,
    version: "0.1.0",
    tools: buildSshIdentityTools(store, ctx),
  });
}
