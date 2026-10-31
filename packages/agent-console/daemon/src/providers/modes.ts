import type { Mode } from "./types.js";

/** Map a permission mode onto an Agent's modes: kept when it has it, else that Agent's "default", else its first mode. */
export function clampMode(modes: Mode[], mode: Mode | null | undefined): Mode {
  if (mode && modes.includes(mode)) return mode;
  if (modes.includes("default")) return "default";
  return modes[0] ?? "default";
}
