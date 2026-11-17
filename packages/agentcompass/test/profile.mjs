/**
 * A valid v0.6.0 task profile for tests: the fields the classifier answers, with the per-category demand (`axis_demand`, levels
 * 0..3). `profile({ ...overrides })` overrides any field; `demand({ coding: 3 })` overrides the demand alone. Tests that need a
 * particular shape say so here and nowhere else.
 */
export const BASE_PROFILE = Object.freeze({
  work_kind: "general_implementation",
  reasoning_depth: 2,
  code_complexity: 2,
  needs_visual: false,
  needs_gui: false,
  local_only: false,
  wants_fast: false,
  read_only_review: false,
  access: "write",
  interaction_style: "engineering",
  expected_hours: 0.5,
  hours_confidence: "medium",
  urgency: "unknown",
  multi_task: false,
  task_count: "1",
  axis_demand: Object.freeze({ divergence: 0, coding: 2, aesthetics: 0, tool_operation: 0 }),
});

export function demand(overrides = {}) {
  return { ...BASE_PROFILE.axis_demand, ...overrides };
}

export function profile(overrides = {}) {
  const { axis_demand: axis, ...rest } = overrides;
  return { ...BASE_PROFILE, ...rest, axis_demand: demand(axis || {}) };
}

/** A read-only review: no production code written, demand on coding only. */
export const REVIEW = profile({ code_complexity: 0, access: "read-only", read_only_review: true, axis_demand: { coding: 2 } });
/** Routine work: nothing to think hard about, a little code. */
export const ROUTINE = profile({ reasoning_depth: 1, code_complexity: 1, axis_demand: { coding: 1 } });
