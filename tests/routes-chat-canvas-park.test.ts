// Regression pin: while a blocking canvas is PARKED (run awaiting the user's
// /api/chat/respond), a LATE-attaching /api/chat/runs/:id/events client — a
// user returning to the conversation — must receive the canvas frame with
// controls + requestId + runId via the event-journal replay. This is the only
// path that restores the canvas form after a conversation switch: a parked
// canvas is NOT in the canvas tables yet (record() runs on resolve), so if the
// replay ever drops the frame the selection buttons vanish for good.
import http from "node:http";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AgentRequest, AgentResponse, AppConfig } from "../src/server/types.js";
import type { AgentEvents } from "../src/server/agent/events.js";
import { signup, withTempDir } from "./helpers.js";

type RunImpl = (
  request: AgentRequest,
  pluginRoots: unknown,
  config: AppConfig,
  store: unknown,
  events: AgentEvents,
  abortController: AbortController,
) => Promise<AgentResponse>;

const H = vi.hoisted(() => ({
  impl: null as RunImpl | null,
}));

vi.mock("../src/server/agent/index.js", () => ({
  runAgentStream: vi.fn(
    async (
      agentRequest: AgentRequest,
      pluginRoots: unknown,
      config: AppConfig,
      store: unknown,
      events: AgentEvents,
      abortController: AbortController,
    ): Promise<AgentResponse> => {
      if (H.impl) return H.impl(agentRequest, pluginRoots, config, store, events, abortController);
      events.onDelta?.("[mock]");
      return { kind: "text", runtime: config.agentRuntime, summary: "mock", text: "[mock]" };
    },
  ),
  isRetryableModelError: vi.fn(() => false),
}));

import { createApp, createServices } from "../src/server/app.js";

let tempDir: string;
const getTempDir = withTempDir("canvas-park-repro", () => {
  tempDir = getTempDir();
  H.impl = null;
});

function boot() {
  const services = createServices({ dataDir: tempDir, agentRuntime: "pi", pi: { gatewayUrl: "http://pi.invalid", apiKey: "k", modelMap: {}, deckSandbox: false }, sessionSecret: "test" });
  return { services, app: createApp(services), store: services.store };
}

function cookieOf(res: request.Response): string {
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return arr.map((c) => c.split(";")[0]).join("; ");
}

interface SseFrame {
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

function parseFrameBlock(block: string): SseFrame | null {
  let event = "";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!event) return null;
  return { event, data: data ? JSON.parse(data) : undefined };
}

function streamRaw(
  port: number,
  cookie: string,
  path: string,
  method: "POST" | "GET",
  body: object | null,
  onFrame: (f: SseFrame) => void,
): Promise<{ status: number; frames: SseFrame[] }> {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        agent: false,
        headers: {
          cookie,
          ...(payload != null
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const frames: SseFrame[] = [];
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const frame = parseFrameBlock(block);
            if (frame) {
              frames.push(frame);
              onFrame(frame);
            }
          }
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, frames }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

function postJson(
  port: number,
  cookie: string,
  path: string,
  body: object,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        agent: false,
        headers: { cookie, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : undefined }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function withServer(
  app: ReturnType<typeof createApp>,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function waitUntil(pred: () => boolean | Promise<boolean>, label = "condition"): Promise<void> {
  for (let i = 0; i < 1600; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitUntil timed out: ${label}`);
}

describe("parked blocking canvas — server replay for a late attach", () => {
  it(
    "delivers the canvas frame (controls + requestId) to a client attaching mid-park",
    async () => {
      const { app } = boot();
      const owner = request.agent(app);
      const res = await signup(owner, "parkcv").expect(201);
      const ownerId = res.body.user.id as string;
      const cookie = cookieOf(res);

      H.impl = async (_req, _pr, config, _store, events) => {
        const result = await events.onCanvas!({
          artifactId: "cv-park",
          title: "질문",
          content: "고르세요",
          contentType: "markdown",
          controls: [
            { type: "buttons", id: "pick", options: [{ label: "A" }, { label: "B" }] },
          ],
          awaitInput: true,
          interaction: "blocking",
          editable: false,
        } as never);
        return {
          kind: "text",
          runtime: config.agentRuntime,
          summary: "done",
          text: `결과: ${JSON.stringify(result)}`,
        };
      };

      await withServer(app, async (port) => {
        const postPromise = streamRaw(
          port,
          cookie,
          "/api/chat/stream",
          "POST",
          { avatarId: ownerId, conversationId: "conv-cvpark", message: "질문해줘" },
          () => {},
        );

        // Wait for the park (pending prompt registered), as the run registry sees it.
        let runId = "";
        await waitUntil(async () => {
          const r = await owner.get("/api/chat/runs?conversationId=conv-cvpark");
          const run = r.body.run as { runId: string; pendingCount: number } | null;
          if (run && run.pendingCount > 0) {
            runId = run.runId;
            return true;
          }
          return false;
        }, "run parked on canvas");

        // Late attach — the returning client's replay read.
        let canvasFrame: SseFrame | null = null;
        const answered: Promise<{ status: number }>[] = [];
        const attach = await streamRaw(
          port,
          cookie,
          `/api/chat/runs/${runId}/events`,
          "GET",
          null,
          (f) => {
            if (f.event === "canvas" && !canvasFrame) {
              canvasFrame = f;
              // Answer so the park resolves and both streams can end.
              answered.push(
                postJson(port, cookie, "/api/chat/respond", {
                  runId,
                  requestId: f.data.requestId,
                  value: { values: { pick: "A" } },
                }),
              );
            }
          },
        );
        await postPromise;
        for (const a of await Promise.all(answered)) expect(a.status).toBe(200);

        expect(attach.status).toBe(200);
        expect(canvasFrame, "replay must contain the canvas frame").toBeTruthy();
        expect(canvasFrame!.data).toMatchObject({
          artifactId: "cv-park",
          runId,
          interaction: "blocking",
        });
        expect(typeof canvasFrame!.data.requestId).toBe("string");
        expect(canvasFrame!.data.controls?.length).toBe(1);
      });
    },
    20_000,
  );
});
