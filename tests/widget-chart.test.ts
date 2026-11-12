// `<chart>`: `type` + `data` (+ `xKey`, `series`) is read into the model the
// client's chart components draw. (Until 2026-11-12 it became a Vega-Lite spec;
// a whole `spec` prop is retired with Vega and answered with a redirect.)
import { describe, expect, it } from "vitest";

import { CHART_SPEC_RETIRED, MAX_CHART_ROWS, checkWidget, normalizeProps, simpleChartModel } from "../src/shared/widget/index.js";

const rows = [
  { month: "1월", sales: 120, cost: 80 },
  { month: "2월", sales: 150, cost: 90 },
];

function read(props: Record<string, unknown>) {
  const result = simpleChartModel(normalizeProps("chart", props).props);
  return { problems: result.problems, model: result.model! };
}

describe("simpleChartModel", () => {
  it("reads a grouped bar chart from rows, defaulting xKey and series", () => {
    const { model, problems } = read({ data: rows });
    expect(problems).toEqual([]);
    expect(model).toMatchObject({ type: "bar", names: ["sales", "cost"], stacked: false, horizontal: false, numericX: false, title: "", unit: "" });
    expect(model.values).toEqual([
      { x: "1월", series: "sales", value: 120 },
      { x: "1월", series: "cost", value: 80 },
      { x: "2월", series: "sales", value: 150 },
      { x: "2월", series: "cost", value: 90 },
    ]);
  });

  it("labels the series, names the unit and the title, and stacks or flips on request", () => {
    const { model } = read({ data: rows, xKey: "month", series: [{ key: "sales", label: "매출" }, "cost"], unit: "만원", title: "월별", stacked: true, horizontal: true });
    expect(model).toMatchObject({ title: "월별", unit: "만원", names: ["매출", "cost"], stacked: true, horizontal: true });
    expect(model.values[0]).toEqual({ x: "1월", series: "매출", value: 120 });
    // One series: one name.
    expect(read({ data: rows, series: ["sales"], unit: "만원" }).model.names).toEqual(["sales"]);
    // `horizontal` is a bar's, `stacked` is not a line's.
    expect(read({ type: "line", data: rows, stacked: true, horizontal: true }).model).toMatchObject({ stacked: false, horizontal: false });
    expect(read({ type: "area", data: rows, stacked: true, horizontal: true }).model).toMatchObject({ stacked: true, horizontal: false });
  });

  it("reads line and area charts, keeping a numeric x axis numeric", () => {
    const line = read({ type: "line", data: [{ t: 1, v: 3 }, { t: 2, v: 5 }], xKey: "t" }).model;
    expect(line).toMatchObject({ type: "line", numericX: true });
    expect(line.values).toEqual([
      { x: 1, series: "v", value: 3 },
      { x: 2, series: "v", value: 5 },
    ]);
    // A bar keeps categories even over numbers; an area over names is categorical.
    expect(read({ data: [{ t: 1, v: 3 }], xKey: "t" }).model).toMatchObject({ type: "bar", numericX: false });
    expect(read({ type: "area", data: rows, stacked: true }).model).toMatchObject({ type: "area", numericX: false, stacked: true });
  });

  it("reads a pie or a donut from the first series, parsing the numbers", () => {
    const { model, problems } = read({ type: "donut", data: [{ name: "주거", value: 85 }, { name: "식비", value: "62만원" }], xKey: "name" });
    expect(problems).toEqual([]);
    expect(model).toMatchObject({ type: "donut", names: ["value"] });
    expect(model.values).toEqual([
      { x: "주거", series: "value", value: 85 },
      { x: "식비", series: "value", value: 62 },
    ]);
    expect(read({ type: "pie", data: rows }).problems).toEqual(['a pie chart draws one series; "sales" is shown']);
  });

  it("says what it could not use, and reads nothing from nothing", () => {
    expect(simpleChartModel(normalizeProps("chart", { data: [] }).props)).toEqual({ model: null, problems: [] });
    expect(simpleChartModel(normalizeProps("chart", { data: [{ a: "x", b: "y" }] }).props)).toEqual({ model: null, problems: ["the rows have no numeric key to plot"] });
    const wrong = read({ data: rows, xKey: "date", series: ["profit", "sales"] });
    expect(wrong.problems).toEqual(['xKey "date" is not a key of the rows (month, sales, cost)', 'series "profit" is not a key of the rows (month, sales, cost)']);
    expect(wrong.model.values).toHaveLength(2);
    const many = Array.from({ length: MAX_CHART_ROWS + 5 }, (_, i) => ({ k: `r${i}`, v: i }));
    // (`normalizeProps` already caps a rows prop; the reader keeps its own cap for any other caller.)
    const cut = simpleChartModel({ data: many });
    expect(cut.problems).toEqual([`data has ${MAX_CHART_ROWS + 5} rows; only the first ${MAX_CHART_ROWS} are drawn`]);
    expect(cut.model!.values).toHaveLength(MAX_CHART_ROWS);
  });
});

describe("<chart> in the static check", () => {
  it("needs data, and knows its five types", () => {
    expect(checkWidget('<chart type="bar" data={[{ a: "x", b: 1 }]} xKey="a" series={["b"]} unit="건" title="t" />')).toMatchObject({ ok: true });
    const none = checkWidget("<chart height={200} />");
    expect(none.ok ? "" : none.error).toMatch(/<chart>.*data/);
    const type = checkWidget('<chart type="scatter" data={[]} />');
    expect(type.ok ? "" : type.error).toMatch(/type/);
  });

  it("answers the retired Vega-Lite `spec` prop with what to write instead", () => {
    const retired = checkWidget('<chart spec={{ mark: "bar", data: { values: [] } }} />');
    expect(retired.ok).toBe(false);
    const error = retired.ok ? "" : retired.error;
    expect(error).toContain('<chart> has no prop "spec".');
    expect(error).toContain(CHART_SPEC_RETIRED);
    expect(CHART_SPEC_RETIRED).toBe(
      "A Vega-Lite `spec` is retired: the app no longer draws one. Write the chart as type + data (+ xKey, series) — bar, line, area, pie or donut — or give the numbers as a <table>.",
    );
  });
});
