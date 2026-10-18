import { describe, expect, it } from "vitest";
import { mermaidSyntaxError } from "../src/server/agent/canvasTools.js";
import { checkMermaidSyntax } from "../src/server/agent/mermaidCheck.js";

// The check may only ever ADD a correct rejection (#69): every valid diagram
// below must come back ok (or, at worst, unverified) — never a syntax error.
const VALID: Record<string, string> = {
  flowchartQuoted: 'flowchart LR\n  P_OMG ==>|"/api/llm (모델 호출)"| U_EDGE\n  A["노드 (괄호)"] --> B{"결정?"}',
  flowchartPlain: "graph TD; A-->B",
  sequence: "sequenceDiagram\n  participant A as 사용자\n  A->>B: 요청 (json)\n  B-->>A: 응답",
  classDiagram: "classDiagram\n  class Animal {\n    +String name\n    +eat() void\n  }\n  Animal <|-- Dog",
  state: "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running : start\n  Running --> [*]",
  er: "erDiagram\n  USER ||--o{ ORDER : places",
  gantt: "gantt\n  dateFormat YYYY-MM-DD\n  section A\n  작업1 :a1, 2026-10-01, 3d",
  pie: 'pie title 비율\n  "A" : 40\n  "B" : 60',
  mindmap: "mindmap\n  root((중심))\n    가지1\n    가지2",
  timeline: "timeline\n  title 일정\n  2026 : 시작",
  gitGraph: "gitGraph\n  commit\n  branch dev\n  commit\n  checkout main\n  merge dev",
  journey: "journey\n  title 하루\n  section 아침\n    일어나기: 3: 나",
  quadrant: "quadrantChart\n  x-axis Low --> High\n  y-axis Low --> High\n  A: [0.3, 0.6]",
  xychart: 'xychart-beta\n  x-axis [a, b]\n  y-axis "v" 0 --> 10\n  bar [3, 5]',
  kanban: "kanban\n  todo[할 일]\n    t1[작업]",
  block: "block-beta\n  columns 2\n  a b",
};

describe("checkMermaidSyntax (#69)", () => {
  it("rejects the unquoted parenthesis inside an edge label from the issue", async () => {
    const res = await checkMermaidSyntax("flowchart LR\n  P_OMG ==>|/api/llm (모델 호출)| U_EDGE");
    expect(res.ok).toBe(false);
    if (res.ok === false) {
      expect(res.error).toContain("Parse error on line 2");
      expect(res.error).toContain("got 'PS'");
    }
  });

  it("rejects an unknown diagram type with a hint about the first line", async () => {
    const res = await checkMermaidSyntax("notADiagram\n  A --> B");
    expect(res.ok).toBe(false);
    if (res.ok === false) expect(mermaidSyntaxError(res.error)).toContain("first line must name a supported diagram type");
  });

  // A parse that spins (mermaid's entity regex on this input) must fail OPEN
  // and not wedge the checker: the next call gets a fresh worker and a verdict.
  it("fails open on a hung parse and recovers", { timeout: 20_000 }, async () => {
    const hung = await checkMermaidSyntax("flowchart LR\n" + "style :#".repeat(2490));
    expect(hung.ok).toBe("unverified");
    expect(await checkMermaidSyntax(VALID.flowchartQuoted)).toEqual({ ok: true });
    expect((await checkMermaidSyntax("flowchart LR\n  A -->|x (y)| B")).ok).toBe(false);
  });

  // `ok: true`, not merely "not rejected": an `unverified` here means the worker
  // environment broke (e.g. after a mermaid upgrade) and the check went dark.
  it.each(Object.entries(VALID))("verifies a valid %s diagram", async (_name, source) => {
    expect(await checkMermaidSyntax(source)).toEqual({ ok: true });
  });
});
