import { describe, expect, it } from "vitest";
import type { AgentRequest, MessageAttachment } from "../src/server/types.js";
import type {
  AgentEvents,
  CanvasRequest,
  FileOutputRequest,
  FileOutputResult,
  ToolEvent,
  TurnResultEvent,
} from "../src/server/agent/events.js";
import { runLocalAgent, runLocalAgentStream } from "../src/server/agent/localRunner.js";
import {
  LOCAL_DEMO_LONG_STEPS,
  LOCAL_DEMO_SCENARIOS,
  LOCAL_DEMO_UI_ANSWER,
  LOCAL_DEMO_UI_BLOCKS,
  LOCAL_DEMO_UI_MERMAID,
  LOCAL_DEMO_UI_FENCED_SOURCE,
  parseLocalCanvasSubmission,
  parseLocalDemoCommand,
} from "../src/server/agent/localScenarios.js";
import { buildCanvasTools, formatSubmission } from "../src/server/agent/canvasTools.js";
import { INLINE_UI_MANUAL_EXAMPLES } from "../src/server/agent/systemManual.js";
import { isRetryableModelError } from "../src/server/agent/runErrors.js";
import { PiTurnFailedError } from "../src/server/agent/pi/eventAdapter.js";
import { PiGatewayError } from "../src/server/agent/pi/responsesClient.js";
import { SteerChannel } from "../src/server/agent/steerChannel.js";
import { checkWidget } from "../src/shared/widget/check.js";
import { isSafePathId } from "../src/server/routes/_shared.js";
import { callTool } from "./helpers.js";

