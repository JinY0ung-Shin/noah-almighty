import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PiGatewayError,
  buildResponsesBody,
  piSandboxEnvOf,
  createPiResponsesClient,
  withPiRetry,
  type PiStreamEvent,
} from "../src/server/agent/pi/responsesClient.js";

// A local stand-in for pi-gateway: each test installs its own handler.
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => unknown;

let server: http.Server;
let baseUrl = "";
let handler: Handler = (_req, res) => res.end();
const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
const closed: string[] = [];

beforeEach(async () => {
  seen.length = 0;
  closed.length = 0;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.on("close", () => closed.push(req.url ?? ""));
      void handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function sse(res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  res.flushHeaders();
}
function frame(res: http.ServerResponse, type: string, payload: Record<string, unknown>, seq = 0): void {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload, sequence_number: seq })}\n\n`);
}
function errorBody(res: http.ServerResponse, status: number, error: Record<string, unknown>, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ error }));
}
async function collect(gen: AsyncGenerator<PiStreamEvent>): Promise<PiStreamEvent[]> {
  const out: PiStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const client = (extra: Partial<Parameters<typeof createPiResponsesClient>[0]> = {}) =>
  createPiResponsesClient({ baseUrl, serviceKey: "svc-key-1", ...extra });

describe("buildResponsesBody", () => {
  it("maps a first turn with images, effort, read_only, interactive, metadata and instructions", () => {
    const body = buildResponsesBody({
      user: "user-1",
      model: "m1",
      instructions: "be brief",
      reasoningEffort: "high",
      readOnly: true,
      interactive: false,
      metadata: { conversation: "c1" },
      input: { kind: "prompt", text: "look", images: [{ mediaType: "image/png", data: "AAAA" }] },
    });
    expect(body).toEqual({
      model: "m1",
      instructions: "be brief",
      stream: true,
      user: "user-1",
      reasoning: { effort: "high" },
      read_only: true,
      interactive: false,
      metadata: { conversation: "c1" },
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "look" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          ],
        },
      ],
    });
  });

  it("sends interactive only as false: the default (true or omitted) leaves pi's default", () => {
    for (const interactive of [true, undefined]) {
      expect(buildResponsesBody({ user: "u", interactive, input: { kind: "prompt", text: "hi" } })).not.toHaveProperty("interactive");
    }
  });

  it("sends model and effort on a continuing turn (pi switches the session) and function_call_output answers", () => {
    const body = buildResponsesBody({
      user: "user-1",
      model: "m2",
      reasoningEffort: "low",
      previousResponseId: "resp_x_1",
      input: { kind: "answer", callId: "call_1", output: "Blue" },
    });
    expect(body).toEqual({
      model: "m2",
      input: [{ type: "function_call_output", call_id: "call_1", output: "Blue" }],
      previous_response_id: "resp_x_1",
      stream: true,
      user: "user-1",
      reasoning: { effort: "low" },
    });
  });

  it("refuses instructions on a continuing turn, a bad user id, and an answer without a previous id", () => {
    expect(() =>
      buildResponsesBody({ user: "u", previousResponseId: "resp_x_1", instructions: "x", input: { kind: "prompt", text: "hi" } }),
    ).toThrow(PiGatewayError);
    expect(() => buildResponsesBody({ user: "bad user", input: { kind: "prompt", text: "hi" } })).toThrow(PiGatewayError);
    expect(() => buildResponsesBody({ user: "u", input: { kind: "answer", callId: "c", output: "o" } })).toThrow(PiGatewayError);
  });

  it("sends sandbox_env on any request that carries it, continuing turns and answers included", () => {
    const body = buildResponsesBody({
      user: "user-1",
      previousResponseId: "resp_x_1",
      sandboxEnv: { API_TOKEN: "v" },
      input: { kind: "answer", callId: "call_1", output: "Blue" },
    });
    expect(body.sandbox_env).toEqual({ API_TOKEN: "v" });
    expect(buildResponsesBody({ user: "u", sandboxEnv: {}, input: { kind: "prompt", text: "hi" } })).not.toHaveProperty("sandbox_env");
  });

  it("keeps only the names pi's sandbox_env admits", () => {
    const values = { API_TOKEN: "a", HTTPS_PROXY: "b", LD_PRELOAD: "c", BASH_ENV: "d", PATH: "e", NUL_VALUE: "x\0y", OTHER: "o" };
    expect(piSandboxEnvOf(values, ["API_TOKEN", "HTTPS_PROXY", "LD_PRELOAD", "BASH_ENV", "PATH", "NUL_VALUE", "MISSING"])).toEqual({
      API_TOKEN: "a",
    });
    // Past the 256 KiB budget a name is left out instead of failing the turn.
    const big = "x".repeat(200 * 1024);
    expect(Object.keys(piSandboxEnvOf({ A_KEY: big, B_KEY: big, C_KEY: "small" }, ["A_KEY", "B_KEY", "C_KEY"]))).toEqual(["A_KEY", "C_KEY"]);
  });
});

describe("stream", () => {
  it("sends the service key, extra headers and body, and yields typed events (keepalive/CRLF tolerant)", async () => {
    handler = (_req, res) => {
      sse(res);
      res.write(": keepalive\n\n");
      frame(res, "response.created", { response: { id: "resp_a_1", model: "m" } });
      res.write(`event: response.output_text.delta\r\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\r\n\r\n`);
      frame(res, "response.completed", { response: { id: "resp_a_1", status: "completed" } });
      res.end();
    };
    const events = await collect(
      client().stream({
        user: "u1",
        input: { kind: "prompt", text: "hello" },
        headers: { "x-noah-run-token": "nrt_abc", Authorization: "Bearer hijack" },
      }),
    );
    expect(events.map((e) => e.type)).toEqual(["response.created", "response.output_text.delta", "response.completed"]);
    expect(events[1]!.data.delta).toBe("hi");
    const req = seen[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/v1/responses");
    expect(req.headers.authorization).toBe("Bearer svc-key-1");
    expect(req.headers["x-noah-run-token"]).toBe("nrt_abc");
    expect(req.headers.accept).toBe("text/event-stream");
    expect(JSON.parse(req.body)).toEqual({ input: "hello", stream: true, user: "u1" });
  });

  it("maps HTTP errors onto typed, classified PiGatewayErrors", async () => {
    const cases: [number, Record<string, unknown>, string, boolean][] = [
      [404, { message: "Session for previous_response_id 'x' not found or expired", code: "404" }, "not_found", false],
      [
        409,
        { message: "This session is waiting for the user's decision on AskUserQuestion (call_id 'c').", code: "409" },
        "conflict",
        false,
      ],
      [400, { message: "bad image", type: "invalid_request_error", code: "unsupported_image_input" }, "bad_request", false],
      [503, { message: "LLM is not configured", type: "server_error", code: "llm_not_configured" }, "unavailable", false],
      [429, { message: "Backend error", code: "429" }, "rate_limited", true],
    ];
    for (const [status, error, kind, retryable] of cases) {
      handler = (_req, res) => errorBody(res, status, error);
      const err = await collect(client().stream({ user: "u1", input: { kind: "prompt", text: "x" } })).catch((e) => e);
      expect(err).toBeInstanceOf(PiGatewayError);
      expect(err.kind).toBe(kind);
      expect(err.status).toBe(status);
      expect(err.retryable).toBe(retryable);
      expect(err.code).toBe(error.code);
      // The upstream English detail never becomes the user-facing message.
      expect(err.message).not.toContain(String(error.message));
      expect(err.upstreamMessage).toBe(error.message);
    }
    handler = (_req, res) =>
      errorBody(res, 409, { message: "This session is waiting for the user's decision on AskUserQuestion", code: "409" });
    const pending = await collect(client().stream({ user: "u1", input: { kind: "prompt", text: "x" } })).catch((e) => e);
    expect(pending.isPendingQuestion).toBe(true);
    handler = (_req, res) => errorBody(res, 404, { message: "gone", code: "404" });
    const gone = await collect(client().stream({ user: "u1", previousResponseId: "resp_x_1", input: { kind: "prompt", text: "x" } })).catch(
      (e) => e,
    );
    expect(gone.isUnknownPreviousResponse).toBe(true);
  });

  it("retries 503 concurrency_limit_exceeded with the server's retry_after, then streams", async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls++;
      if (calls === 1) {
        errorBody(
          res,
          503,
          { message: "Gateway is at capacity", type: "server_overloaded", code: "concurrency_limit_exceeded", retry_after: 0.01 },
          { "retry-after": "1" },
        );
        return;
      }
      sse(res);
      frame(res, "response.completed", { response: { id: "resp_b_1", status: "completed" } });
      res.end();
    };
    const retries: number[] = [];
    const events = await collect(
      client().stream(
        { user: "u1", input: { kind: "prompt", text: "x" } },
        { retry: { attempts: 3, onRetry: (_e, _a, delay) => retries.push(delay) } },
      ),
    );
    expect(calls).toBe(2);
    expect(retries).toEqual([10]);
    expect(events.map((e) => e.type)).toEqual(["response.completed"]);
  });

  it("does not retry without a retry budget", async () => {
    handler = (_req, res) => errorBody(res, 503, { message: "cap", code: "concurrency_limit_exceeded", retry_after: 0 });
    const err = await collect(client().stream({ user: "u1", input: { kind: "prompt", text: "x" } })).catch((e) => e);
    expect(err.kind).toBe("capacity");
    expect(seen).toHaveLength(1);
  });

  it("propagates an abort to the upstream request", async () => {
    handler = (_req, res) => {
      sse(res);
      frame(res, "response.created", { response: { id: "resp_c_1" } });
    };
    const controller = new AbortController();
    const gen = client().stream({ user: "u1", input: { kind: "prompt", text: "x" } }, { signal: controller.signal });
    const first = await gen.next();
    expect(first.value?.type).toBe("response.created");
    controller.abort();
    const err = await gen.next().catch((e) => e);
    expect(err).toBeInstanceOf(PiGatewayError);
    expect(err.kind).toBe("aborted");
    await expect.poll(() => closed.length).toBe(1);
  });

  it("closes the upstream request when the consumer stops early", async () => {
    handler = (_req, res) => {
      sse(res);
      frame(res, "response.created", { response: { id: "resp_c_1" } });
    };
    for await (const e of client().stream({ user: "u1", input: { kind: "prompt", text: "x" } })) {
      expect(e.type).toBe("response.created");
      break;
    }
    await expect.poll(() => closed.length).toBe(1);
  });

  it("enforces idle and connect timeouts", async () => {
    handler = (_req, res) => {
      sse(res);
      frame(res, "response.created", { response: { id: "resp_d_1" } });
    };
    const idle = await collect(client({ idleTimeoutMs: 80 }).stream({ user: "u1", input: { kind: "prompt", text: "x" } })).catch((e) => e);
    expect(idle.kind).toBe("timeout");
    expect(idle.timeoutKind).toBe("idle");

    handler = () => undefined; // never answers
    const connect = await collect(client({ connectTimeoutMs: 80 }).stream({ user: "u1", input: { kind: "prompt", text: "x" } })).catch(
      (e) => e,
    );
    expect(connect.kind).toBe("timeout");
    expect(connect.timeoutKind).toBe("connect");
  });

  it("rejects a non-SSE success and an oversized body before sending", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    };
    const err = await collect(client().stream({ user: "u1", input: { kind: "prompt", text: "x" } })).catch((e) => e);
    expect(err.kind).toBe("protocol");
    const big = "A".repeat(17 * 1024 * 1024);
    const tooLarge = await collect(
      client().stream({ user: "u1", input: { kind: "prompt", text: "x", images: [{ mediaType: "image/png", data: big }] } }),
    ).catch((e) => e);
    expect(tooLarge.kind).toBe("too_large");
    expect(seen).toHaveLength(1);
  });

  it("fails a frame whose data is not JSON", async () => {
    handler = (_req, res) => {
      sse(res);
      res.write("event: response.created\ndata: {nope\n\n");
      res.end();
    };
    const err = await collect(client().stream({ user: "u1", input: { kind: "prompt", text: "x" } })).catch((e) => e);
    expect(err.kind).toBe("protocol");
  });
});

describe("cancel / models / files", () => {
  it("cancels with ?user= and maps 409 response_not_cancellable", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp_e_1", object: "response", status: "cancelling" }));
    };
    await expect(client().cancel("resp_e_1", "u1")).resolves.toEqual({ status: "cancelling" });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe("/v1/responses/resp_e_1/cancel?user=u1");
    expect(seen[0]!.headers.authorization).toBe("Bearer svc-key-1");

    handler = (_req, res) =>
      errorBody(res, 409, { message: "no longer in progress", type: "invalid_request_error", code: "response_not_cancellable" });
    const err = await client().cancel("resp_e_1", "u1").catch((e) => e);
    expect(err.kind).toBe("conflict");
    expect(err.code).toBe("response_not_cancellable");
  });

  it("lists models and downloads a presented file", async () => {
    handler = (req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model", owned_by: "fake", default: true }, { nope: 1 }] }));
        return;
      }
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end("# hi\n");
    };
    await expect(client({ baseUrl: `${baseUrl}/` }).listModels()).resolves.toEqual([{ id: "fake-model", ownedBy: "fake", default: true }]);
    const file = await client().fileContent("/workspace/c/conv1/report.md", "u1");
    expect(file.bytes.toString()).toBe("# hi\n");
    expect(file.contentType).toBe("text/markdown");
    expect(seen[1]!.url).toBe("/v1/files/content?path=%2Fworkspace%2Fc%2Fconv1%2Freport.md&user=u1");
  });
});

describe("withPiRetry", () => {
  it("backs off exponentially on retryable errors and stops on the attempt budget", async () => {
    const delays: number[] = [];
    let calls = 0;
    const err = await withPiRetry(
      async () => {
        calls++;
        throw new PiGatewayError("unavailable", { retryable: true });
      },
      { attempts: 3, baseDelayMs: 100, maxDelayMs: 150, sleep: async (ms) => void delays.push(ms) },
    ).catch((e) => e);
    expect(err.kind).toBe("unavailable");
    expect(calls).toBe(3);
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(50);
    expect(delays[0]).toBeLessThanOrEqual(100);
    expect(delays[1]).toBeLessThanOrEqual(150);
  });

  it("never retries a non-retryable error", async () => {
    let calls = 0;
    await withPiRetry(
      async () => {
        calls++;
        throw new PiGatewayError("bad_request");
      },
      { attempts: 5, sleep: async () => undefined },
    ).catch(() => undefined);
    expect(calls).toBe(1);
  });
});
