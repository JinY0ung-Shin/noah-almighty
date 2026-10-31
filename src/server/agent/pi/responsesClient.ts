/**
 * HTTP + SSE client for Noah's dedicated pi-gateway (`POST /v1/responses`, the
 * OpenAI-Responses-compatible agent loop) — design §4/§6 N3.
 *
 * Contract (pi-gateway `apps/gateway/src/api/{responses,request,sse,files}.ts`):
 * - Auth is the SERVICE key (`Authorization: Bearer …`); every call names the
 *   principal in `user` (body for POST, `?user=` for GET/cancel). pi trusts it.
 * - A turn continues a session by `previous_response_id` (`resp_<uuid>_<turn>`).
 *   `instructions` is accepted ONLY on the first turn (a session's system prompt
 *   is fixed — design D2). `reasoning.effort` is fixed at session creation too
 *   (a DIFFERENT value on a later turn is a 400).
 * - Errors are `{error: {message, type, code, …}}`. 503 `concurrency_limit_exceeded`
 *   (pi's turn limiter, after ≤120 s of queueing) carries `retry_after` + a
 *   `retry-after` header and is safe to retry: no turn ran.
 * - The stream starts only AFTER pi acquired its limiter slot, the session lock
 *   and a live session (sandbox + MCP connections), so the "connect" phase can
 *   legitimately take minutes — hence the generous default connect timeout.
 *
 * This module knows nothing about Noah's AgentEvents; `eventAdapter.ts` maps the
 * frames. User-facing error text is Korean (language split); the upstream
 * English detail rides `upstreamMessage` for logs only.
 */

const MAX_SSE_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;
/** pi-gateway's Fastify `bodyLimit` (server.ts). Larger bodies are a 413 there; fail before sending. */
export const PI_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
/** pi's MAX_PRESENT_BYTES (= remote-fs MAX_READ_BYTES): `/v1/files/content` never serves more. */
export const PI_MAX_FILE_BYTES = 32 * 1024 * 1024;
/** pi's USER_ID_PATTERN (packages/shared/src/user-key.ts). */
export const PI_USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
/** pi's REASONING_EFFORTS (agent/runtime.ts). */
export const PI_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiReasoningEffort = (typeof PI_REASONING_EFFORTS)[number];