type Logged =
  | { type: "status"; label: string }
  | { type: "delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "fold"; text: string }
  | { type: "tool"; event: ToolEvent }
  | { type: "tool_end"; event: { toolUseId: string; ok: boolean } }
  | { type: "canvas"; request: CanvasRequest }
  | { type: "file"; request: FileOutputRequest }
  | { type: "turn"; event: TurnResultEvent };

interface Recorder {
  log: Logged[];
  events: AgentEvents;
  of<T extends Logged["type"]>(type: T): Extract<Logged, { type: T }>[];
  deltas(): string;
}

/** An events sink shaped like the chat route's: every display callback, a fold sink, a non-blocking canvas. */
function recorder(
  options: {
    canvas?: boolean;
    fold?: boolean;
    steers?: SteerChannel;
    onFile?: (request: FileOutputRequest) => FileOutputResult;
  } = {},
): Recorder {
  const log: Logged[] = [];
  const events: AgentEvents = {
    onStatus: (label) => log.push({ type: "status", label }),
    onDelta: (text) => log.push({ type: "delta", text }),
    onThinking: (text) => log.push({ type: "thinking", text }),
    onToolStart: (event) => log.push({ type: "tool", event }),
    onToolEnd: (event) => log.push({ type: "tool_end", event }),
    onTurnResult: (event) => log.push({ type: "turn", event }),
    ...(options.fold === false ? {} : { onTextFold: (text: string) => log.push({ type: "fold", text }) }),
    ...(options.canvas === false
      ? {}
      : {
          onCanvas: async (request: CanvasRequest) => {
            log.push({ type: "canvas", request });
            return { behavior: "shown" as const };
          },
        }),
    ...(options.onFile
      ? {
          onFile: async (request: FileOutputRequest) => {
            log.push({ type: "file", request });
            return options.onFile!(request);
          },
        }
      : {}),
    ...(options.steers ? { steers: options.steers } : {}),
  };
  return {
    log,
    events,
    of: (type) => log.filter((entry) => entry.type === type) as never,
    deltas: () =>
      log
        .filter((entry): entry is Extract<Logged, { type: "delta" }> => entry.type === "delta")
        .map((entry) => entry.text)
        .join(""),
  };
}

function req(message: string, extra: Partial<AgentRequest> = {}): AgentRequest {
  return {
    message,
    avatar: { id: "user-1", displayName: "테스터", alias: "", persona: "" },
    conversationId: "conv-1",
    ...extra,
  };
}

/** No test sleeps: the injected wait returns at once and records what was asked. */
function instant(onWait?: (count: number) => void) {
  const waits: number[] = [];
  return {
    waits,
    deps: {
      sleep: async (ms: number) => {
        waits.push(ms);
        onWait?.(waits.length);
      },
    },
  };
}

const run = (message: string, rec: Recorder, extra: Partial<AgentRequest> = {}) =>
  runLocalAgentStream(req(message, extra), rec.events, undefined, instant().deps);

describe("local runtime: the default echo", () => {
  it("answers `[local] <message>` exactly as before", () => {
    expect(runLocalAgent(req("안녕하세요"))).toEqual({
      kind: "text",
      runtime: "local",
      summary: "(로컬 런타임 응답)",
      text: "[local] 안녕하세요",
    });
  });

  it("streams the echo as one status label and 40-codepoint deltas, with no delay", async () => {
    const message = `${"가".repeat(45)}😀${"b".repeat(40)}`;
    const rec = recorder();
    const wait = instant();
    const response = await runLocalAgentStream(req(message), rec.events, undefined, wait.deps);
    expect(response).toEqual(runLocalAgent(req(message)));
    expect(response.text).toBe(`[local] ${message}`);
    expect(rec.log[0]).toEqual({ type: "status", label: "응답 생성 중…" });
    const deltas = rec.of("delta").map((entry) => entry.text);
    expect(deltas.map((delta) => Array.from(delta).length)).toEqual([40, 40, 14]);
    expect(deltas.join("")).toBe(response.text);
    // Nothing but the status and the deltas — the pre-demo event sequence.
    expect(rec.log).toHaveLength(1 + deltas.length);
    expect(wait.waits).toEqual([]);
  });

  it("runs without an events sink", async () => {
    await expect(runLocalAgentStream(req("hello"), undefined)).resolves.toMatchObject({ text: "[local] hello" });
  });

  it("keeps echoing anything that is not exactly a demo command", async () => {
    for (const message of ["demo를 보여줘", "demotext", "/demo", "demo text please", "demo\ntext", "show demo", "demo text!"]) {
      expect(parseLocalDemoCommand(message), message).toBeNull();
      const rec = recorder();
      const response = await run(message, rec);
      expect(response.text, message).toBe(`[local] ${message}`);
      expect(rec.of("turn"), message).toEqual([]);
    }
  });

  it("recognizes the command forms", () => {
    expect(parseLocalDemoCommand("demo")).toEqual({ kind: "list" });
    expect(parseLocalDemoCommand("  DEMO  ")).toEqual({ kind: "list" });
    expect(parseLocalDemoCommand("demo help")).toEqual({ kind: "list" });
    expect(parseLocalDemoCommand("Demo   UI")).toMatchObject({ kind: "scenario", scenario: { name: "ui" } });
    // The retired widget-canvas scenario is gone: its name is just an unknown one now.
    expect(parseLocalDemoCommand("demo widget")).toEqual({ kind: "unknown", name: "widget" });
    expect(parseLocalDemoCommand("demo nope")).toEqual({ kind: "unknown", name: "nope" });
  });
});

describe("local runtime: demo listing", () => {
  it("`demo` lists every scenario in Korean", async () => {
    const rec = recorder();
    const response = await run("demo", rec);
    for (const scenario of LOCAL_DEMO_SCENARIOS) {
      expect(response.text).toContain(`\`demo ${scenario.name}\``);
      expect(response.text).toContain(scenario.summary);
    }
    expect(LOCAL_DEMO_SCENARIOS.map((scenario) => scenario.name)).toEqual([
      "text",
      "thinking",
      "tools",
      "canvas",
      "ui",
      "error",
      "long",
      "attachments",
    ]);
    expect(response.text).toMatch(/[가-힣]/);
    expect(response.runtime).toBe("local");
    expect(rec.deltas().trim()).toBe(response.text);
    expect(rec.of("turn").map((entry) => entry.event)).toEqual([{ text: response.text, steerPending: false }]);
    // The non-streaming response agrees.
    expect(runLocalAgent(req("demo")).text.trim()).toBe(response.text);
  });

  it("the plain (event-less) response never pretends to have replayed a scenario", () => {
    for (const scenario of LOCAL_DEMO_SCENARIOS) {
      const text = runLocalAgent(req(`demo ${scenario.name}`)).text;
      expect(text).toContain(`\`demo ${scenario.name}\` 시나리오는 이벤트 스트림으로만 재생됩니다`);
      expect(text).not.toContain("[local]");
    }
  });

  it("an unknown scenario says so and lists the real ones", async () => {
    const response = await run("demo nope", recorder());
    expect(response.text).toContain("`nope` 시나리오는 없습니다");
    expect(response.text).toContain("`demo canvas`");
  });
});

describe("local runtime: demo text / thinking", () => {
  it("`demo text` streams a Markdown answer in small chunks", async () => {
    const rec = recorder();
    const wait = instant();
    const response = await runLocalAgentStream(req("demo text"), rec.events, undefined, wait.deps);
    const deltas = rec.of("delta");
    expect(deltas.length).toBeGreaterThan(100);
    expect(Math.max(...deltas.map((entry) => Array.from(entry.text).length))).toBeLessThanOrEqual(6);
    expect(rec.deltas().trim()).toBe(response.text);
    expect(wait.waits.length).toBe(deltas.length);
    expect(response.text).toMatch(/^# /m);
    expect(response.text).toMatch(/^## /m);
    expect(response.text).toMatch(/^- /m);
    expect(response.text).toMatch(/^1\. /m);
    expect(response.text).toMatch(/^\| --- \|/m);
    expect(response.text).toMatch(/```ts\n[\s\S]+?\n```/);
    expect(response.text).toMatch(/\S{120,}/);
    expect(response.text).toMatch(/[가-힣]+.*[A-Za-z]+/);
    expect(rec.of("thinking")).toEqual([]);
    expect(rec.of("tool")).toEqual([]);
    expect(rec.log.at(-1)).toEqual({ type: "turn", event: { text: response.text, steerPending: false } });
  });

  it("`demo thinking` streams reasoning first, then the answer, never mixed", async () => {
    const rec = recorder();
    const response = await run("demo thinking", rec);
    const kinds = rec.log.map((entry) => entry.type).filter((type) => type === "thinking" || type === "delta");
    const firstDelta = kinds.indexOf("delta");
    expect(firstDelta).toBeGreaterThan(10);
    expect(kinds.slice(0, firstDelta).every((type) => type === "thinking")).toBe(true);
    expect(kinds.slice(firstDelta).every((type) => type === "delta")).toBe(true);
    const thinking = rec
      .of("thinking")
      .map((entry) => entry.text)
      .join("");
    expect(thinking).toContain("정리됐다");
    expect(response.text).not.toContain("정리됐다");
    expect(rec.deltas().trim()).toBe(response.text);
    expect(response.thinking).toBeUndefined(); // the host attaches it from the stream
    expect(rec.of("fold")).toEqual([]);
  });
});

describe("local runtime: demo tools", () => {
  it("reports tool activity the way the real runner does", async () => {
    const rec = recorder();
    const response = await run("demo tools", rec);
    const starts = rec.of("tool").map((entry) => entry.event);
    const ends = rec.of("tool_end").map((entry) => entry.event);
    expect(starts.map((event) => event.name)).toEqual(["LS", "Read", "Grep", "Bash", "Glob", "Edit", "mcp__skills__read"]);
    expect(new Set(starts.map((event) => event.toolUseId)).size).toBe(starts.length);
    for (const event of starts) {
      expect(event.agentId).toBe("main");
      expect(event.inputSummary).toBeTruthy();
      expect(Object.keys(event).sort()).toEqual(["agentId", "inputSummary", "name", "toolUseId"]);
    }
    // Every row ends exactly once, after it started.
    for (const start of starts) {
      const startAt = rec.log.findIndex((entry) => entry.type === "tool" && entry.event.toolUseId === start.toolUseId);
      const endAt = rec.log.findIndex((entry) => entry.type === "tool_end" && entry.event.toolUseId === start.toolUseId);
      expect(endAt).toBeGreaterThan(startAt);
      expect(ends.filter((end) => end.toolUseId === start.toolUseId)).toHaveLength(1);
    }
    // One failure: the shell command.
    const failed = ends.filter((end) => !end.ok).map((end) => starts.find((start) => start.toolUseId === end.toolUseId)!.name);
    expect(failed).toEqual(["Bash"]);
    // Bash and Glob run at once: both started before either ended, and the quicker one ends first.
    const order = rec.log
      .filter((entry): entry is Extract<Logged, { type: "tool" | "tool_end" }> => entry.type === "tool" || entry.type === "tool_end")
      .map((entry) => `${entry.type}:${starts.find((start) => start.toolUseId === entry.event.toolUseId)!.name}`);
    expect(order.slice(6, 10)).toEqual(["tool:Bash", "tool:Glob", "tool_end:Glob", "tool_end:Bash"]);
    // The status line names the running tool with the shared Korean label.
    expect(rec.of("status").map((entry) => entry.label)).toEqual(
      expect.arrayContaining(["응답 생성 중…", "실행 중: 파일 읽기", "실행 중: 명령 실행", "실행 중: 스킬 읽기"]),
    );
    // Narration between tool calls is folded into the reasoning view; the answer is the last block.
    const folds = rec.of("fold").map((entry) => entry.text);
    expect(folds).toHaveLength(2);
    expect(folds[0]).toContain("작업 폴더를 살펴보겠습니다");
    expect(folds[1]).toContain("테스트를 돌리고");
    expect(response.text).not.toContain("작업 폴더를 살펴보겠습니다");
    expect(response.text).toContain("**실패**");
    expect(response.text).toContain("npm test");
    // A fold fires before the first delta of the block that supersedes it.
    const firstFold = rec.log.findIndex((entry) => entry.type === "fold");
    expect(rec.log[firstFold + 1]).toMatchObject({ type: "delta" });
    expect(rec.log.at(-1)).toEqual({ type: "turn", event: { text: response.text, steerPending: false } });
  });

  it("joins every block when the host has no fold sink (legacy contract)", async () => {
    const rec = recorder({ fold: false });
    const response = await run("demo tools", rec);
    expect(response.text).toContain("작업 폴더를 살펴보겠습니다");
    expect(response.text).toContain("**실패**");
  });
});

/** The request the REAL canvas tool emits for the same arguments — the stub must emit the same one. */
async function realCanvasRequest(request: CanvasRequest): Promise<CanvasRequest> {
  let emitted: CanvasRequest | undefined;
  const tools = buildCanvasTools({
    emitCanvas: async (canvas) => {
      emitted = canvas;
      return { behavior: "shown" };
    },
  });
  const result = await callTool(tools, "show", {
    title: request.title,
    content: request.content,
    contentType: request.contentType,
    ...(request.controls ? { controls: request.controls } : {}),
    ...(request.editable ? { editable: true } : {}),
    canvasId: request.artifactId,
  });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return emitted!;
}

describe("local runtime: demo canvas", () => {
  it("shows one canvas per content type plus a controls form, through the canvas event", async () => {
    const rec = recorder();
    const response = await run("demo canvas", rec);
    const canvases = rec.of("canvas").map((entry) => entry.request);
    expect(canvases.map((canvas) => canvas.contentType)).toEqual(["markdown", "mermaid", "mermaid", "svg", "html", "markdown"]);
    expect(new Set(canvases.map((canvas) => canvas.artifactId)).size).toBe(6);
    for (const canvas of canvases) {
      expect(canvas.artifactId.startsWith("local-demo-conv-1-")).toBe(true);
      expect(isSafePathId(canvas.artifactId)).toBe(true);
      expect(canvas.awaitInput).toBe(false);
      // Accepted by the real tool (size caps, control rules, the mermaid parse) and emitted identically.
      expect(await realCanvasRequest(canvas)).toEqual(canvas);
      expect("anchor" in canvas).toBe(false); // a canvas is a side-panel artifact
    }
    expect(canvases[0]).toMatchObject({ editable: true, controls: undefined, interaction: undefined });
    expect(canvases[1]!.content.startsWith("xychart-beta")).toBe(true); // a chart on a canvas is a mermaid chart (it passed the real parse above)
    expect(canvases[4]!.content).toContain("<style>");
    const form = canvases[5]!;
    expect(form.interaction).toBe("async");
    expect(form.controls!.map((control) => control.type)).toEqual(["buttons", "buttons", "select", "slider", "number", "date", "text"]);
    expect(form.controls!.find((control) => control.id === "topics")!.multiSelect).toBe(true);
    expect(canvases.slice(0, 5).every((canvas) => canvas.controls === undefined && canvas.interaction === undefined)).toBe(true);

    // Each canvas sits inside its own mcp__canvas__show tool row: start → canvas → end.
    const shape = rec.log
      .filter((entry) => entry.type === "tool" || entry.type === "canvas" || entry.type === "tool_end")
      .map((entry) => entry.type);
    expect(shape).toEqual(Array.from({ length: 6 }, () => ["tool", "canvas", "tool_end"]).flat());
    const rows = rec.of("tool").map((entry) => entry.event);
    expect(rows.every((row) => row.name === "mcp__canvas__show")).toBe(true);
    expect(rows.map((row) => row.inputSummary)).toEqual(canvases.map((canvas) => canvas.title));
    expect(rec.of("tool_end").every((entry) => entry.event.ok)).toBe(true);
    expect(rec.of("status").map((entry) => entry.label)).toContain("실행 중: 캔버스 표시");
    expect(response.text).toContain("캔버스 6개");
    expect(rec.of("fold").map((entry) => entry.text)).toEqual(["콘텐츠 유형별 캔버스를 차례로 열겠습니다."]);
  });

  it("scopes canvas ids to the conversation and keeps them stable across runs", async () => {
    const ids = async (conversationId: string | undefined) => {
      const rec = recorder();
      await run("demo canvas", rec, { conversationId });
      return rec.of("canvas").map((entry) => entry.request.artifactId);
    };
    expect(await ids("conv-1")).toEqual(await ids("conv-1"));
    expect(await ids("conv-2")).not.toEqual(await ids("conv-1"));
    const long = await ids("c".repeat(200));
    expect(long.every((id) => id.length <= 128)).toBe(true);
    expect((await ids(undefined)).every((id) => id.startsWith("local-demo-run-"))).toBe(true);
  });

  it("shows nothing when the run has no canvas sink, and says so", async () => {
    const rec = recorder({ canvas: false });
    const response = await run("demo canvas", rec);
    expect(rec.of("canvas")).toEqual([]);
    expect(rec.of("tool")).toEqual([]);
    expect(response.text).toContain("캔버스를 열지 않았습니다");
  });
});

describe("local runtime: demo ui (inline UI in the answer text)", () => {
  it("every UI block, the whole answer and the manual's examples pass the checker", () => {
    expect(Object.keys(LOCAL_DEMO_UI_BLOCKS)).toEqual(["calculator", "dashboard", "table"]);
    for (const [name, source] of Object.entries(LOCAL_DEMO_UI_BLOCKS)) {
      const check = checkWidget(source);
      expect(check, `${name}: ${check.ok ? "" : check.error}`).toMatchObject({ ok: true });
      // The answer carries each block verbatim.
      expect(LOCAL_DEMO_UI_ANSWER).toContain(source);
    }
    expect(checkWidget(LOCAL_DEMO_UI_BLOCKS.calculator)).toEqual({ ok: true, submits: true });
    expect(checkWidget(LOCAL_DEMO_UI_BLOCKS.dashboard)).toEqual({ ok: true, submits: false });
    expect(checkWidget(LOCAL_DEMO_UI_BLOCKS.table)).toEqual({ ok: true, submits: false });
    // The answer is ONE document (one state scope): prose, the three blocks and
    // a fenced source together still parse, and no state name repeats.
    const whole = checkWidget(LOCAL_DEMO_UI_ANSWER);
    expect(whole, whole.ok ? "" : whole.error).toEqual({ ok: true, submits: true });
    const states = [...LOCAL_DEMO_UI_ANSWER.matchAll(/^\{@(?:state|const) (\w+) =/gm)].map((match) => match[1]);
    expect(states.length).toBeGreaterThanOrEqual(10);
    expect(new Set(states).size).toBe(states.length);
    // The manual's own examples stay valid too (the demo is modelled on them).
    for (const source of Object.values(INLINE_UI_MANUAL_EXAMPLES) as string[]) {
      expect(checkWidget(source)).toMatchObject({ ok: true });
    }
  });

  it("covers a stateful calculator with both ways back, a dashboard with the simple chart form, tabs + a sortable table, Markdown between them and a fenced source", () => {
    const { calculator, dashboard, table } = LOCAL_DEMO_UI_BLOCKS;
    expect(calculator).toMatch(/^\{@state amount = 3000\}/);
    expect(calculator).toMatch(/<slider /);
    expect(calculator).toMatch(/<stat /);
    expect(calculator).toMatch(/<submit values=\{\{/);
    expect(calculator).toMatch(/<button send=\{`/);
    expect(calculator).toMatch(/\{#if months > 36\}/);
    expect(dashboard).toMatch(/<grid columns=\{4\}/);
    expect(dashboard.match(/<stat /g)).toHaveLength(4);
    expect(dashboard).toContain('<chart type="bar" data={monthly3q} xKey="month" series={[{ key: "sales", label: "매출" }, { key: "cost", label: "비용" }]}');
    expect(dashboard).toContain('<chart type="donut" data={teamShare} xKey="team" series={["share"]}');
    expect(dashboard).not.toContain("spec={"); // the simple form, not a Vega-Lite spec
    expect(table).toMatch(/<tabs /);
    expect(table).toMatch(/<table sortable /);
    expect(table).toMatch(/\{#if view === "table"\}/);
    expect(table).toMatch(/\.filter\(/);
    // Ordinary Markdown around the UI: headings, paragraphs, a list, a link.
    for (const piece of ["# 로컬 시연: 인라인 UI", "## 1. 계산기", "## 2. 대시보드", "## 3. 탭과 정렬되는 표", "## 4. 소스로 보여 주기", "[링크](https://example.com/docs)", "\n- **이 조건으로 진행**"]) {
      expect(LOCAL_DEMO_UI_ANSWER).toContain(piece);
    }
    // A tag shown AS SOURCE: inside a code fence, where the client must not draw it.
    expect(LOCAL_DEMO_UI_ANSWER).toContain(`\n\`\`\`\n${LOCAL_DEMO_UI_FENCED_SOURCE}\n\`\`\`\n`);
    expect(LOCAL_DEMO_UI_FENCED_SOURCE.startsWith("<stat ")).toBe(true);
    // A diagram: a ```mermaid fence (drawn in place by the client), labels with punctuation quoted.
    expect(LOCAL_DEMO_UI_ANSWER).toContain(`\n## 5. 다이어그램\n`);
    expect(LOCAL_DEMO_UI_ANSWER).toContain(`\n\`\`\`mermaid\n${LOCAL_DEMO_UI_MERMAID}\n\`\`\`\n`);
    expect(LOCAL_DEMO_UI_MERMAID).toMatch(/^flowchart LR\n/);
    expect(LOCAL_DEMO_UI_MERMAID).toContain('A["질문 (채팅)"]');
    // Every tag line of a block starts at the top level (indent ≤ 3 spaces would
    // still be a tag; none is indented 4+, which Markdown reads as code).
    for (const source of Object.values(LOCAL_DEMO_UI_BLOCKS)) {
      expect(source.split("\n")[0]!.startsWith("{@")).toBe(true);
      expect(source.split("\n").filter((line) => /^(<|\{[#@])/.test(line)).length).toBeGreaterThan(2);
    }
    // Visible text is Korean.
    expect(LOCAL_DEMO_UI_ANSWER).toMatch(/[가-힣]/);
  });

  it("streams the answer as plain text deltas in small slices — no canvas event, no tool call, nothing attached", async () => {
    const rec = recorder();
    const response = await run("demo ui", rec);
    expect(response.text).toBe(LOCAL_DEMO_UI_ANSWER.trim());
    expect(rec.deltas().trim()).toBe(response.text);
    expect(rec.of("canvas")).toEqual([]);
    expect(rec.of("tool")).toEqual([]);
    expect(rec.of("file")).toEqual([]);
    // Reasoning first, then the answer — which is never folded away (it is the last text block).
    expect(rec.of("thinking").length).toBeGreaterThan(0);
    expect(rec.of("fold")).toEqual([]);
    // Small slices: every tag is cut mid-way many times, which is what the
    // client's streaming render has to survive.
    const deltas = rec.of("delta").map((entry) => entry.text);
    expect(deltas.length).toBeGreaterThan(300);
    expect(Math.max(...deltas.map((delta) => Array.from(delta).length))).toBeLessThanOrEqual(9);
    const cut = deltas.filter((delta) => /<[a-z-]*$/.test(delta) || /^[^<]*>/.test(delta));
    expect(cut.length).toBeGreaterThan(10);
    expect(rec.log.at(-1)).toEqual({ type: "turn", event: { text: response.text, steerPending: false } });
  });

  it("needs no canvas sink: a host without one still gets the whole answer", async () => {
    const rec = recorder({ canvas: false });
    const response = await run("demo ui", rec);
    expect(response.text).toBe(LOCAL_DEMO_UI_ANSWER.trim());
    expect(response.text).not.toContain("캔버스를 열지 않았습니다");
  });

  it("a button of the demo posts an ordinary next message, which the stub echoes like any other", async () => {
    // What the client sends for `<submit>`: the label, then one `- key: value` line per value.
    const message = "이 조건으로 진행\n- amount: 4500\n- months: 36\n- rate: 4.5\n- monthly: 1418750";
    expect(parseLocalCanvasSubmission(message)).toBeNull(); // not a canvas submission any more
    expect((await run(message, recorder())).text).toBe(`[local] ${message}`);
    const send = "대출 4500만원을 36개월 동안 갚을 때 금리를 낮추는 방법을 알려줘";
    expect((await run(send, recorder())).text).toBe(`[local] ${send}`);
  });
});

describe("local runtime: canvas submission echo", () => {
  // Exactly what routes/chat.ts builds for `canvasSubmission`.
  const submissionMessage = (title: string | undefined, id: string, values?: Record<string, unknown>, edited?: string): string => {
    const ref = title ? `the canvas "${title}" (id: ${id})` : `the canvas (id: ${id})`;
    const parts: string[] = [];
    if (values) parts.push(`On ${ref}, ${formatSubmission(values)}`);
    if (edited) parts.push(`The user edited ${ref} content to:\n${edited}`);
    return parts.join("\n\n");
  };

  it("echoes the values a controls form sent", async () => {
    const message = submissionMessage("Controls · 워크숍 일정 정하기", "local-demo-conv-1-controls", {
      amount: 4500,
      months: 36,
      rate: 4.5,
      done: ["spec", "tests"],
      complete: false,
      note: "",
    });
    expect(message.startsWith('On the canvas "Controls · 워크숍 일정 정하기" (id: local-demo-conv-1-controls), The user responded on the canvas:')).toBe(true);
    const rec = recorder();
    const response = await run(message, rec);
    expect(response.text).toContain("**Controls · 워크숍 일정 정하기** 캔버스에서 보낸 내용을 받았습니다");
    expect(response.text).toContain("local-demo-conv-1-controls");
    expect(response.text).toContain("| `amount` | 4500 |");
    expect(response.text).toContain("| `months` | 36 |");
    expect(response.text).toContain("| `done` | spec, tests |");
    expect(response.text).toContain("| `complete` | false |");
    expect(response.text).toContain("| `note` | (빈 값) |");
    expect(response.text).not.toContain("[local]");
    expect(rec.deltas().trim()).toBe(response.text);
    expect(runLocalAgent(req(message)).text.trim()).toBe(response.text);
  });

  it("echoes an empty submission, an untitled canvas and edited content", async () => {
    const empty = await run(submissionMessage(undefined, "cv-1", {}), recorder());
    expect(empty.text).toContain("캔버스에서 보낸 내용을 받았습니다");
    expect(empty.text).toContain("값 없이 제출되었습니다");

    const edited = await run(submissionMessage("메모", "cv-2", undefined, "# 고친 제목\n\n- 항목"), recorder());
    expect(edited.text).toContain("수정해서 보낸 내용");
    expect(edited.text).toContain("# 고친 제목\n\n- 항목");

    const both = parseLocalCanvasSubmission(submissionMessage("둘 다", "cv-3", { pick: "A", memo: "첫 줄\n둘째 줄" }, "본문"));
    expect(both).toEqual({
      canvasId: "cv-3",
      title: "둘 다",
      values: [
        ["pick", "A"],
        ["memo", "첫 줄\n둘째 줄"],
      ],
      editedContent: "본문",
    });
  });

  it("leaves messages that only look similar to the echo", async () => {
    for (const message of ["On the canvas I drew a cat", "The user responded on the canvas:\n- a: 1", "the canvas (id: x)"]) {
      expect(parseLocalCanvasSubmission(message), message).toBeNull();
      expect((await run(message, recorder())).text).toBe(`[local] ${message}`);
    }
  });
});

describe("local runtime: demo error", () => {
  it("fails like a failed pi turn, after a partial stream", async () => {
    const steers = new SteerChannel();
    const rec = recorder({ steers });
    const error = await run("demo error", rec).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(PiTurnFailedError);
    expect(error).toMatchObject({ code: "server_error", status: 502 });
    expect((error as PiTurnFailedError).message).toMatch(/[가-힣]/);
    expect((error as PiTurnFailedError).upstreamMessage).toContain("local demo");
    // The chat route keys its "try another model" notice on this.
    expect(isRetryableModelError(error)).toBe(true);
    // The viewer already saw reasoning and a partial answer; no result boundary was reported.
    expect(rec.of("thinking").length).toBeGreaterThan(0);
    expect(rec.deltas()).toContain("다음 단계로 넘어가려는 순간");
    expect(rec.of("turn")).toEqual([]);
    expect(steers.closed).toBe(true);
  });
});

describe("local runtime: abort (중지)", () => {
  it("stops a stream mid-way with the real runner's aborted error", async () => {
    const controller = new AbortController();
    const steers = new SteerChannel();
    const queued = steers.push("/나중에")!;
    const rec = recorder({ steers });
    const wait = instant((count) => {
      if (count === 12) controller.abort();
    });
    const error = await runLocalAgentStream(req("demo long"), rec.events, controller, wait.deps).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(PiGatewayError);
    expect((error as PiGatewayError).kind).toBe("aborted");
    // Nothing is emitted after the abort was seen.
    expect(wait.waits).toHaveLength(12);
    const streamed = rec.deltas();
    expect(streamed).toContain("단계 1/");
    expect(streamed).not.toContain(`단계 ${LOCAL_DEMO_LONG_STEPS}/`);
    expect(rec.of("turn")).toEqual([]);
    // The message the run never took is dropped, as on a real stop.
    expect(steers.closed).toBe(true);
    expect(queued.state).toBe("dropped");
  });

  it("emits nothing for a run that was already stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    const rec = recorder();
    await expect(runLocalAgentStream(req("demo text"), rec.events, controller, instant().deps)).rejects.toMatchObject({ kind: "aborted" });
    expect(rec.log).toEqual([]);
  });

  it("the default timer wait is cut short by an abort", async () => {
    const controller = new AbortController();
    const rec = recorder();
    const started = Date.now();
    const pending = runLocalAgentStream(req("demo long"), rec.events, controller);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
    // `demo long` waits 600 ms per step: finishing this fast means the wait itself was interrupted.
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("local runtime: mid-turn messages (steers)", () => {
  it("folds a queued message into the running turn and acknowledges it", async () => {
    const steers = new SteerChannel();
    const states: string[] = [];
    steers.onChange((record, change) => states.push(`${change.previous ?? "new"}→${record.state}`));
    const rec = recorder({ steers });
    let pushed = false;
    const wait = instant(() => {
      if (!pushed && rec.deltas().includes("단계 3/")) {
        pushed = true;
        steers.push("표 대신 요약만 주세요");
      }
    });
    const response = await runLocalAgentStream(req("demo long"), rec.events, undefined, wait.deps);
    const [record] = steers.records();
    expect(states).toEqual(["new→queued", "queued→delivered", "delivered→completed"]);
    expect(record!.followUp).toBe(false);
    // Delivery is a block boundary: what streamed before it is folded away…
    const folds = rec.of("fold").map((entry) => entry.text);
    expect(folds).toHaveLength(1);
    expect(folds[0]).toContain("단계 1/");
    expect(folds[0]).toContain("단계 3/");
    // …and the answer restarts with the acknowledgement, then carries on.
    expect(response.text.startsWith("**실행 중에 보낸 메시지를 받았습니다.**")).toBe(true);
    expect(response.text).toContain("> 표 대신 요약만 주세요");
    expect(response.text).not.toContain("단계 1/");
    expect(response.text).toContain(`단계 ${LOCAL_DEMO_LONG_STEPS}/${LOCAL_DEMO_LONG_STEPS}`);
    // One run, one final boundary — no follow-up turn.
    expect(rec.of("turn").map((entry) => entry.event)).toEqual([{ text: response.text, steerPending: false }]);
    expect(steers.closed).toBe(true);
    expect(steers.push("늦은 메시지")).toBeNull();
  });

  it("sends a slash-leading message, and one that arrives as the answer ends, as ONE follow-up turn", async () => {
    const steers = new SteerChannel();
    const rec = recorder({ steers });
    let step = 0;
    const wait = instant(() => {
      step += 1;
      if (step === 2) steers.push("/todo 우유 사기");
      // During the final text step: too late for the running turn.
      if (rec.deltas().includes("모두 마쳤") && steers.records().length === 1) steers.push("마지막에 보낸 메시지");
    });
    const response = await runLocalAgentStream(req("demo long"), rec.events, undefined, wait.deps);
    const records = steers.records();
    expect(records.map((record) => record.state)).toEqual(["completed", "completed"]);
    expect(records.map((record) => record.followUp)).toEqual([true, true]);
    const turns = rec.of("turn").map((entry) => entry.event);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.steerPending).toBe(true);
    expect(turns[0]!.text).toContain(`${LOCAL_DEMO_LONG_STEPS}단계를 모두 마쳤습니다`);
    expect(turns[0]!.text).not.toContain("이어지는 턴");
    expect(turns[1]).toEqual({ text: response.text, steerPending: false });
    expect(response.text).toContain("메시지 2개를 이어지는 턴으로 받았습니다");
    expect(response.text).toContain("> /todo 우유 사기");
    expect(response.text).toContain("> 마지막에 보낸 메시지");
    // The first turn's text was never folded: it is its own persisted segment.
    expect(rec.of("fold")).toEqual([]);
    // Both were marked delivered only AFTER the boundary was reported.
    const boundary = rec.log.findIndex((entry) => entry.type === "turn");
    expect(rec.log.slice(0, boundary).some((entry) => entry.type === "delta" && entry.text.includes("이어지는"))).toBe(false);
    expect(steers.closed).toBe(true);
  });

  it("a run without a steer channel just runs", async () => {
    const response = await run("demo long", recorder());
    expect(response.text).toContain(`단계 ${LOCAL_DEMO_LONG_STEPS}/${LOCAL_DEMO_LONG_STEPS}`);
  });
});

describe("local runtime: demo attachments", () => {
  const attachment = (id: string): MessageAttachment => ({ id, kind: "image", mediaType: "image/png" }) as MessageAttachment;

  it("asks for an image when none was attached, and publishes nothing", async () => {
    const rec = recorder({ onFile: () => ({ behavior: "error", message: "unused" }) });
    const response = await run("demo attachments", rec);
    expect(rec.of("file")).toEqual([]);
    expect(rec.of("tool")).toEqual([]);
    expect(response.text).toContain("이미지를 하나 이상 붙여서");
  });

  it("re-publishes the turn's attached images through onFile, anchored in the answer", async () => {
    const shown: MessageAttachment[] = [];
    const rec = recorder({
      onFile: (request) => {
        if (request.path.endsWith("broken.png")) return { behavior: "error", message: "The image file is empty." };
        const published = attachment(`att-${shown.length + 1}`);
        shown.push(published);
        return { behavior: "shown", attachment: published, url: `/api/conversations/conv-1/images/${published.id}` };
      },
    });
    const response = await run("demo attachments", rec, {
      imageFiles: [
        { path: "/data/ws/conv-1/attachments/a.png", mediaType: "image/png", name: "스크린샷.png" },
        { path: "/data/ws/conv-1/attachments/broken.png", mediaType: "image/png" },
      ],
    });
    expect(rec.of("file").map((entry) => entry.request)).toEqual([
      { path: "/data/ws/conv-1/attachments/a.png", caption: "시연 이미지 1/2 · 스크린샷.png" },
      { path: "/data/ws/conv-1/attachments/broken.png", caption: "시연 이미지 2/2" },
    ]);
    const rows = rec.of("tool").map((entry) => entry.event);
    expect(rows.map((row) => [row.name, row.inputSummary])).toEqual([
      ["mcp__file_output__show_file", "a.png"],
      ["mcp__file_output__show_file", "broken.png"],
    ]);
    expect(rec.of("tool_end").map((entry) => entry.event.ok)).toEqual([true, false]);
    // The card is stamped with its place in the answer segment (the narration before it was not folded yet).
    expect(shown).toHaveLength(1);
    expect(shown[0]!.anchor).toBe("붙여 주신 이미지를 답변에 다시 게시하겠습니다.".length);
    expect(response.text).toContain("이미지 1개를 이 답변에 게시했습니다");
    expect(response.text).toContain("- The image file is empty.");
  });

  it("says so when the run has no file sink", async () => {
    const rec = recorder();
    const response = await run("demo attachments", rec, {
      imageFiles: [{ path: "/data/ws/conv-1/attachments/a.png", mediaType: "image/png" }],
    });
    expect(rec.of("tool")).toEqual([]);
    expect(response.text).toContain("이미지를 게시하지 않았습니다");
  });
});

describe("local runtime: determinism", () => {
  it("replays every scenario identically", async () => {
    for (const scenario of LOCAL_DEMO_SCENARIOS) {
      const once = async () => {
        const rec = recorder();
        const outcome = await run(`demo ${scenario.name}`, rec).then(
          (response) => response.text,
          (error: unknown) => `threw ${(error as Error).name}`,
        );
        return { outcome, log: rec.log };
      };
      expect(await once(), scenario.name).toEqual(await once());
    }
  });

  it("tool ids differ between turns of one conversation", async () => {
    const ids = async (history: number) => {
      const rec = recorder();
      await run("demo tools", rec, {
        conversationHistory: Array.from({ length: history }, () => ({ role: "user" as const, content: "x" })),
      });
      return rec.of("tool").map((entry) => entry.event.toolUseId);
    };
    const first = await ids(0);
    const later = await ids(2);
    expect(first.some((id) => later.includes(id))).toBe(false);
  });
});
