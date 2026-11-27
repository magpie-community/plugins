/**
 * A valid v0.7.0 task profile for tests: the fields the classifier answers (the work kind and its depth, the optional second kind,
 * the access split, the flags, the hours and the task count), with the per-category demand (`axis_demand`, levels 0..3) stated
 * explicitly so a test controls it; without it the demand is projected from the kinds (`projectAxisDemand`).
 * `profile({ ...overrides })` overrides any field; `demand({ coding: 3 })` overrides the demand alone. Tests that need a
 * particular shape say so here and nowhere else.
 */
export const BASE_PROFILE = Object.freeze({
  work_kind: "code_implementation",
  primary_level: 2,
  secondary_kind: "none",
  secondary_level: 0,
  access: "write",
  local_only: false,
  needs_visual: false,
  wants_fast: false,
  expected_hours: 0.5,
  task_count: "1",
  axis_demand: Object.freeze({ creativity: 0, coding: 2, aesthetics: 0, tool_operation: 0 }),
});

export function demand(overrides = {}) {
  return { ...BASE_PROFILE.axis_demand, ...overrides };
}

export function profile(overrides = {}) {
  const { axis_demand: axis, ...rest } = overrides;
  return { ...BASE_PROFILE, ...rest, axis_demand: demand(axis || {}) };
}

/** A read-only review: no production code written, demand on coding only. */
export const REVIEW = profile({ work_kind: "code_audit", access: "read-only", axis_demand: { coding: 2 } });
/** Routine work: nothing to think hard about, a little code. */
export const ROUTINE = profile({ primary_level: 1, axis_demand: { coding: 1 } });
