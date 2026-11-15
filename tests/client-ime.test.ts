import { describe, expect, it } from "vitest";
import { isImeComposing } from "../src/client/src/lib/ime.js";

describe("isImeComposing", () => {
  it("is true for a native composing keydown", () => {
    expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true);
  });

  it("is true for a React event whose native event composes", () => {
    expect(isImeComposing({ keyCode: 13, nativeEvent: { isComposing: true } })).toBe(true);
  });

  it("is true for the legacy keyCode 229 alone", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeComposing({ keyCode: 229, nativeEvent: { isComposing: false } })).toBe(true);
  });

  it("is false for an ordinary key", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeComposing({ keyCode: 27, nativeEvent: { isComposing: false } })).toBe(false);
    expect(isImeComposing({})).toBe(false);
  });
});
