/**
 * Rules of the AgentCompass v0.7.1 engine the port carries, each tested as the rule it states (never a winner, a share or a score
 * copied from output): the effort order with `none`, `minimal` and `ultra`; an effort name off the scale read where the data
 * declares; no inversion along effort; a manual score filled to every effort the panel steps to; the operating-point floor under a
 * maintainer score; a derived facet following a score on its larger row; the operator's schema-3 `userScores` carried to the rows
 * v0.7.0 meant; a family name with no scores of its own; the `/v1/models` converter; and a `default` row, the one configuration
 * of a model listed with no levels.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { ONE_CONFIGURATION, candidatesFromModels, levelsOf } from "../scripts/candidates-from-models.mjs";
import { onRequest as middlewareOnRequest } from "../src/middleware.js";
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

test("the /v1/models converter gives every listed model its own efforts: its levels, or the one configuration `default`", () => {
  // test/fixtures/magpie-v1-models.json: a /v1/models response in the shape Magpie v0.1.4470 writes it (gateway.go modelObject:
  // reasoning_levels and supported_reasoning_levels), for the openai and account:antigravity rows of the saved Magpie 0.1.4470
  // catalog (AgentCompass audit/gateway-catalogs). No gateway is asked.
  const listing = JSON.parse(fs.readFileSync(path.join(REPO, "test", "fixtures", "magpie-v1-models.json"), "utf8"));
  const warnings = [];
  const rows = candidatesFromModels(listing, (message) => warnings.push(message));
  assert.deepEqual(warnings, [], "every fixture row is read");
  assert.equal(rows.length, listing.data.length);
  assert.ok(listing.data.some((m) => levelsOf(m).length === 0), "the fixture has rows with no levels");
  listing.data.forEach((m, i) => {
    // audit/gateway_coverage.py: a row that lists no efforts is the model's one configuration, offered at `default`
    const efforts = m.reasoning_levels.length > 0 ? m.reasoning_levels : [ONE_CONFIGURATION];
    assert.deepEqual(rows[i], { model: m.id, efforts }, m.id);
  });
  assert.throws(() => candidatesFromModels({ models: [] }), /data array/);

  // A row's own efforts are what it runs at: each row is offered at exactly its efforts, a no-level row once, at `default`.
  const ranked = rankCandidates(PROFILE, { candidateModels: rows });
  for (const c of ranked.allCandidates) {
    const row = rows.find((r) => r.model === c.model);
    assert.ok(row.efforts.includes(c.effort), `${c.model} at ${c.effort}`);
  }
  assert.equal(ranked.allCandidates.length, rows.reduce((n, r) => n + r.efforts.length, 0));
});

test("a `default` row is one candidate read where the data reads `default`, and goes to Magpie as the bare model with no effort", () => {
  const reads = readingEffort({ effort_readings: FIVE_AXIS_EFFORT_READINGS }, ONE_CONFIGURATION);
  assert.ok(EFFORTS.includes(reads), `default reads an effort on the scale (${reads})`);
  for (const model of ["gemini-pro-agent", "gpt-6.1-sol"]) {
    const atDefault = rankCandidates(PROFILE, { candidateModels: [{ model, efforts: [ONE_CONFIGURATION] }] }).allCandidates;
    const atReading = rankCandidates(PROFILE, { candidateModels: [{ model, efforts: [reads] }] }).allCandidates;
    assert.equal(atDefault.length, 1);
    assert.equal(atDefault[0].effort, ONE_CONFIGURATION);
    assert.equal(atDefault[0].score, atReading[0].score, `${model}: scored as its ${reads} reading`);
    assert.equal(atDefault[0].duration_hours, atReading[0].duration_hours, `${model}: timed as its ${reads} reading`);
  }
  // Magpie's askedAt reads only none..max after a colon (provider.MemberEfforts); `m:default` would name another model.
  for (const protocol of ["chat", "responses", "anthropic"]) {
    const body = { model: "agentcompass/auto", profile: PROFILE, messages: [{ role: "user", content: "edit one function" }] };
    const ctx = { protocol, state: {}, reject: (status, message) => ({ rejected: status, message }), options: { injectProtocolEffort: true, candidateModels: [{ model: "gpt-6.1-sol", efforts: [ONE_CONFIGURATION] }] } };
    middlewareOnRequest(body, ctx);
    assert.equal(ctx.state.route.targetEffort, ONE_CONFIGURATION, protocol);
    assert.equal(body.model, "gpt-6.1-sol", protocol);
    assert.equal(body.reasoning_effort, undefined, protocol);
    assert.equal(body.reasoning?.effort, undefined, protocol);
    assert.equal(body.output_config?.effort, undefined, protocol);
  }
  // any other effort still goes as <model>:<effort> with the protocol's field
  const body = { model: "agentcompass/auto", profile: PROFILE, messages: [{ role: "user", content: "edit one function" }] };
  middlewareOnRequest(body, { protocol: "chat", state: {}, options: { injectProtocolEffort: true, candidateModels: [{ model: "gpt-6.1-sol", efforts: ["high"] }] } });
  assert.equal(body.model, "gpt-6.1-sol:high");
  assert.equal(body.reasoning_effort, "high");
});

test("the converter reads reasoning_levels first, else supported_reasoning_levels, and names what it skips on stderr", () => {
  // the documented order: reasoning_levels when it lists any, supported_reasoning_levels otherwise
  const differing = { id: "m-order", reasoning_levels: ["low", "High"], supported_reasoning_levels: [{ effort: "medium" }, { effort: "xhigh" }] };
  const objectsOnly = { id: "m-objects", reasoning_levels: [], supported_reasoning_levels: [{ effort: "Low" }, { effort: "high" }] };
  assert.deepEqual(candidatesFromModels({ data: [differing, objectsOnly] }), [
    { model: "m-order", efforts: ["low", "high"] },
    { model: "m-objects", efforts: ["low", "high"] },
  ]);

  const warnings = [];
  const listing = { data: [{ id: "m-1", reasoning_levels: ["low"] }, null, { name: "no id" }, { id: "m-1", reasoning_levels: ["low"] }, { id: "m-1", reasoning_levels: ["max"] }, ["m-2"]] };
  assert.deepEqual(candidatesFromModels(listing, (message) => warnings.push(message)), [{ model: "m-1", efforts: ["low"] }]);
  assert.equal(warnings.length, 5);
  assert.match(warnings[0], /^row 1: skipped, not an object/);
  assert.match(warnings[1], /^row 2: skipped, no model id/);
  assert.match(warnings[2], /^row 3: m-1 skipped, listed again \(row 0 kept\)$/);
  assert.match(warnings[3], /^row 4: m-1 skipped, listed again \(row 0 kept\); its efforts \[max\] differ from the kept row's \[low\]/);
  assert.match(warnings[4], /^row 5: skipped, not an object/);

  // the command line: warnings on stderr, stdout only the JSON
  const run = spawnSync(process.execPath, [path.join(REPO, "scripts", "candidates-from-models.mjs")], { input: JSON.stringify(listing), encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.deepEqual(JSON.parse(run.stdout), { candidateModels: [{ model: "m-1", efforts: ["low"] }] });
  assert.equal(run.stderr.trim().split(/\r?\n/).length, 5);
  assert.match(run.stderr, /candidates-from-models: row 4: m-1 skipped/);
});
