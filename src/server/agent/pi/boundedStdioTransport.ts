/**
 * A stdio MCP client transport whose stdout reader holds at most ONE line of
 * {@link MCP_RELAY_MESSAGE_MAX_BYTES}.
 *
 * Noah talks MCP to the children it spawns for a relay (hex-ssh's policy proxy,
 * a bundled plugin's stdio server, the stdio↔HTTP bridge — `pi/mcpProxies.ts`,
 * and the admin connection check). The SDK's `StdioClientTransport` appends
 * every stdout chunk to one buffer until a newline arrives, so a child that
 * writes one endless line (or a remote server's huge `tools/list`/`tools/call`
 * relayed through it) would grow Noah's heap without bound — the
 * `LIST_MAX_BYTES` cap only runs once a page is fully parsed. Here a line past
 * the cap is never assembled: its bytes are dropped as they arrive and the
 * child is stopped (`close`: stdin EOF, then SIGTERM, then SIGKILL), so every
 * request waiting on it fails at once. `oversized` tells callers why, so they
 * can answer with Noah's own text.
 *
 * WHY 8 MiB: a single message is either a page of tool definitions (the
 * listing as a whole is capped at 2 MiB, `LIST_MAX_BYTES`) or one tool result,
 * and a legitimate result — a long log or file read, a base64 screenshot or
 * attachment of a few MiB — fits comfortably; past it the result could not
 * usefully reach the model anyway. The bridge (`scripts/mcp-http-bridge.mjs`)
 * enforces the same default on the remote side and answers an oversized reply
 * with its own JSON-RPC error, so through the bridge this guard is the backstop.
 *
 * The SDK keeps the buffer in the private `_readBuffer` field; the constructor
 * refuses to run if that shape changes (an SDK bump fails the relay tests
 * loudly instead of silently dropping the cap).
 */
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { deserializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** Largest single MCP message (one stdout line, one bridge reply) Noah relays. Keep `scripts/mcp-http-bridge.mjs` equal. */
export const MCP_RELAY_MESSAGE_MAX_BYTES = 8 * 1024 * 1024;

const NEWLINE = 0x0a;

/** The SDK `ReadBuffer` contract, with the pending line capped and kept as chunks (no quadratic re-concat). */
class LineCappedReadBuffer {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private lines: Buffer[] = [];
  private overflowed = false;

  constructor(
    private readonly maxLineBytes: number,
    private readonly onOverflow: () => void,
  ) {}

  append(chunk: Buffer): void {
    if (this.overflowed) return;
    let start = 0;
    while (start <= chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start);
      const end = newline === -1 ? chunk.length : newline;
      const piece = chunk.subarray(start, end);
      if (this.pendingBytes + piece.length > this.maxLineBytes) {
        this.overflow();
        return;
      }
      if (newline === -1) {
        if (piece.length > 0) {
          this.pending.push(piece);
          this.pendingBytes += piece.length;
        }
        return;
      }
      this.lines.push(this.pending.length === 0 ? piece : Buffer.concat([...this.pending, piece]));
      this.pending = [];
      this.pendingBytes = 0;
      start = newline + 1;
    }
  }

  readMessage(): JSONRPCMessage | null {
    const line = this.lines.shift();
    if (line === undefined) return null;
    return deserializeMessage(line.toString("utf8").replace(/\r$/, ""));
  }

  clear(): void {
    this.pending = [];
    this.pendingBytes = 0;
    this.lines = [];
  }

  private overflow(): void {
    this.overflowed = true;
    this.clear();
    this.onOverflow();
  }
}

export class BoundedStdioClientTransport extends StdioClientTransport {
  private tooLarge = false;

  constructor(
    server: StdioServerParameters,
    readonly maxMessageBytes: number = MCP_RELAY_MESSAGE_MAX_BYTES,
  ) {
    super(server);
    const internals = this as unknown as { _readBuffer?: { append?: unknown; readMessage?: unknown; clear?: unknown } };
    const current = internals._readBuffer;
    if (typeof current?.append !== "function" || typeof current.readMessage !== "function" || typeof current.clear !== "function") {
      throw new Error(
        "BoundedStdioClientTransport: the MCP SDK's StdioClientTransport no longer keeps its stdout buffer in `_readBuffer`; re-check the line cap after this SDK bump",
      );
    }
    internals._readBuffer = new LineCappedReadBuffer(maxMessageBytes, () => this.overflowed());
  }

  /** The child wrote a line past the cap and was stopped. */
  get oversized(): boolean {
    return this.tooLarge;
  }

  private overflowed(): void {
    if (this.tooLarge) return;
    this.tooLarge = true;
    this.onerror?.(new Error(`the MCP server wrote a single message larger than ${this.maxMessageBytes} bytes; stopping it`));
    void this.close().catch(() => undefined);
  }
}
