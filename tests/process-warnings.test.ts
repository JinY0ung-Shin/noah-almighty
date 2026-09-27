import { describe, expect, it } from "vitest";
import {
  filterAdvisoryProcessWarnings,
  processWarningCode,
} from "../src/server/processWarnings.js";

describe("advisory process-warning filter", () => {
  it("reads the warning code from every emitWarning call shape", () => {
    expect(processWarningCode("m", [{ code: "X" }])).toBe("X");
    expect(processWarningCode("m", ["Warning", "Y"])).toBe("Y");
    expect(processWarningCode(Object.assign(new Error("m"), { code: "Z" }), [])).toBe("Z");
    expect(processWarningCode("m", [])).toBeUndefined();
    expect(processWarningCode("m", ["Warning"])).toBeUndefined();
  });

  it("drops only the SDK's canUseTool-shadowed advisory and passes the rest through", () => {
    // Install over a spy so pass-through is observable without printing anything.
    const original = process.emitWarning;
    const passed: unknown[][] = [];
    process.emitWarning = ((...args: unknown[]) => {
      passed.push(args);
    }) as typeof process.emitWarning;
    try {
      filterAdvisoryProcessWarnings();
      process.emitWarning("shadowed", { code: "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED" });
      process.emitWarning("kept", { code: "SOME_OTHER_WARNING" });
      process.emitWarning("plain");
    } finally {
      process.emitWarning = original;
    }
    expect(passed).toEqual([["kept", { code: "SOME_OTHER_WARNING" }], ["plain"]]);
  });
});
