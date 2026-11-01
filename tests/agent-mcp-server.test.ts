/**
 * Noah's in-process MCP server builder (`agent/mcpServer.ts`), which replaced
 * the Claude Agent SDK's `tool()` / `createMcpToolServer()`: the listing, the
 * call path, thrown errors, schema refusals, the abort signal and the request
 * `_meta` must behave exactly as the SDK's did (the listing bytes themselves
 * are pinned by sdk-pin.test.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpToolServer, text, tool, type McpToolExtra } from "../src/server/agent/mcpTools.js";

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect(server: ReturnType<typeof createMcpToolServer>): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  return client;
}

function build(seen: { extra?: McpToolExtra; aborted?: () => void } = {}) {
  return createMcpToolServer({
    name: "demo",
    version: "0.1.0",
    tools: [
      // Arguments with field descriptions; echoes the request `_meta` it was handed.
      tool(
        "echo",
        "Echo the message.",
        { message: z.string().describe("What to echo."), times: z.number().int().min(1).max(3).optional() },
        async (args, extra) => {
          seen.extra = extra;
          return text(`${args.message.repeat(args.times ?? 1)} ${String(extra._meta?.["claudecode/toolUseId"] ?? "-")}`);
        },
      ),
      // No arguments; a thrown error.
      tool("fail", "Always throws.", {}, async () => {
        throw new Error("boom");
      }),
      // Annotations + search hint; parks until the call is cancelled.
      tool(
        "wait",
        "Wait for cancellation.",
        {},
        (_args, extra) =>
          new Promise((resolve) => {
            extra.signal.addEventListener("abort", () => {
              seen.aborted?.();
              resolve(text("aborted", true));
            });
          }),
        { annotations: { readOnlyHint: true }, searchHint: "pause", alwaysLoad: true },
      ),
    ],
  });
}

describe("in-process MCP server builder", () => {
  it("returns the shape the pi endpoint and the SDK runner consume", () => {
    const server = build();
    expect(server.type).toBe("in_process");
    expect(server.name).toBe("demo");
    expect(server).not.toHaveProperty("timeout");
    const timed = createMcpToolServer({ name: "t", tools: [], timeout: 5000 });
    expect(timed.timeout).toBe(5000);
    for (const bad of [0, -1, 1.5]) expect(createMcpToolServer({ name: "t", timeout: bad })).not.toHaveProperty("timeout");
  });

  it("tool() keeps annotations and maps the extras onto _meta", () => {
    const plain = tool("a", "A.", {}, async () => text("ok"));
    expect(plain.annotations).toBeUndefined();
    expect(plain._meta).toBeUndefined();
    const hinted = tool("b", "B.", {}, async () => text("ok"), { annotations: { destructiveHint: true }, searchHint: "find", alwaysLoad: true });
    expect(hinted.annotations).toEqual({ destructiveHint: true });
    expect(hinted._meta).toEqual({ "anthropic/searchHint": "find", "anthropic/alwaysLoad": true });
  });

  it("lists every tool with its JSON schema, annotations and _meta", async () => {
    const c = await connect(build());
    expect(c.getServerVersion()).toEqual({ name: "demo", version: "0.1.0" });
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo", "fail", "wait"]);
    const [echo, fail, wait] = tools;
    expect(echo.description).toBe("Echo the message.");
    expect(echo.inputSchema).toEqual({
      type: "object",
      properties: {
        message: { type: "string", description: "What to echo." },
        times: { type: "integer", minimum: 1, maximum: 3 },
      },
      required: ["message"],
      $schema: "http://json-schema.org/draft-07/schema#",
    });
    expect(echo.annotations).toBeUndefined();
    expect(echo._meta).toBeUndefined();
    expect(fail.inputSchema).toMatchObject({ type: "object", properties: {} });
    expect(wait.annotations).toEqual({ readOnlyHint: true });
    expect(wait._meta).toEqual({ "anthropic/searchHint": "pause", "anthropic/alwaysLoad": true });
  });

  it("server-level alwaysLoad marks every tool, merged under the tool's own _meta", async () => {
    const c = await connect(
      createMcpToolServer({
        name: "eager",
        alwaysLoad: true,
        tools: [tool("x", "X.", {}, async () => text("ok")), tool("y", "Y.", {}, async () => text("ok"), { searchHint: "why" })],
      }),
    );
    const { tools } = await c.listTools();
    expect(c.getServerVersion()?.version).toBe("1.0.0");
    expect(tools.map((t) => t._meta)).toEqual([
      { "anthropic/alwaysLoad": true },
      { "anthropic/alwaysLoad": true, "anthropic/searchHint": "why" },
    ]);
  });

  it("calls a handler with parsed arguments and the request _meta in extra", async () => {
    const seen: { extra?: McpToolExtra } = {};
    const c = await connect(build(seen));
    const result = await c.callTool({ name: "echo", arguments: { message: "hi", times: 2 }, _meta: { "claudecode/toolUseId": "toolu_1" } });
    expect(result).toEqual({ content: [{ type: "text", text: "hihi toolu_1" }], isError: false });
    expect(seen.extra?._meta).toMatchObject({ "claudecode/toolUseId": "toolu_1" });
    expect(seen.extra?.signal.aborted).toBe(false);
  });

  it("turns a thrown error into an isError text result", async () => {
    const c = await connect(build());
    expect(await c.callTool({ name: "fail", arguments: {} })).toEqual({ content: [{ type: "text", text: "boom" }], isError: true });
  });

  it("refuses arguments that fail the schema without running the handler", async () => {
    const seen: { extra?: McpToolExtra } = {};
    const c = await connect(build(seen));
    const result = (await c.callTool({ name: "echo", arguments: { message: 5 } })) as { content: { text: string }[]; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^MCP error -32602: Input validation error: Invalid arguments for tool echo:/);
    expect(seen.extra).toBeUndefined();
    const unknown = (await c.callTool({ name: "nope", arguments: {} })) as { content: { text: string }[]; isError: boolean };
    expect(unknown).toEqual({ content: [{ type: "text", text: "MCP error -32602: Tool nope not found" }], isError: true });
  });

  it("aborts the handler's signal when the call is cancelled", async () => {
    let aborted!: () => void;
    const abortedSeen = new Promise<void>((resolve) => (aborted = resolve));
    const c = await connect(build({ aborted }));
    const controller = new AbortController();
    const call = c.callTool({ name: "wait", arguments: {} }, CallToolResultSchema, { signal: controller.signal });
    // Let the request reach the handler before cancelling it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort("stop");
    await expect(call).rejects.toBeDefined();
    await abortedSeen;
  });
});
