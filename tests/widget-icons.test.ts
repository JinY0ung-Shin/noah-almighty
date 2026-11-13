// Widget icons: `<icon name>` and the `icon` prop of a button / callout take
// ONLY the names the app itself draws (client `lib/icons.ts`). The shared
// library cannot import a client module, so it keeps its own list — this file
// is what fails when the two drift apart.
import { describe, expect, it } from "vitest";

import { ICON_PATHS } from "../src/client/src/lib/icons.js";
import { checkWidget } from "../src/shared/widget/check.js";
import { WIDGET_ICON_NAMES, WIDGET_ICON_SIZES } from "../src/shared/widget/icons.js";
import { nearestFew } from "../src/shared/widget/names.js";
import { WIDGET_COMPONENTS, normalizeProps, widgetComponentReference } from "../src/shared/widget/spec.js";
import { COLOR_TOKENS } from "../src/shared/widget/style.js";

const errorOf = (src: string): string => {
  const r = checkWidget(src);
  expect(r.ok, "expected the check to fail").toBe(false);
  return r.ok ? "" : r.error;
};
const ok = (src: string) => {
  const r = checkWidget(src);
  expect(r, r.ok ? "" : r.error).toMatchObject({ ok: true });
};

describe("widget icon names", () => {
  it("are exactly the icons Icon.tsx draws — add or remove one in BOTH places", () => {
    expect([...WIDGET_ICON_NAMES].sort()).toEqual(Object.keys(ICON_PATHS).sort());
    expect(new Set(WIDGET_ICON_NAMES).size).toBe(WIDGET_ICON_NAMES.length);
    // every name draws something, and none is reachable through Object.prototype
    for (const name of WIDGET_ICON_NAMES) expect(Object.prototype.hasOwnProperty.call(ICON_PATHS, name) && ICON_PATHS[name].length > 0, name).toBe(true);
    expect(WIDGET_ICON_NAMES).not.toContain("constructor");
    expect(Object.isFrozen(WIDGET_ICON_NAMES)).toBe(true);
  });

  it("the spec takes them as an enum on <icon>, <button> and <callout>", () => {
    const icon = WIDGET_COMPONENTS.icon;
    expect(icon.child).toBe("none");
    expect(icon.props.name).toMatchObject({ required: true, type: { k: "enum", values: WIDGET_ICON_NAMES } });
    expect(icon.props.color.type).toEqual({ k: "enum", values: COLOR_TOKENS });
    expect(icon.props.size.type).toEqual({ k: "enum", values: Object.keys(WIDGET_ICON_SIZES) });
    expect(WIDGET_ICON_SIZES).toEqual({ sm: 14, md: 18, lg: 24, xl: 32 });
    expect(WIDGET_COMPONENTS.button.props.icon.type).toEqual({ k: "enum", values: WIDGET_ICON_NAMES });
    expect(WIDGET_COMPONENTS.callout.props.icon.type).toEqual({ k: "enum", values: WIDGET_ICON_NAMES });
    // the manual lists the names once
    const ref = widgetComponentReference();
    expect(ref.split(WIDGET_ICON_NAMES.join(" ")).length).toBe(2);
  });

  it("accepts every name, in all three places", () => {
    ok(WIDGET_ICON_NAMES.map((name) => `<icon name="${name}" />`).join("\n"));
    ok('<icon name="check" size="lg" color="success" label="완료" />\n<button send="다시" icon="refresh">다시 시도</button>\n<callout tone="warning" icon="clock" title="마감">내일까지입니다.</callout>');
    ok('{@state done = false}\n<row><icon name={done ? "check" : "clock"} /><button onClick={() => setDone(true)} icon="check" label="완료" /></row>');
  });

  it("an unknown name is refused with the nearest valid names and the whole list", () => {
    const err = errorOf('<icon name="arrow" />');
    expect(err).toMatch(/line 1:7 — Prop "name" of <icon> must be an existing name: "arrow" is not one — nearest: arrow-down\. All 59: compass, chat, user, /);
    expect(err).toContain(`All ${WIDGET_ICON_NAMES.length}: ${WIDGET_ICON_NAMES.join(", ")}.`);
    expect(errorOf('<icon name="chevron" />')).toMatch(/"chevron" is not one — nearest: chevron-up, chevron-left, chevron-right\./);
    expect(errorOf('<icon name="serch" />')).toMatch(/"serch" is not one — nearest: search\./);
    expect(errorOf('<icon name="Trash" />')).toMatch(/"Trash" is not one — nearest: trash\./);
    expect(errorOf('<icon name={"x-mark"} />')).toMatch(/Prop "name" of <icon> must be an existing name: "x-mark" is not one\. All 59: /);
    expect(errorOf('<button send="a" icon="rocket">go</button>')).toMatch(/Prop "icon" of <button> must be an existing name: "rocket" is not one/);
    expect(errorOf('<callout icon="warn">x</callout>')).toMatch(/Prop "icon" of <callout> must be an existing name: "warn" is not one/);
    // not a way to reach an Object member, a path or markup
    for (const name of ["constructor", "__proto__", "../icons", "<svg onload=alert(1)>", ""]) {
      expect(errorOf(`<icon name=${JSON.stringify(name)} />`), name).toMatch(/Prop "name" of <icon> must be an existing name/);
    }
    expect(errorOf("<icon />")).toMatch(/<icon> is missing the required prop "name"/);
    expect(errorOf('<icon name="check" size="huge" />')).toMatch(/Prop "size" of <icon> must be one of sm, md, lg, xl/);
    expect(errorOf('<icon name="check" color="#f00" />')).toMatch(/Prop "color" of <icon> must be one of default, muted, accent, success, warning, danger, info/);
    expect(errorOf('<icon name="check" style="color:red" />')).toMatch(/Styling props are not supported/);
  });

  it("a computed name that is not an icon draws NO icon (never some other one) and says so", () => {
    expect(normalizeProps("icon", { name: "check", size: "lg", color: "accent", label: "완료" })).toEqual({
      props: Object.assign(Object.create(null), { name: "check", size: "lg", color: "accent", label: "완료" }),
      errors: [],
    });
    const bad = normalizeProps("icon", { name: "serch" });
    expect(bad.props.name).toBe(undefined);
    expect(bad.errors).toEqual(['name: "serch" is not one of its names (nearest: search)']);
    for (const name of ["constructor", "__proto__", "toString", 5, null, undefined, ["check"], { name: "check" }]) {
      const r = normalizeProps("icon", { name });
      expect(r.props.name, String(name)).toBe(undefined);
      expect(r.errors.join(), String(name)).toMatch(/^name: .* is not one of its names/);
    }
    // an optional icon that is not one is simply left out
    expect(normalizeProps("button", { label: "x", icon: "rocket" })).toEqual({ props: Object.assign(Object.create(null), { label: "x" }), errors: [] });
    expect(normalizeProps("callout", { icon: "clock" }).props.icon).toBe("clock");
  });

  it("nearestFew: near misses first, then names that contain the word", () => {
    expect(nearestFew("chevron-rihgt", WIDGET_ICON_NAMES)).toEqual(["chevron-right"]);
    expect(nearestFew("arrow", WIDGET_ICON_NAMES)).toEqual(["arrow-down"]);
    expect(nearestFew("file_text", WIDGET_ICON_NAMES)[0]).toBe("file-text");
    expect(nearestFew("zzzzzz", WIDGET_ICON_NAMES)).toEqual([]);
    expect(nearestFew("", WIDGET_ICON_NAMES)).toEqual([]);
    expect(nearestFew("a".repeat(5000), WIDGET_ICON_NAMES)).toEqual([]);
  });
});
