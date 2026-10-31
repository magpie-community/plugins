import { describe, expect, it } from "vitest";
import { isImeComposing } from "./ime";

describe("isImeComposing", () => {
  it("Chrome: isComposing", () => expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true));
  it("WebKit: confirm-candidate Enter has keyCode 229", () => expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true));
  it("plain Enter", () => expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false));
});
