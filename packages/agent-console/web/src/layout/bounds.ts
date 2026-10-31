import { SB_MIN, SB_MAX, PN_MIN, PN_MAX } from "../stores/ui.js";

/** The conversation area in the middle is at least this wide; narrower and Chinese text looks like garbled vertical text */
export const MAIN_MIN = 300;
const CHROME = 10; // The two drag handles

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export type LayoutWidthState = {
  sidebarWidth: number;
  panelWidth: number;
  panelOpen: boolean;
  sbHidden: boolean;
};

/** Maximum right panel width in the wide three-column layout (wider would squeeze out the conversation) */
export function maxPanelWidth(s: LayoutWidthState, vw = window.innerWidth): number {
  if (vw < 900) return PN_MAX;
  const sb = s.sbHidden ? 0 : s.sidebarWidth;
  return clamp(vw - sb - CHROME - MAIN_MIN, PN_MIN, PN_MAX);
}

/** Maximum sidebar width on wide screens */
export function maxSidebarWidth(s: LayoutWidthState, vw = window.innerWidth): number {
  if (vw < 760) return SB_MAX;
  const pn = s.panelOpen ? s.panelWidth : 0;
  return clamp(vw - pn - CHROME - MAIN_MIN, SB_MIN, SB_MAX);
}

/** Clamp the sidebar/panel widths to the valid range for the current window */
export function clampLayoutWidths(
  s: LayoutWidthState,
  vw = window.innerWidth,
): { sidebarWidth: number; panelWidth: number } {
  let sidebarWidth = clamp(s.sidebarWidth, SB_MIN, maxSidebarWidth(s, vw));
  let panelWidth = clamp(s.panelWidth, PN_MIN, maxPanelWidth({ ...s, sidebarWidth }, vw));
  sidebarWidth = clamp(sidebarWidth, SB_MIN, maxSidebarWidth({ ...s, sidebarWidth, panelWidth }, vw));
  panelWidth = clamp(panelWidth, PN_MIN, maxPanelWidth({ ...s, sidebarWidth, panelWidth }, vw));
  return { sidebarWidth, panelWidth };
}
