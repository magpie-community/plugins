/**
 * Rules of the AgentCompass v0.7.1 engine the port carries, each tested as the rule it states (never a winner, a share or a score
 * copied from output): the effort order with `none`, `minimal` and `ultra`; an effort name off the scale read where the data
 * declares; no inversion along effort; a manual score filled to every effort the panel steps to; the operating-point floor under a
 * maintainer score; a derived facet following a score on its larger row; the operator's schema-3 `userScores` carried to the rows
 * v0.7.0 meant; a family name with no scores of its own; and the `/v1/models` converter.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { rankCandidates } from "../src/allocator.js";
import { readingEffort, scoredModels } from "../src/axis-scores.js";
import { catalogNameWarning, resolveModel } from "../src/catalog.js";
import { durationAt } from "../src/quota-economy.js";
import { FIVE_AXIS_EFFORT_READINGS, FIVE_AXIS_EFFORT_STEPS, FIVE_AXIS_MODELS } from "../src/reference-data.js";
import { V0_7_0, v070Row } from "../src/released-names.js";
import { EFFORTS, SCHEMA_VERSION, anchorEffort, boundAlongEffort, risesWithEffort, upgradeScores } from "../src/user-scores.js";
import { candidatesFromModels } from "../scripts/candidates-from-models.mjs";
import { profile } from "./profile.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = profile();
const facetsOf = (info) => Object.entries(info.five_axis.categories).flatMap(([c, cell]) => Object.entries(cell.facets || {}).map(([f, fc]) => [c, f, fc]));
const ordered = (by, rises) => {
  const values = EFFORTS.filter((e) => e in by).map((e) => (rises ? 1 : -1) * by[e]);
  return values.every((v, i) => i === 0 || v >= values[i - 1] - 1e-12);
};

test("the effort order is user_scores.EFFORTS: none and minimal below low, ultra above max", () => {
  assert.deepEqual(EFFORTS, ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(SCHEMA_VERSION, 4);
});

test("an effort off the scale reads the effort the data declares; one on the scale reads itself; no effort reads the default", () => {
  const state = { effort_readings: FIVE_AXIS_EFFORT_READINGS };
  for (const [name, reads] of Object.entries(FIVE_AXIS_EFFORT_READINGS)) assert.equal(readingEffort(state, name), reads);
  for (const e of EFFORTS) assert.equal(readingEffort(state, e), e);
  assert.equal(readingEffort(state, null), FIVE_AXIS_EFFORT_READINGS.default);
  // The time a task takes follows the same reading
  const [model, info] = Object.entries(scoredModels()).find(([, i]) => Object.keys(i.five_axis.duration.by_effort || {}).length > 0);
  assert.deepEqual(durationAt(info, null), durationAt(info, FIVE_AXIS_EFFORT_READINGS.default), model);
});

test("no curve inverts along effort: bounding keeps the pinned values and leaves an ordered curve as it is", () => {
  let seed = 7;
  const next = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 4 - 2;
  for (let n = 0; n < 200; n++) {
    const by = Object.fromEntries(EFFORTS.filter(() => next() > -1.2).map((e) => [e, Math.round(next() * 1e4) / 1e4]));
    if (Object.keys(by).length === 0) continue;
    for (const rises of [true, false]) {
      const out = boundAlongEffort(by, rises);
      assert.ok(ordered(out, rises), JSON.stringify({ by, rises, out }));
      const anchor = anchorEffort(Object.keys(by));
      assert.equal(out[anchor], by[anchor], "the anchor is pinned");
      assert.deepEqual(boundAlongEffort(out, rises), out, "an ordered curve is unchanged");
    }
  }
  assert.throws(() => boundAlongEffort({ low: 1, high: 0 }, true, ["low", "high"]), /themselves inverted/);
});

test("every shipped facet, after the maintainer scores, is ordered along effort in its direction", () => {
  for (const [model, info] of Object.entries(scoredModels())) {
    for (const [c, f, cell] of facetsOf(info)) assert.ok(ordered(cell.by_effort || {}, risesWithEffort(c, f)), `${model} ${c}.${f}`);
  }
});

test("a manual score fills every effort the panel steps to from High, and the edges from their anchors", () => {
  const [model] = Object.entries(FIVE_AXIS_MODELS).find(([, r]) => r.categories.coding && r.categories.coding.facets);
  const scored = scoredModels({ userScores: { schema_version: 4, scores: { [model]: { "coding.execution": { level: 2.4, as_of: "2026-11-19" } } } } })[model];
  const cell = scored.five_axis.categories.coding.facets.execution;
  const steps = FIVE_AXIS_EFFORT_STEPS["coding.execution"];
  const reachable = new Set(["high", ...Object.keys(steps.high), ...Object.keys(FIVE_AXIS_MODELS[model].categories.coding.facets.execution.by_effort)]);
  if (reachable.has("low") && steps.low && steps.low.minimal) reachable.add("minimal");
  if (reachable.has("max") && steps.max && steps.max.ultra) reachable.add("ultra");
  if (steps.lowest_reasoning && steps.lowest_reasoning.none) reachable.add("none");
  for (const e of reachable) assert.ok(typeof cell.by_effort[e] === "number", `${model} coding.execution at ${e}`);
  assert.ok(ordered(cell.by_effort, true));
  assert.equal(cell.status, "user");
});

test("a maintainer score on a row declared as another row at an operating point never reads below that point", () => {
  const shipped = scoredModels();
  let checked = 0;
  for (const [model, row] of Object.entries(FIVE_AXIS_MODELS)) {
    for (const [c, cell] of Object.entries(row.categories)) {
      for (const [f, own] of Object.entries(cell.facets || {})) {
        const est = own.estimate || {};
        if (est.method !== "same_model" || !est.at_effort || (c === "tool_operation" && f === "responsiveness")) continue;
        const after = shipped[model].five_axis.categories[c].facets[f];
        if (after.status !== "maintainer") continue;
        checked += 1;
        for (const [e, v] of Object.entries(after.by_effort)) {
          if (e in own.by_effort) assert.ok(v >= own.by_effort[e] - 1e-12, `${model} ${c}.${f} at ${e}`);
          assert.equal(v, Math.max(after.operating_point_floor.score_by_effort[e], own.by_effort[e] ?? -Infinity), `${model} ${c}.${f} at ${e}: max(score, point)`);
        }
        // A local user's score on the same facet is the user's: not floored
        const low = scoredModels({ userScores: { schema_version: 4, scores: { [model]: { [`${c}.${f}`]: { level: 0.5, as_of: "2026-11-19" } } } } });
        const mine = low[model].five_axis.categories[c].facets[f];
        assert.equal(mine.operating_point_floor, undefined);
        assert.ok(Object.entries(mine.by_effort).some(([e, v]) => e in own.by_effort && v < own.by_effort[e]), `${model} ${c}.${f}: a low user score reads low`);
      }
    }
  }
  assert.ok(checked > 0, "the shipped data has a row at a declared operating point under a maintainer score");
});

test("a facet derived from a larger row moves by the change a score makes on that row, bounded along effort", () => {
  const derived = [];
  for (const [model, row] of Object.entries(FIVE_AXIS_MODELS)) {
    for (const [c, cell] of Object.entries(row.categories)) {
      for (const [f, own] of Object.entries(cell.facets || {})) {
        const est = own.estimate || {};
        if (["tier_down", "size_step"].includes(est.method) && est.base_model in FIVE_AXIS_MODELS) derived.push([model, c, f, est.base_model]);
      }
    }
  }
  assert.ok(derived.length > 0, "the shipped data has a facet derived from a larger row");
  const [model, c, f, base] = derived[0];
  const before = scoredModels();
  const after = scoredModels({ userScores: { schema_version: 4, scores: { [base]: { [`${c}.${f}`]: { level: 2.7, as_of: "2026-11-19" } } } } });
  const was = before[base].five_axis.categories[c].facets[f].by_effort;
  const now = after[base].five_axis.categories[c].facets[f].by_effort;
  const cell = after[model].five_axis.categories[c].facets[f];
  const moved = {};
  for (const [e, v] of Object.entries(before[model].five_axis.categories[c].facets[f].by_effort)) if (e in now && e in was) moved[e] = v + now[e] - was[e];
  const expected = Object.fromEntries(Object.entries(boundAlongEffort(moved, risesWithEffort(c, f))).map(([e, v]) => [e, Math.round(v * 1e4) / 1e4]));
  for (const e of Object.keys(expected)) assert.ok(Math.abs(cell.by_effort[e] - expected[e]) < 1e-9, `${model} ${c}.${f} at ${e}`);
  assert.equal(cell.follows.base_model, base);
});

test("the operator's schema-3 userScores move to the rows v0.7.0 meant; a name with no row stays in the table and makes no row", () => {
  const upgraded = upgradeScores({
    schema_version: 3,
    scores: {
      "gemini-4-pro": { creativity: { level: 2.5, as_of: "2026-11-04" } },
      "anthropic/claude-opus-5": { "coding.execution": { level: 3.1, as_of: "2026-11-05" } },
      "no-such-model-xyz": { coding: { level: 3, as_of: "2026-11-05" } },
    },
  });
  assert.equal(upgraded.schema_version, 4);
  assert.deepEqual(Object.keys(upgraded.scores).sort(), [v070Row("anthropic/claude-opus-5"), v070Row("gemini-4-pro"), "no-such-model-xyz"].sort());
  const scored = scoredModels({ userScores: upgraded });
  assert.equal(scored["no-such-model-xyz"], undefined, "an unresolved name is never made a row");
  assert.equal(scored[v070Row("gemini-4-pro")].five_axis.manual_scores.creativity.kind, "user");
  // Every name of the table resolved through an alias at v0.7.0 and resolves otherwise now
  for (const [name, row] of Object.entries(V0_7_0)) {
    assert.ok(row in FIVE_AXIS_MODELS, `${name} -> ${row} is a row`);
    assert.notDeepEqual([resolveModel(name).source, resolveModel(name).key], ["alias", row], `${name} resolves otherwise now`);
  }
});

test("a family name has no scores of its own: it is out of automatic routing with a data error, and its warning says so", () => {
  const name = "claude-opus-9";
  assert.equal(resolveModel(name).source, "family");
  assert.match(catalogNameWarning(name), /has no row of its own, so it has no scores/);
  assert.doesNotMatch(catalogNameWarning(name), /estimate/);
  const ranked = rankCandidates(PROFILE, { candidateModels: [`${name}:high`] });
  assert.equal(ranked.allCandidates[0].eligible, false);
  assert.match(ranked.allCandidates[0].excluded.join("; "), /data error/);
});

test("the /v1/models converter gives each listed model Magpie's own efforts, and the plugin routes at exactly those", () => {
  // test/fixtures/magpie-v1-models.json: a /v1/models response in the shape Magpie v0.1.4470 writes it (gateway.go modelObject:
  // reasoning_levels and supported_reasoning_levels), for the openai and account:antigravity rows of the saved Magpie 0.1.4470
  // catalog (AgentCompass audit/gateway-catalogs). No gateway is asked.
  const listing = JSON.parse(fs.readFileSync(path.join(REPO, "test", "fixtures", "magpie-v1-models.json"), "utf8"));
  const rows = candidatesFromModels(listing);
  assert.equal(rows.length, new Set(listing.data.map((m) => m.id)).size);
  listing.data.forEach((m, i) => {
    if (m.reasoning_levels.length > 0) assert.deepEqual(rows[i], { model: m.id, efforts: m.reasoning_levels });
    else assert.equal(rows[i], m.id, "a model with no levels is its bare id");
  });
  // supported_reasoning_levels alone is read the same way; an id listed twice keeps its first row
  const objectsOnly = { data: [{ id: "m-1", supported_reasoning_levels: [{ effort: "Low" }, { effort: "high" }] }, { id: "m-1", reasoning_levels: ["max"] }] };
  assert.deepEqual(candidatesFromModels(objectsOnly), [{ model: "m-1", efforts: ["low", "high"] }]);
  assert.throws(() => candidatesFromModels({ models: [] }), /data array/);
  const listed = rows.filter((r) => typeof r === "object");
  const ranked = rankCandidates(PROFILE, { candidateModels: listed });
  for (const c of ranked.allCandidates) {
    const row = listed.find((r) => r.model === c.model);
    assert.ok(row.efforts.includes(c.effort), `${c.model} at ${c.effort}`);
  }
  assert.equal(ranked.allCandidates.length, listed.reduce((n, r) => n + r.efforts.length, 0));
});
