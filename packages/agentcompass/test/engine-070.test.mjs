/**
 * Rules of the AgentCompass v0.7.0 engine the port carries, each tested as the rule it states (never a winner): the 11 work kinds and
 * the declared projection of the demand, the profile's derivations and contradictions, the question set, the level scale whose level
 * 3 is the panel's best, the upgrade of the operator's older `userScores`, and the facets an aesthetics demand asks for.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { LEVEL_FACETS, FACET_CATEGORY } from "../src/axis-scores.js";
import { rankCandidates, selectBestRoute } from "../src/allocator.js";
import { LEVEL3_CONVERSIONS } from "../src/reference-data.js";
import {
  PROFILE_KINDS,
  ROLE_FN,
  SECONDARY_KINDS,
  TASK_PROFILE_SCHEMA,
  WORK_KINDS,
  WORK_KIND_SIGNATURES,
  noTextProfile,
  projectAxisDemand,
  resolveCallerProfile,
  validateProfile,
} from "../src/profiler-core.js";
import { compactRubric, parseJevScorerAnswer, profileQuestions, scorerEvidence, scorerSchema } from "../src/scorer-live.js";
import { profileDifficulty } from "../src/task-intake.js";
import { SCHEMA_VERSION, convertLevel, levelToZ, upgradeScores, validateScores, zToLevel } from "../src/user-scores.js";
import { profile } from "./profile.mjs";

const AXES = ["creativity", "coding", "aesthetics", "tool_operation"];
const bare = (over = {}) => {
  const p = profile(over);
  delete p.axis_demand;
  return { ...p, ...over };
};

test("the work kinds are the 11 of task_intake, plus the unmatched bucket as a route only", () => {
  assert.equal(WORK_KINDS.length, 11);
  assert.deepEqual(PROFILE_KINDS, [...WORK_KINDS, "other_or_mixed"]);
  assert.deepEqual(SECONDARY_KINDS, ["none", ...WORK_KINDS]);
  assert.deepEqual(Object.keys(WORK_KIND_SIGNATURES).sort(), [...WORK_KINDS].sort());
  assert.throws(() => validateProfile(bare({ work_kind: "other_or_mixed" })), /work_kind/);
  assert.deepEqual(TASK_PROFILE_SCHEMA.required, ["work_kind", "primary_level", "secondary_kind", "secondary_level", "access", "local_only", "needs_visual", "wants_fast", "expected_hours", "task_count"]);
});

test("the demand is the declared signature at the depth, the element-wise max of both kinds, never above 3", () => {
  for (const kind of WORK_KINDS) {
    for (const level of [1, 2, 3]) {
      const one = projectAxisDemand(kind, level);
      assert.deepEqual(one, Object.fromEntries(AXES.map((a, i) => [a, ROLE_FN[WORK_KIND_SIGNATURES[kind][i]](level)])), `${kind}@${level}`);
      for (const a of AXES) assert.ok(one[a] >= 0 && one[a] <= 3);
      if (level > 1) for (const a of AXES) assert.ok(one[a] >= projectAxisDemand(kind, level - 1)[a], "deeper never asks less");
      for (const second of WORK_KINDS) {
        if (second === kind) continue;
        const both = projectAxisDemand(kind, level, second, 2);
        const other = projectAxisDemand(second, 2);
        for (const a of AXES) assert.equal(both[a], Math.max(one[a], other[a]), `${kind}+${second} ${a}`);
      }
    }
  }
  // The primary role is the depth itself; the floors of a live loop and a GUI do not move with it.
  assert.equal(projectAxisDemand("code_implementation", 3).coding, 3);
  assert.equal(projectAxisDemand("live_loop", 1).tool_operation, 2);
  assert.equal(projectAxisDemand("gui_control", 1).tool_operation, 3);
});

test("a validated profile carries its derived fields, and an explicit demand stands as given", () => {
  const p = validateProfile(bare({ work_kind: "frontend_ui", primary_level: 3, secondary_kind: "gui_control", secondary_level: 1 }));
  assert.deepEqual(p.axis_demand, projectAxisDemand("frontend_ui", 3, "gui_control", 1));
  assert.equal(p.needs_gui, true);
  assert.equal(p.needs_visual, true, "a GUI is visual");
  assert.equal(p.read_only_review, false);
  assert.equal(p.multi_task, false);
  assert.equal(validateProfile(bare({ work_kind: "visual_analysis", access: "read-only" })).needs_visual, true);
  assert.equal(validateProfile(bare({ work_kind: "code_audit", access: "read-only" })).read_only_review, true);
  assert.equal(validateProfile(bare({ task_count: "3" })).multi_task, true);
  const explicit = { creativity: 1, coding: 0, aesthetics: 2, tool_operation: 0 };
  assert.deepEqual(validateProfile({ ...bare(), axis_demand: explicit }).axis_demand, explicit);
  const once = validateProfile(bare());
  assert.deepEqual(validateProfile(once), once, "a validated profile validates to itself");
});

test("contradictions are refused, not repaired", () => {
  for (const bad of [
    { secondary_kind: "none", secondary_level: 2 },
    { secondary_kind: "web_research", secondary_level: 0 },
    { secondary_kind: "code_implementation", secondary_level: 1 },
    { work_kind: "code_audit", access: "write" },
    { work_kind: "code_implementation", local_only: true, access: "read-only" },
    { work_kind: "frontend_ui", local_only: true, access: "read-only" },
    { work_kind: "gui_control", needs_gui: false },
    { work_kind: "code_audit", access: "read-only", read_only_review: false },
    { task_count: "2", multi_task: false },
    { primary_level: 0 },
    { primary_level: 4 },
  ]) {
    assert.throws(() => validateProfile(bare(bad)), Error, JSON.stringify(bad));
    assert.equal(selectBestRoute(bare(bad), { candidateModels: ["gpt-6.1-sol"] }).ok, false, JSON.stringify(bad));
  }
});

test("a profile of the 0.2.x shape is refused: no compatibility reader", () => {
  const old = {
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
    multi_task: false,
    task_count: "1",
    axis_demand: { divergence: 0, coding: 2, aesthetics: 0, tool_operation: 0 },
  };
  assert.throws(() => validateProfile(old), /work_kind/);
  assert.throws(() => validateProfile({ ...old, work_kind: "code_implementation" }), /primary_level/);
  assert.match(resolveCallerProfile(old).error, /^invalid_caller_profile/, "the hosts refuse it as the caller's");
  assert.match(selectBestRoute({ profile: old }, { candidateModels: ["gpt-6.1-sol"] }).refusal || "", /invalid_caller_profile/);
});

test("the difficulty label follows difficulty_by_level, and depth 3 of reasoning or invention reads frontier", () => {
  const policy = { profile: { difficulty_by_level: { 1: "routine", 2: "hard", 3: "coupled" } } };
  for (const kind of WORK_KINDS) {
    for (const level of [1, 2, 3]) {
      const label = profileDifficulty(validateProfile(bare({ work_kind: kind, primary_level: level, access: kind === "code_audit" ? "read-only" : "write" })), policy);
      const frontier = level === 3 && ["architecture_reasoning", "creative_ideation"].includes(kind);
      assert.equal(label, frontier ? "frontier" : policy.profile.difficulty_by_level[level], `${kind}@${level}`);
    }
  }
  assert.equal(profileDifficulty(validateProfile(bare({ primary_level: 3, secondary_kind: "web_research", secondary_level: 3 })), policy), "frontier");
  assert.equal(profileDifficulty(validateProfile(bare({ primary_level: 2, secondary_kind: "web_research", secondary_level: 3 })), policy), "hard", "frontier needs the primary at depth 3");
});

test("the no-text profile states only what the request's structure says", () => {
  for (const facts of [{}, { hasVisualInput: true }, { hasComputerUse: true }]) {
    const p = validateProfile(noTextProfile(facts));
    const image = Boolean(facts.hasVisualInput || facts.hasComputerUse);
    assert.deepEqual(p.axis_demand, { creativity: 0, coding: 0, aesthetics: 0, tool_operation: image ? 3 : 0 });
    assert.equal(p.needs_gui, Boolean(facts.hasComputerUse));
    assert.equal(p.needs_visual, image);
  }
});

test("the question set is scorer_client's: ten answers, the second kind reconciled the way the Python reconciles it", () => {
  const q = profileQuestions();
  assert.deepEqual(Object.keys(q).sort(), ["access", "effort_band", "local_only", "needs_visual", "primary_level", "secondary_kind", "secondary_level", "task_count", "wants_fast", "work_kind"]);
  assert.deepEqual(Object.keys(q.work_kind.criteria).sort(), [...WORK_KINDS].sort());
  assert.deepEqual(Object.keys(q.secondary_kind.criteria).sort(), ["none", ...WORK_KINDS].sort());
  const answers = (over) => ({
    answers: {
      work_kind: { choice: "code_implementation" },
      primary_level: { score: 1 },
      secondary_kind: { choice: "none" },
      secondary_level: { score: 0 },
      local_only: { noul: 0.1 },
      needs_visual: { noul: 0.1 },
      wants_fast: { noul: 0.1 },
      effort_band: { choice: "module" },
      access: { choice: "write" },
      task_count: { choice: "1" },
      ...over,
    },
  });
  assert.equal(parseJevScorerAnswer(answers()).primary_level, 2, "a score is the level index above the range's floor");
  const same = parseJevScorerAnswer(answers({ secondary_kind: { choice: "code_implementation" }, secondary_level: { score: 2 } }));
  assert.deepEqual([same.secondary_kind, same.secondary_level], ["none", 0], "the kind beside itself is single-domain");
  const lifted = parseJevScorerAnswer(answers({ secondary_kind: { choice: "web_research" }, secondary_level: { score: 0 } }));
  assert.deepEqual([lifted.secondary_kind, lifted.secondary_level], ["web_research", 1], "a named second kind is at least depth 1");
});

test("the scorer's evidence carries the classifier cases compacted, and its schema only the catalogue's routes", () => {
  const rubric = compactRubric();
  const [, , columns] = rubric.calibration_columns;
  assert.ok(columns.includes("work_kind") && columns.includes("primary_level"));
  for (const row of rubric.calibration_cases) assert.equal(row[2].length, columns.length);
  const evidence = scorerEvidence({ objective: "Rename foo", previousUser: "x" });
  assert.match(evidence, /^Classifier rubric and calibration cases:\n/);
  assert.deepEqual(JSON.parse(evidence.split("\n").at(-1)), { objective: "Rename foo", previous_user: "x", has_visual_input: false, tool_count: 0 });
  const narrow = scorerSchema({ code_audit: {}, other_or_mixed: {} });
  assert.deepEqual(narrow.properties.work_kind.enum, ["code_audit"]);
  assert.deepEqual(narrow.properties.secondary_kind.enum, ["none", "code_audit"]);
});

test("the level scale: 1, 2 and 3 are the panel's weakest, median and best; above 3 extrapolates; the inverse is unclamped", () => {
  const [t1, t2, t3] = [-1.5, -0.4, 0.9];
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`);
  near(levelToZ(1, t1, t2, t3), t1);
  near(levelToZ(2, t1, t2, t3), t2);
  near(levelToZ(3, t1, t2, t3), t3);
  assert.ok(Math.abs(levelToZ(4, t1, t2, t3) - (t3 + (t3 - t2))) < 1e-12);
  for (const lv of [1, 1.5, 2.4, 3, 3.6, 4.2]) assert.ok(Math.abs(zToLevel(levelToZ(lv, t1, t2, t3), t1, t2, t3) - lv) < 1e-9, String(lv));
  assert.throws(() => levelToZ(2, 0, 0, 1), /t1 < t2 < t3/);
});

test("the operator's 0.2.x userScores are upgraded by the declared steps, never dropped or refused", () => {
  const conversion = LEVEL3_CONVERSIONS["2"];
  const upgraded = upgradeScores({ "m-1": { divergence: 3, coding: 2, "aesthetics.design": { level: 2.6, note: "kept" } } });
  assert.equal(upgraded.schema_version, SCHEMA_VERSION);
  const row = upgraded.scores["m-1"];
  assert.equal(Object.keys(row).some((t) => t.startsWith("divergence")), false, "divergence is renamed creativity");
  assert.equal(row.creativity.level, convertLevel(3, conversion.anchor_levels["creativity.creative_writing"], conversion.above_3_slopes["creativity.creative_writing"] ?? null));
  assert.equal(row.coding.level, 2, "at or below 2 a level stays");
  assert.equal(row["aesthetics.design"].level, convertLevel(2.6, conversion.anchor_levels["aesthetics.design"], conversion.above_3_slopes["aesthetics.design"] ?? null));
  assert.equal(row["aesthetics.design"].note, "kept");
  // The current shape is read as written.
  const current = validateScores({ schema_version: 3, scores: { "m-1": { creativity: 3.4 } } });
  assert.equal(current["m-1"].creativity.level, 3.4);
  assert.throws(() => validateScores({ schema_version: 9, scores: {} }), /schema_version/);
});

test("an aesthetics demand of level 2 or 3 also asks for image recognition, named when it is missing", () => {
  assert.deepEqual(LEVEL_FACETS.aesthetics[1], ["design"]);
  for (const level of [2, 3]) assert.ok(LEVEL_FACETS.aesthetics[level].includes("image_recognition"));
  for (const facets of Object.values(LEVEL_FACETS)) for (const list of Object.values(facets)) for (const f of list) assert.ok(f in FACET_CATEGORY, f);
  const ranked = rankCandidates(profile({ work_kind: "frontend_ui", axis_demand: { creativity: 0, coding: 0, aesthetics: 2, tool_operation: 0 } }));
  for (const c of ranked.allCandidates) {
    const named = c.excluded.find((e) => /no trusted data for the demanded category aesthetics/.test(e));
    if (named) assert.match(named, /aesthetics\.design|tool_operation\.image_recognition/);
  }
});
