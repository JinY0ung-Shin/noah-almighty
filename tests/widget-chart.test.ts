// `<chart>` in its simple form: `type` + `data` (+ `xKey`, `series`) becomes the
// Vega-Lite spec the one chart pipeline draws.
import { describe, expect, it } from "vitest";

import { MAX_CHART_ROWS, checkWidget, normalizeProps, simpleChartSpec } from "../src/shared/widget/index.js";

const rows = [
  { month: "1월", sales: 120, cost: 80 },
  { month: "2월", sales: 150, cost: 90 },
];

function spec(props: Record<string, unknown>) {
  const result = simpleChartSpec(normalizeProps("chart", props).props);
  return { ...result, spec: result.spec as any };
}

describe("simpleChartSpec", () => {
  it("draws a grouped bar chart from rows, defaulting xKey and series", () => {
    const { spec: s, problems } = spec({ data: rows });
    expect(problems).toEqual([]);
    expect(s.mark).toEqual({ type: "bar" });
    expect(s.data.values).toEqual([
      { x: "1월", series: "sales", value: 120 },
      { x: "1월", series: "cost", value: 80 },
      { x: "2월", series: "sales", value: 150 },
      { x: "2월", series: "cost", value: 90 },
    ]);
    expect(s.encoding.x).toMatchObject({ field: "x", type: "nominal", sort: null });
    expect(s.encoding.y).toMatchObject({ field: "value", type: "quantitative", stack: null });
    expect(s.encoding.color.scale.domain).toEqual(["sales", "cost"]);
    expect(s.encoding.xOffset).toMatchObject({ field: "series" });
  });

  it("labels the series, names the unit and the title, and stacks or flips on request", () => {
    const { spec: s } = spec({ data: rows, xKey: "month", series: [{ key: "sales", label: "매출" }, "cost"], unit: "만원", title: "월별", stacked: true, horizontal: true });
    expect(s.title).toBe("월별");
    expect(s.encoding.color.scale.domain).toEqual(["매출", "cost"]);
    expect(s.encoding.y).toMatchObject({ field: "x" });
    expect(s.encoding.x).toMatchObject({ field: "value", stack: "zero", title: "만원" });
    expect(s.encoding.yOffset).toBeUndefined();
    // One series: no legend, and the axis names it.
    const one = spec({ data: rows, series: ["sales"], unit: "만원" }).spec;
    expect(one.encoding.color).toBeUndefined();
    expect(one.encoding.y.title).toBe("sales (만원)");
  });

  it("draws line and area charts, keeping a numeric x axis numeric", () => {
    const line = spec({ type: "line", data: [{ t: 1, v: 3 }, { t: 2, v: 5 }], xKey: "t" }).spec;
    expect(line.mark).toEqual({ type: "line", point: true });
    expect(line.encoding.x).toMatchObject({ field: "x", type: "quantitative" });
    const area = spec({ type: "area", data: rows, stacked: true }).spec;
    expect(area.mark).toMatchObject({ type: "area" });
    expect(area.encoding.x).toMatchObject({ type: "ordinal", sort: null });
    expect(area.encoding.y.stack).toBe("zero");
  });

  it("draws a pie or a donut from the first series", () => {
    const { spec: s, problems } = spec({ type: "donut", data: [{ name: "주거", value: 85 }, { name: "식비", value: "62만원" }], xKey: "name" });
    expect(problems).toEqual([]);
    expect(s.mark).toEqual({ type: "arc", innerRadius: 60 });
    expect(s.data.values).toEqual([{ x: "주거", value: 85 }, { x: "식비", value: 62 }]);
    expect(s.encoding.color.scale.domain).toEqual(["주거", "식비"]);
    expect(spec({ type: "pie", data: rows }).problems).toEqual(['a pie chart draws one series; "sales" is shown']);
  });

  it("says what it could not use, and draws nothing from nothing", () => {
    expect(spec({ data: [] })).toMatchObject({ spec: null, problems: [] });
    expect(spec({ data: [{ a: "x", b: "y" }] })).toMatchObject({ spec: null, problems: ["the rows have no numeric key to plot"] });
    const wrong = spec({ data: rows, xKey: "date", series: ["profit", "sales"] });
    expect(wrong.problems).toEqual(['xKey "date" is not a key of the rows (month, sales, cost)', 'series "profit" is not a key of the rows (month, sales, cost)']);
    expect(wrong.spec.data.values).toHaveLength(2);
    const many = Array.from({ length: MAX_CHART_ROWS + 5 }, (_, i) => ({ k: `r${i}`, v: i }));
    // (`normalizeProps` already caps a rows prop; the converter keeps its own cap for any other caller.)
    const cut = simpleChartSpec({ data: many });
    expect(cut.problems).toEqual([`data has ${MAX_CHART_ROWS + 5} rows; only the first ${MAX_CHART_ROWS} are drawn`]);
    expect((cut.spec as any).data.values).toHaveLength(MAX_CHART_ROWS);
  });
});

describe("<chart> in the static check", () => {
  it("takes exactly one of data | spec", () => {
    expect(checkWidget('<chart type="bar" data={[{ a: "x", b: 1 }]} xKey="a" series={["b"]} unit="건" title="t" />')).toMatchObject({ ok: true });
    expect(checkWidget('<chart spec={{ mark: "bar", data: { values: [] } }} />')).toMatchObject({ ok: true });
    const none = checkWidget("<chart height={200} />");
    expect(none.ok ? "" : none.error).toMatch(/<chart> needs EXACTLY ONE of data \| spec .* It has none\./);
    const both = checkWidget('<chart data={[]} spec={{ mark: "bar" }} />');
    expect(both.ok ? "" : both.error).toMatch(/It has data and spec: keep one/);
    const type = checkWidget('<chart type="scatter" data={[]} />');
    expect(type.ok ? "" : type.error).toMatch(/type/);
  });
});