export const PI_DEFAULT_CONNECT_TIMEOUT_MS = 180_000;
/** pi writes a `: keepalive` comment every SSE_KEEPALIVE_SECONDS (15 s default), so 120 s of silence is a dead link. */
export const PI_DEFAULT_IDLE_TIMEOUT_MS = 120_000;
export const PI_DEFAULT_TOTAL_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface PiGatewayConfig {
  /** Gateway origin (+ optional path prefix), e.g. `http://pi-gateway:8080`. */
  baseUrl: string;
  /** Service key; never logged, never sent anywhere but `baseUrl`. */
  serviceKey: string;
  /** Until response headers arrive (includes pi's limiter queue + session open). */
  connectTimeoutMs?: number;
  /** Max silence between stream bytes (keepalive comments count as activity). */
  idleTimeoutMs?: number;
  /** Hard cap on one streamed response. */
  totalTimeoutMs?: number;
  /** Timeout of the small JSON calls (cancel, models, files). */
  requestTimeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface PiInputImage {
  /** e.g. `image/png`. pi re-sniffs the bytes and rejects a mismatch (`invalid_image`). */
  mediaType: string;
  /** Base64 payload (no `data:` prefix). */
  data: string;
}

export type PiTurnInput =
  | { kind: "prompt"; text: string; images?: PiInputImage[] }
  /** The answer to a pending AskUserQuestion (`requires_action`). pi feeds it as `User responded: <output>`. */
  | { kind: "answer"; callId: string; output: string };

export interface PiResponseRequest {
  /** pi principal = the Noah user id of whoever the run executes AS (design §2). */
  user: string;
  input: PiTurnInput;
  /** New sessions only; continuing turns always use the session's model. */
  model?: string;
  /** New sessions only (pi 400s it together with previous_response_id). */
  instructions?: string;
  previousResponseId?: string;
  reasoningEffort?: PiReasoningEffort;
  /**
   * New sessions only: pi's `read_only` (P1) — the session gets no `write`,
   * `edit`, `bash` or sandbox-run MCP servers, for its whole life (pi 400s a
   * different value on a later turn). `PiRuntimeFacts.readOnlyBuiltins`.
   */
  readOnly?: boolean;
  /**
   * EVERY request of an owner run: pi's `sandbox_env` (P4) — env vars of that
   * request's `bash` commands, kept only in pi's memory for that request, so
   * it is re-sent each turn (an AskUserQuestion answer included). Only valid
   * with the service key. Build it with {@link piSandboxEnvOf}.
   */
  sandboxEnv?: Record<string, string>;
  /** String map; pi forwards only the keys listed in its MCP_METADATA_KEYS to MCP servers. */
  metadata?: Record<string, string>;
  /**
   * Extra request headers (e.g. `x-noah-run-token`). pi forwards only the names
   * its MCP registry declares (`{{ctx.header:…}}`) to the broker. `authorization`,
   * `content-type` and `accept` are reserved and cannot be overridden here.
   */
  headers?: Record<string, string>;
}

export type PiGatewayErrorKind =
  | "bad_request"
  | "auth"
  | "not_found"
  | "conflict"
  | "too_large"
  | "rate_limited"
  | "capacity"
  | "unavailable"
  | "server"
  | "timeout"
  | "network"
  | "protocol"
  | "aborted";

const KIND_MESSAGES: Record<PiGatewayErrorKind, string> = {
  bad_request: "pi-gateway가 요청을 거절했습니다.",
  auth: "pi-gateway 인증에 실패했습니다.",
  not_found: "pi-gateway에서 이전 응답을 찾지 못했습니다.",
  conflict: "pi-gateway 대화 상태가 요청과 맞지 않습니다.",
  too_large: "pi-gateway 요청이 허용 크기를 초과했습니다.",
  rate_limited: "pi-gateway 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  capacity: "pi-gateway가 동시에 처리할 수 있는 실행 수를 초과했습니다. 잠시 후 다시 시도해 주세요.",
  unavailable: "pi-gateway를 지금 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.",
  server: "pi-gateway 내부 오류가 발생했습니다.",
  timeout: "pi-gateway 응답 대기 시간이 초과되었습니다.",
  network: "pi-gateway에 연결하지 못했습니다.",
  protocol: "pi-gateway 응답 형식이 올바르지 않습니다.",
  aborted: "pi-gateway 요청이 취소되었습니다.",
};

export class PiGatewayError extends Error {
  readonly kind: PiGatewayErrorKind;
  /** HTTP status, when the failure was an HTTP response. */
  readonly status?: number;
  /** pi's `error.code` (e.g. `concurrency_limit_exceeded`, `unsupported_image_input`, `response_not_cancellable`). */
  readonly code?: string;
  /** pi's `error.type`. */
  readonly type?: string;
  /** Safe to re-send the SAME request (no turn ran / nothing was committed). */
  readonly retryable: boolean;
  /** Server-advised wait before a retry. */
  readonly retryAfterMs?: number;
  /** Upstream English detail — logs only, never shown to a user verbatim. */
  readonly upstreamMessage?: string;
  /** For timeouts: which deadline fired. */
  readonly timeoutKind?: "connect" | "idle" | "total";

  constructor(
    kind: PiGatewayErrorKind,
    init: {
      message?: string;
      status?: number;
      code?: string;
      type?: string;
      retryable?: boolean;
      retryAfterMs?: number;
      upstreamMessage?: string;
      timeoutKind?: "connect" | "idle" | "total";
      cause?: unknown;
    } = {},
  ) {
    super(init.message ?? KIND_MESSAGES[kind], init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "PiGatewayError";
    this.kind = kind;
    this.status = init.status;
    this.code = init.code;
    this.type = init.type;
    this.retryable = init.retryable ?? false;
    this.retryAfterMs = init.retryAfterMs;
    this.upstreamMessage = init.upstreamMessage;
    this.timeoutKind = init.timeoutKind;
  }

  /** 404 on `previous_response_id`: the pi session expired/was lost — self-heal from the stored text history. */
  get isUnknownPreviousResponse(): boolean {
    return this.kind === "not_found";
  }

  /** 409 because the session waits for an AskUserQuestion answer (`function_call_output`). */
  get isPendingQuestion(): boolean {
    return this.kind === "conflict" && /waiting for the user's decision/i.test(this.upstreamMessage ?? "");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function retryAfterMs(header: string | null, body: Record<string, unknown> | undefined): number | undefined {
  const fromBody = body && typeof body.retry_after === "number" ? body.retry_after : undefined;
  const raw = fromBody ?? (header !== null && header.trim() !== "" ? Number(header) : undefined);
  if (raw === undefined || !Number.isFinite(raw) || raw < 0) return undefined;
  return Math.round(raw * 1000);
}

/** Map a non-2xx pi response onto a typed error (the body is read capped, never surfaced as `.message`). */
export async function piErrorFromResponse(response: Response): Promise<PiGatewayError> {
  let parsed: Record<string, unknown> | undefined;
  try {
    const text = await readCapped(response, MAX_ERROR_BODY_BYTES);
    const json: unknown = text ? JSON.parse(text) : undefined;
    if (isRecord(json) && isRecord(json.error)) parsed = json.error;
  } catch {
    parsed = undefined;
  }
  const status = response.status;
  const code = parsed && parsed.code !== undefined ? String(parsed.code) : undefined;
  const type = typeof parsed?.type === "string" ? parsed.type : undefined;
  const upstreamMessage = typeof parsed?.message === "string" ? parsed.message.slice(0, 1000) : undefined;
  const after = retryAfterMs(response.headers.get("retry-after"), parsed);
  const base = { status, code, type, upstreamMessage, retryAfterMs: after };
  if (status === 400 || status === 422) return new PiGatewayError("bad_request", base);
  if (status === 401 || status === 403) return new PiGatewayError("auth", base);
  if (status === 404) return new PiGatewayError("not_found", base);
  if (status === 409) return new PiGatewayError("conflict", base);
  if (status === 413) return new PiGatewayError("too_large", base);
  if (status === 429) return new PiGatewayError("rate_limited", { ...base, retryable: true });
  if (status === 503) {
    if (code === "concurrency_limit_exceeded") return new PiGatewayError("capacity", { ...base, retryable: true });
    // `llm_not_configured` is an operator problem; retrying cannot fix it.
    if (code === "llm_not_configured") return new PiGatewayError("unavailable", base);
    // Shutting down / session could not be started: pi says "retry shortly".
    return new PiGatewayError("unavailable", { ...base, retryable: true });
  }
  if (status === 502 || status === 504) return new PiGatewayError("server", { ...base, retryable: true });
  return new PiGatewayError("server", base);
}

async function readCapped(response: Response, limit: number): Promise<string> {
  const buffer = await readCappedBytes(response, limit);
  return buffer.toString("utf8");
}

async function readCappedBytes(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new PiGatewayError("too_large", { message: "pi-gateway 응답이 허용 크기를 초과했습니다." });
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined);
        throw new PiGatewayError("too_large", { message: "pi-gateway 응답이 허용 크기를 초과했습니다." });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

// ---- SSE frames -----------------------------------------------------------

export interface SseFrame {
  event: string;
  data: string;
}

function parseFrame(block: string): SseFrame | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length && event === "message") return null;
  return { event, data: data.join("\n") };
}

/**
 * Split an SSE byte stream into frames (adapted from the external-avatar reader).
 * Abort must interrupt a PENDING read deterministically — relying on undici to
 * reject an in-flight `reader.read()` when the request signal aborts is a race it
 * sometimes loses — so each read is raced against the signal explicitly.
 */
export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  let onAbort: (() => void) | undefined;
  const abortedForever: Promise<never> | undefined = signal
    ? new Promise<never>((_, reject) => {
        const rejectWithReason = () =>
          reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted")));
        if (signal.aborted) {
          rejectWithReason();
          return;
        }
        onAbort = rejectWithReason;
        signal.addEventListener("abort", rejectWithReason, { once: true });
      })
    : undefined;
  abortedForever?.catch(() => undefined);
  try {
    while (true) {
      const { done, value } = abortedForever ? await Promise.race([reader.read(), abortedForever]) : await reader.read();
      if (done) {
        finished = true;
        buffer += decoder.decode();
      } else {
        if (value.byteLength > 0) onActivity?.();
        buffer += decoder.decode(value, { stream: true });
      }
      buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        if (Buffer.byteLength(block, "utf8") > MAX_SSE_FRAME_BYTES) {
          throw new PiGatewayError("protocol", { message: "pi-gateway 스트림 이벤트가 허용 크기를 초과했습니다." });
        }
        buffer = buffer.slice(boundary + 2);
        const frame = parseFrame(block);
        if (frame) yield frame;
        boundary = buffer.indexOf("\n\n");
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_FRAME_BYTES) {
        throw new PiGatewayError("protocol", { message: "pi-gateway 스트림 이벤트가 허용 크기를 초과했습니다." });
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const frame = parseFrame(buffer);
      if (frame) yield frame;
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

// ---- Stream events ----------------------------------------------------------

/**
 * One decoded pi SSE event. `type` mirrors the SSE `event:` name (pi writes the
 * same value into the JSON's `type`), `data` is the whole JSON object (incl.
 * `sequence_number`). The adapter narrows per type.
 */
export interface PiStreamEvent {
  type: string;
  data: Record<string, unknown>;
}

// ---- Request body -----------------------------------------------------------

export function buildResponsesBody(request: PiResponseRequest): Record<string, unknown> {
  if (!PI_USER_ID_PATTERN.test(request.user)) {
    throw new PiGatewayError("bad_request", { message: "pi-gateway에 보낼 사용자 id 형식이 올바르지 않습니다." });
  }
  if (request.previousResponseId && request.instructions) {
    // pi rejects this (system prompt is fixed per session, design D2); fail before the round trip.
    throw new PiGatewayError("bad_request", {
      message: "이어지는 pi-gateway 턴에는 시스템 지시를 보낼 수 없습니다.",
    });
  }
  if (request.input.kind === "answer" && !request.previousResponseId) {
    throw new PiGatewayError("bad_request", { message: "질문 답변에는 이전 응답 id가 필요합니다." });
  }
  let input: unknown;
  if (request.input.kind === "answer") {
    input = [{ type: "function_call_output", call_id: request.input.callId, output: request.input.output }];
  } else {
    const images = request.input.images ?? [];
    if (!images.length) {
      input = request.input.text;
    } else {
      const content: Record<string, unknown>[] = [];
      if (request.input.text) content.push({ type: "input_text", text: request.input.text });
      for (const image of images) {
        content.push({ type: "input_image", image_url: `data:${image.mediaType};base64,${image.data}` });
      }
      input = [{ type: "message", role: "user", content }];
    }
  }
  return {
    ...(request.model && !request.previousResponseId ? { model: request.model } : {}),
    input,
    ...(request.instructions ? { instructions: request.instructions } : {}),
    ...(request.previousResponseId ? { previous_response_id: request.previousResponseId } : {}),
    stream: true,
    user: request.user,
    ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
    ...(request.readOnly ? { read_only: true } : {}),
    ...(request.sandboxEnv && Object.keys(request.sandboxEnv).length ? { sandbox_env: request.sandboxEnv } : {}),
    ...(request.metadata && Object.keys(request.metadata).length ? { metadata: request.metadata } : {}),
  };
}

/**
 * pi's `sandbox_env` admission rules, mirrored so one unfit secret never 400s
 * the whole turn: env-name syntax, the names pi's sandbox reserves (shell,
 * proxy, loader and locale variables), at most 64 names, 256 KiB of names +
 * values, no NUL byte. A name that does not fit is left out (the metacognition
 * surfaces name it as not exported).
 */
const PI_SANDBOX_ENV_MAX_NAMES = 64;
const PI_SANDBOX_ENV_MAX_BYTES = 256 * 1024;
const PI_SANDBOX_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PI_SANDBOX_ENV_RESERVED =
  /^(PATH|HOME|USER|SHELL|PWD|OLDPWD|TMPDIR|LANG|TERM|IFS|ENV|HOSTNAME|PS4|PROMPT_COMMAND|SHELLOPTS)$|^(LD_|BASH|LC_)|_PROXY$/i;

/** The `names` (in order) whose `values` pi accepts as `sandbox_env`. */
export function piSandboxEnvOf(values: Record<string, string>, names: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  let bytes = 0;
  for (const name of names) {
    const value = values[name];
    if (value === undefined || !PI_SANDBOX_ENV_NAME.test(name) || PI_SANDBOX_ENV_RESERVED.test(name) || value.includes("\0")) continue;
    const size = Buffer.byteLength(name) + Buffer.byteLength(value);
    if (Object.keys(env).length >= PI_SANDBOX_ENV_MAX_NAMES || bytes + size > PI_SANDBOX_ENV_MAX_BYTES) continue;
    env[name] = value;
    bytes += size;
  }
  return env;
}

const RESERVED_HEADERS = new Set(["authorization", "content-type", "accept", "content-length", "host"]);

// ---- Client -------------------------------------------------------------------

export interface PiModel {
  id: string;
  ownedBy?: string;
}

export interface PiFileContent {
  bytes: Buffer;
  contentType: string;
}

export interface PiStreamOptions {
  signal?: AbortSignal;
  /** Called once response headers arrived (the turn is admitted and running). */
  onOpen?: () => void;
  /** Retry the OPEN (never a started stream) on retryable failures. Default: no retry. */
  retry?: PiRetryOptions;
}

export interface PiResponsesClient {
  /** Stream one turn's events. Ends after the terminal event (or throws). */
  stream(request: PiResponseRequest, options?: PiStreamOptions): AsyncGenerator<PiStreamEvent>;
  /** `POST /v1/responses/{id}/cancel?user=` → the stream ends `incomplete` (`user_cancelled`) and the turn is KEPT. */
  cancel(responseId: string, user: string, signal?: AbortSignal): Promise<{ status: string }>;
  listModels(signal?: AbortSignal): Promise<PiModel[]>;
  /** A `present_file` item's bytes. `path` must be under `/workspace`. */
  fileContent(path: string, user: string, signal?: AbortSignal): Promise<PiFileContent>;
}

function joinUrl(base: string, path: string): URL {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  url.search = "";
  url.hash = "";
  return url;
}

/** One abort signal combining the caller's signal with a deadline; `kind` remembers which fired. */
function linkedController(parent: AbortSignal | undefined): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const forward = () => {
    if (!controller.signal.aborted) controller.abort(parent?.reason);
  };
  if (parent?.aborted) forward();
  else parent?.addEventListener("abort", forward, { once: true });
  return { controller, dispose: () => parent?.removeEventListener("abort", forward) };
}

/**
 * `retryableNetwork`: a transport failure before any response header is safe to
 * re-send — pi aborts (and never commits) a turn whose request connection drops.
 */
function transportError(
  error: unknown,
  parent: AbortSignal | undefined,
  timeoutKind?: "connect" | "idle" | "total",
  retryableNetwork = false,
) {
  if (error instanceof PiGatewayError) return error;
  if (timeoutKind) return new PiGatewayError("timeout", { timeoutKind, cause: error });
  if (parent?.aborted) return new PiGatewayError("aborted", { cause: error });
  return new PiGatewayError("network", { cause: error, retryable: retryableNetwork });
}

export function createPiResponsesClient(config: PiGatewayConfig): PiResponsesClient {
  const doFetch = config.fetch ?? fetch;
  const connectTimeoutMs = config.connectTimeoutMs ?? PI_DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = config.idleTimeoutMs ?? PI_DEFAULT_IDLE_TIMEOUT_MS;
  const totalTimeoutMs = config.totalTimeoutMs ?? PI_DEFAULT_TOTAL_TIMEOUT_MS;
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const auth = { Authorization: `Bearer ${config.serviceKey}` };

  async function jsonCall(
    method: "GET" | "POST",
    path: string,
    query: Record<string, string>,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const url = joinUrl(config.baseUrl, path);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const { controller, dispose } = linkedController(signal);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    }, requestTimeoutMs);
    timer.unref?.();
    try {
      const response = await doFetch(url, {
        method,
        headers: { ...auth, Accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw await piErrorFromResponse(response);
      return response;
    } catch (error) {
      throw transportError(error, signal, timedOut ? "connect" : undefined);
    } finally {
      clearTimeout(timer);
      dispose();
    }
  }

  async function readJson(response: Response): Promise<unknown> {
    const text = await readCapped(response, MAX_JSON_BODY_BYTES);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new PiGatewayError("protocol", { cause: error });
    }
  }

  async function openOnce(
    body: string,
    headers: Record<string, string>,
    controller: AbortController,
    parent: AbortSignal | undefined,
    timeouts: { kind?: "connect" | "idle" | "total" },
  ): Promise<ReadableStream<Uint8Array>> {
    const connectTimer = setTimeout(() => {
      timeouts.kind = "connect";
      controller.abort(new Error("connect timeout"));
    }, connectTimeoutMs);
    connectTimer.unref?.();
    try {
      const response = await doFetch(joinUrl(config.baseUrl, "/v1/responses"), {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw await piErrorFromResponse(response);
      if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        await response.body?.cancel().catch(() => undefined);
        throw new PiGatewayError("protocol", { message: "pi-gateway가 SSE 스트림이 아닌 응답을 반환했습니다." });
      }
      if (!response.body) throw new PiGatewayError("protocol", { message: "pi-gateway가 빈 스트림을 반환했습니다." });
      return response.body;
    } catch (error) {
      throw transportError(error, parent, timeouts.kind, true);
    } finally {
      clearTimeout(connectTimer);
    }
  }

  async function* stream(request: PiResponseRequest, options: PiStreamOptions = {}): AsyncGenerator<PiStreamEvent> {
    const body = JSON.stringify(buildResponsesBody(request));
    if (Buffer.byteLength(body, "utf8") > PI_MAX_REQUEST_BYTES) {
      throw new PiGatewayError("too_large", { message: "첨부 이미지가 너무 커서 pi-gateway로 보낼 수 없습니다." });
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (!RESERVED_HEADERS.has(name.toLowerCase())) headers[name] = value;
    }
    Object.assign(headers, auth, { "Content-Type": "application/json", Accept: "text/event-stream" });

    const parent = options.signal;
    let attemptController: AbortController | undefined;
    let dispose = () => {};
    const timeouts: { kind?: "connect" | "idle" | "total" } = {};
    const responseBody = await withPiRetry(
      async () => {
        dispose();
        const linked = linkedController(parent);
        attemptController = linked.controller;
        dispose = linked.dispose;
        timeouts.kind = undefined;
        return openOnce(body, headers, linked.controller, parent, timeouts);
      },
      { attempts: 1, ...options.retry, signal: parent },
    ).catch((error: unknown) => {
      dispose();
      throw error;
    });
    const controller = attemptController!;
    options.onOpen?.();

    let idleTimer: NodeJS.Timeout | undefined;
    const arm = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timeouts.kind = "idle";
        controller.abort(new Error("idle timeout"));
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };
    const totalTimer = setTimeout(() => {
      timeouts.kind = "total";
      controller.abort(new Error("total timeout"));
    }, totalTimeoutMs);
    totalTimer.unref?.();
    arm();
    try {
      for await (const frame of readSseFrames(responseBody, arm, controller.signal)) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(frame.data);
        } catch (error) {
          throw new PiGatewayError("protocol", {
            message: `pi-gateway의 ${frame.event.slice(0, 80)} 이벤트가 올바른 JSON이 아닙니다.`,
            cause: error,
          });
        }
        if (!isRecord(decoded)) {
          throw new PiGatewayError("protocol", { message: "pi-gateway 이벤트가 객체가 아닙니다." });
        }
        const type = frame.event !== "message" ? frame.event : typeof decoded.type === "string" ? decoded.type : "";
        yield { type, data: decoded };
      }
    } catch (error) {
      throw transportError(error, parent, timeouts.kind);
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      // Leaving early (consumer broke out / threw) must close the upstream request.
      if (!controller.signal.aborted) controller.abort(new Error("stream closed"));
      dispose();
    }
  }

  return {
    stream,
    async cancel(responseId, user, signal) {
      const response = await jsonCall("POST", `/v1/responses/${encodeURIComponent(responseId)}/cancel`, { user }, signal);
      const json = await readJson(response);
      return { status: isRecord(json) && typeof json.status === "string" ? json.status : "cancelling" };
    },
    async listModels(signal) {
      const json = await readJson(await jsonCall("GET", "/v1/models", {}, signal));
      if (!isRecord(json) || !Array.isArray(json.data)) {
        throw new PiGatewayError("protocol", { message: "pi-gateway 모델 목록 형식이 올바르지 않습니다." });
      }
      return json.data
        .filter(isRecord)
        .filter((m) => typeof m.id === "string")
        .map((m) => ({ id: m.id as string, ...(typeof m.owned_by === "string" ? { ownedBy: m.owned_by } : {}) }));
    },
    async fileContent(path, user, signal) {
      const response = await jsonCall("GET", "/v1/files/content", { path, user }, signal);
      const bytes = await readCappedBytes(response, PI_MAX_FILE_BYTES);
      return { bytes, contentType: response.headers.get("content-type") ?? "application/octet-stream" };
    },
  };
}

// ---- Retry --------------------------------------------------------------------

export interface PiRetryOptions {
  /** Total attempts including the first. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (error: PiGatewayError, attempt: number, delayMs: number) => void;
  /** Injected for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PiGatewayError("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new PiGatewayError("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Re-run `op` while it fails with a RETRYABLE PiGatewayError (503 capacity, 429,
 * a pi restart). Honors the server's `retry_after` when given, else exponential
 * backoff with jitter, both capped at `maxDelayMs`. Only wrap operations that are
 * safe to repeat — the stream OPEN qualifies (a non-2xx means no turn ran).
 */
export async function withPiRetry<T>(op: () => Promise<T>, options: PiRetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const base = options.baseDelayMs ?? 1_000;
  const max = options.maxDelayMs ?? 30_000;
  const sleep = options.sleep ?? abortableSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (error) {
      if (!(error instanceof PiGatewayError) || !error.retryable || attempt >= attempts || options.signal?.aborted) {
        throw error;
      }
      const backoff = base * 2 ** (attempt - 1);
      const delay = Math.min(max, error.retryAfterMs ?? Math.round(backoff * (0.5 + Math.random() * 0.5)));
      options.onRetry?.(error, attempt, delay);
      await sleep(delay, options.signal);
    }
  }
}
