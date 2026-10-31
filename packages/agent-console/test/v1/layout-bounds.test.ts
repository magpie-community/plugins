import { describe, it, expect } from "vitest";
import { maxPanelWidth, clampLayoutWidths, MAIN_MIN } from "../../web/src/layout/bounds.js";

describe("layout bounds", () => {
  const base = { sidebarWidth: 248, panelWidth: 440, panelOpen: true, sbHidden: false };

  it("the right panel cannot exceed the window minus the sidebar and MAIN_MIN", () => {
    const vw = 1200;
    expect(maxPanelWidth(base, vw)).toBe(1200 - 248 - 10 - MAIN_MIN);
  });

  it("clamp shrinks the panel when the window is narrow", () => {
    const sized = clampLayoutWidths({ ...base, panelWidth: 900 }, 1000);
    expect(sized.panelWidth).toBeLessThan(900);
    expect(1000 - sized.sidebarWidth - sized.panelWidth - 10).toBeGreaterThanOrEqual(MAIN_MIN - 1);
  });

  it("the panel's upper bound shrinks when the sidebar widens", () => {
    const vw = 1100;
    const a = maxPanelWidth({ ...base, sidebarWidth: 248 }, vw);
    const b = maxPanelWidth({ ...base, sidebarWidth: 360 }, vw);
    expect(b).toBeLessThan(a);
  });
});
