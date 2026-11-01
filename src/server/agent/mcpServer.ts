// Noah's builder for the in-process MCP tool servers (`agent/*Tools.ts`), on
// top of `@modelcontextprotocol/sdk`: `tool()` declares one tool and
// `createMcpToolServer()` registers them on a live `McpServer`. The zod raw
// shape is handed to `McpServer.registerTool` as-is, `annotations`/`_meta`
// ride the registration, and the handler is registered directly — so it
// receives the MCP request `extra` untouched (`extra.signal`, `extra._meta`,
// …), a thrown error becomes McpServer's own `{ isError: true }` text result
// and an argument that fails the schema is McpServer's "Input validation
// error" result. The returned `{ type: "in_process", name, instance }` is what
// the pi run endpoint (`mcpHttp/endpoint.ts`) serves and the static catalog
// (`pi/mcpCatalog.ts`) lists.
//
// zod 4 keeps ONE description registry on `globalThis`, so each field's
// `.description` reaches the listed JSON schema with no copying here.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

/** The request context McpServer passes a tool handler (abort signal, request `_meta`, session id, …). */
export type McpToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** A zod raw shape: the object-literal of field schemas a tool declares. */
export type McpToolShape = z.ZodRawShape;

/** The parsed arguments a handler receives for a shape. */
export type McpToolArgs<Schema extends McpToolShape> = z.infer<z.ZodObject<Schema>>;

/** One tool, built by `tool()` and registered by `createMcpToolServer()`. */
export type McpToolDefinition<Schema extends McpToolShape = McpToolShape> = {
  name: string;
  description: string;
  inputSchema: Schema;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  handler: (args: McpToolArgs<Schema>, extra: McpToolExtra) => Promise<CallToolResult>;
};

/** An in-process MCP server: a live `McpServer` plus the name it is mounted under. */
export type InProcessMcpServer = {
  type: "in_process";
  name: string;
  instance: McpServer;
  timeout?: number;
};

export function tool<Schema extends McpToolShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: McpToolArgs<Schema>, extra: McpToolExtra) => Promise<CallToolResult>,
  extras?: { annotations?: ToolAnnotations; searchHint?: string; alwaysLoad?: boolean },
): McpToolDefinition<Schema> {
  const meta: Record<string, unknown> = {};
  if (extras?.searchHint) meta["anthropic/searchHint"] = extras.searchHint;
  if (extras?.alwaysLoad) meta["anthropic/alwaysLoad"] = true;
  return {
    name,
    description,
    inputSchema,
    handler,
    annotations: extras?.annotations,
    _meta: Object.keys(meta).length > 0 ? meta : undefined,
  };
}

export function createMcpToolServer(options: {
  name: string;
  version?: string;
  instructions?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a server mixes tools of different shapes
  tools?: Array<McpToolDefinition<any>>;
  alwaysLoad?: boolean;
  timeout?: number;
}): InProcessMcpServer {
  const server = new McpServer(
    { name: options.name, version: options.version ?? "1.0.0" },
    { capabilities: { tools: options.tools ? {} : undefined }, instructions: options.instructions },
  );
  for (const def of options.tools ?? []) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: def.annotations,
        _meta: options.alwaysLoad ? { "anthropic/alwaysLoad": true, ...def._meta } : def._meta,
      },
      def.handler as Parameters<typeof server.registerTool>[2],
    );
  }
  const timeout =
    typeof options.timeout === "number" && Number.isInteger(options.timeout) && options.timeout > 0
      ? options.timeout
      : undefined;
  return { type: "in_process", name: options.name, instance: server, ...(timeout !== undefined && { timeout }) };
}
