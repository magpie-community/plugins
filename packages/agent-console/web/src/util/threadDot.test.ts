import { describe, it, expect } from "vitest";
import { threadDotClass } from "./threadDot";

const t = (status: any, lastTurnStatus: any = null, id = "a") => ({ id, status, lastTurnStatus }) as any;

describe("threadDotClass", () => {
  it("maps states with priority wait > run > err > ok > idle", () => {
    expect(threadDotClass(t("running", "completed"), new Set(["a"]))).toBe("dot wait");
    expect(threadDotClass(t("running", "failed"), new Set())).toBe("dot run");
    expect(threadDotClass(t("initializing"), new Set())).toBe("dot run");
    expect(threadDotClass(t("idle", "failed"), new Set())).toBe("dot err");
    expect(threadDotClass(t("error", "completed"), new Set())).toBe("dot err");
    expect(threadDotClass(t("idle", "completed"), new Set())).toBe("dot ok");
    expect(threadDotClass(t("idle", "interrupted"), new Set())).toBe("dot");
    expect(threadDotClass(t("idle", null), new Set())).toBe("dot");
  });
});
