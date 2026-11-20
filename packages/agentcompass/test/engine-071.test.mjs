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

import { candidateOffers, mergePinOptions, pinsFixEffort, rankCandidates, selectBestRoute } from "../src/allocator.js";
import { readingEffort, scoredModels } from "../src/axis-scores.js";
import { FAMILIES, MODELS, MODEL_ALIASES, NO_PROVIDER_NAMES, PROVIDER_NAMES, canonicalModel, catalogNameWarning, checkModelPin, expandHostProviders, healthKey, magpieOptions, modelLeaf, modelPinProblem, pinGiven, providerNamesOf, pyStrip, resolveListed, resolveModel, rowKey, servedModel, slashSuffixes } from "../src/catalog.js";
import { effectivePin, lookupNames, pinMatchesIdentity, pinMatchingBundles, pinNamesBundle } from "../src/candidate-eval.js";
import { applicableWindows } from "../src/quota-pools.js";
import { normalizeTask } from "../src/task-intake.js";
import { durationAt } from "../src/quota-economy.js";
import { FIVE_AXIS_EFFORT_READINGS, FIVE_AXIS_EFFORT_STEPS, FIVE_AXIS_MODELS } from "../src/reference-data.js";
import { V0_7_0, v070Row } from "../src/released-names.js";
import { EDGES, EFFORTS, SCHEMA_VERSION, anchorEffort, boundAlongEffort, resolveModelKey, risesWithEffort, scoreLayer, upgradeScores } from "../src/user-scores.js";
import { ONE_CONFIGURATION, candidatesFromModels, levelsOf } from "../scripts/candidates-from-models.mjs";
import { onAccount as middlewareOnAccount, onProvider as middlewareOnProvider, onRequest as middlewareOnRequest } from "../src/middleware.js";
import { onRequest as hooksOnRequest } from "../src/hooks.js";
import { SessionContinuityStore } from "../src/continuity.js";
import { EFFORT_TO_JEV_SCORE, JEV_EFFORT_LEVELS, buildEffortAnswer, handleSystemOneRequest } from "../src/index.js";
import { profile } from "./profile.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = profile();
const T0_071 = 1_790_000_000_000;
const FIVE_AXIS_MODELS_TABLE = scoredModels();
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
  // A facet with no curve of its own (no measured or estimated effort), so every effort but High comes from the panel's steps
  // (`effort_steps`: High to each effort, then each edge from its anchor), which a row that already holds all eight would hide.
  const [model] = Object.entries(FIVE_AXIS_MODELS).find(([, r]) => r.categories.coding && !(r.categories.coding.facets || {}).execution);
  assert.ok(model, "the shipped data has a coding row with no execution facet");
  const scored = scoredModels({ userScores: { schema_version: 4, scores: { [model]: { "coding.execution": { level: 2.4, as_of: "2026-11-19" } } } } })[model];
  const cell = scored.five_axis.categories.coding.facets.execution;
  const by = cell.by_effort;
  const steps = FIVE_AXIS_EFFORT_STEPS["coding.execution"];
  const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 1e-4, `${model} coding.execution ${what}: ${a} vs ${b}`);
  assert.equal(cell.status, "user");
  assert.deepEqual(cell.measured_efforts, []);
  near(by.high, cell.manual.z, "high is the score");
  const fromHigh = Object.entries(steps.high).filter(([, st]) => st && st.step !== null && st.step !== undefined);
  assert.ok(fromHigh.length > 0);
  for (const [e, st] of fromHigh) near(by[e], by.high + st.step, `${e} from high`);
  // each edge: its anchor (the effort its `EDGES` entry steps from; `lowest_reasoning`, the lowest other effort) plus that step
  for (const [edge, [key]] of Object.entries(EDGES)) {
    const anchor = key === "lowest_reasoning" ? EFFORTS.find((e) => e !== edge && e in by) : key;
    const st = (steps[key] || {})[edge];
    assert.ok(st && anchor, `${edge}: a step and an anchor`);
    near(by[edge], by[anchor] + st.step, `${edge} from ${anchor}`);
  }
  assert.ok(ordered(by, true));
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

test("Mode B answers every effort on Magpie's effort scale: outside it the nearest end, `default` as it reads, an unknown name not at all", () => {
  // Magpie decide.go: the effort answer is jevLevels[clamp(round(score), 0, 3)], jevLevels = low, medium, high, xhigh
  JEV_EFFORT_LEVELS.forEach((level, point) => assert.equal(buildEffortAnswer(level).score, point, level));
  const scores = EFFORTS.map((effort) => buildEffortAnswer(effort)?.score);
  for (const [i, score] of scores.entries()) {
    assert.ok(Number.isInteger(score) && score >= 0 && score < JEV_EFFORT_LEVELS.length, `${EFFORTS[i]} has an answer on the scale`);
    if (i > 0) assert.ok(score >= scores[i - 1], `non-decreasing at ${EFFORTS[i]}`);
  }
  const below = EFFORTS.slice(0, EFFORTS.indexOf(JEV_EFFORT_LEVELS[0]));
  const above = EFFORTS.slice(EFFORTS.indexOf(JEV_EFFORT_LEVELS.at(-1)) + 1);
  for (const effort of below) assert.equal(buildEffortAnswer(effort).score, 0, `${effort}: the bottom of the scale`);
  for (const effort of above) assert.equal(buildEffortAnswer(effort).score, JEV_EFFORT_LEVELS.length - 1, `${effort}: the top of the scale`);
  const reads = readingEffort({ effort_readings: FIVE_AXIS_EFFORT_READINGS }, "default");
  assert.equal(buildEffortAnswer("default").score, buildEffortAnswer(reads).score, `default answers as ${reads}`);
  assert.deepEqual(Object.keys(EFFORT_TO_JEV_SCORE).sort(), [...EFFORTS, "default"].sort());
  for (const unknown of ["turbo", "auto", "", null, undefined]) assert.equal(buildEffortAnswer(unknown), null, `${unknown}: no answer`);
});

// ---------------------------------------------------------------------------- provider_names (AgentCompass v0.7.2)

const DECLARED = [
  ...Object.keys(PROVIDER_NAMES.defaults).map((name) => [null, name]),
  ...Object.entries(PROVIDER_NAMES.rows).flatMap(([provider, names]) => Object.keys(names).map((name) => [provider, name])),
];

test("a served name reads its provider's declaration, then its maker's default, for every spelling, whatever order the providers come in", () => {
  for (const [provider, name] of DECLARED) {
    const declared = provider ? PROVIDER_NAMES.rows[provider][name] : PROVIDER_NAMES.defaults[name];
    const spellings = provider
      ? [`${provider}/${name}`, `${provider.toUpperCase()}/${name.toUpperCase()}`, `${provider}/${name}:high`]
      : [name, name.toUpperCase(), `${name}:high`, `${name}-high`];
    for (const spelling of spellings) {
      const r = resolveModel(spelling);
      if (declared.model == null) {
        assert.equal(r.key, null, spelling);
        assert.equal(r.source, declared.status, spelling);
        assert.equal(r.provider, provider, spelling);
      } else {
        assert.equal(r.key, declared.model, spelling);
        assert.equal(r.source, provider ? "provider" : "default", spelling);
      }
    }
    // the same declaration on the endpoint that lists the name bare (a Magpie preset's own namespace)
    if (provider) assert.equal(resolveModel(name, MODELS, MODEL_ALIASES, FAMILIES, PROVIDER_NAMES, [provider]).key, declared.model ?? null, `${name} on ${provider}`);
  }
  // providers that declare different rows: no row, in either order
  const table = { defaults: {}, rows: { a: { m: { model: "claude-opus-5-5" } }, b: { m: { model: "claude-sonnet-5-5" } } } };
  for (const order of [["a", "b"], ["b", "a"]]) {
    const r = resolveModel("m", MODELS, MODEL_ALIASES, FAMILIES, table, order);
    assert.deepEqual([r.source, r.key], ["conflict", null], order.join(","));
  }
  // a table without its parts is refused, never read as declaring none
  assert.throws(() => resolveModel("claude-opus-5-5", MODELS, MODEL_ALIASES, FAMILIES, { defaults: {} }), /provider_names/);
});

test("a pair with no row on its provider is its own model: out of automatic routing with the reason, and launched when named", () => {
  const noRow = DECLARED.filter(([provider, name]) => provider && PROVIDER_NAMES.rows[provider][name].model == null).map(([provider, name]) => `${provider}/${name}`);
  assert.ok(noRow.length > 0);
  for (const pair of noRow) {
    const r = resolveModel(pair);
    // never the same model as the same name elsewhere, and a stored value reads the same declaration again
    assert.notEqual(rowKey(pair), rowKey(modelLeaf(pair)), pair);
    assert.equal(rowKey(pair), `${r.provider}/${modelLeaf(pair)}`.toLowerCase());
    assert.equal(healthKey(pair), rowKey(pair));
    assert.equal(canonicalModel(canonicalModel(pair)), canonicalModel(pair));
    assert.equal(resolveModel(canonicalModel(pair)).source, r.source);
    const free = rankCandidates(PROFILE, { candidateModels: [{ model: pair, efforts: ["high"] }, { model: "gpt-6.1-sol", efforts: ["high"] }] });
    const mine = free.allCandidates.filter((c) => c.model === pair);
    assert.ok(mine.length > 0 && mine.every((c) => !c.eligible), `${pair}: out of automatic routing`);
    assert.match(catalogNameWarning(pair), new RegExp(`${r.provider}.*\\(${r.source}\\)`), `${pair}: the reason`);
    const named = rankCandidates(PROFILE, { candidateModels: [{ model: pair, efforts: ["high"] }], constraintModel: pair });
    assert.equal(named.selected?.model, pair, `${pair}: launched when named`);
  }
});

test("a modelsByProvider name is read on its preset: a name the preset declares with no row is routed as that pair and sent as listed", () => {
  const [provider, name] = DECLARED.find(([p, n]) => p && PROVIDER_NAMES.rows[p][n].model == null);
  const pair = `${provider}/${name}`;
  assert.equal(servedModel(name, [provider]), pair);
  assert.equal(servedModel(`${name}:low`, [provider]), `${pair}:low`);
  // a name the preset does not declare, or declares as the row the name is anyway, stays as listed
  for (const [p, n] of DECLARED.filter(([p]) => p)) {
    if (PROVIDER_NAMES.rows[p][n].model === resolveModel(n).key) assert.equal(servedModel(n, [p]), n, `${n} on ${p}`);
  }
  assert.equal(servedModel("gpt-6.1-sol", [provider]), "gpt-6.1-sol");
  const options = {
    candidateModels: [{ model: pair, efforts: ["high"] }],
    modelsByProvider: { [provider]: [{ model: name, efforts: ["high"] }] },
    constraintModel: pair,
  };
  const body = { model: "agentcompass/auto", profile: PROFILE, messages: [{ role: "user", content: "edit one function" }] };
  const ctx = { protocol: "chat", state: {}, options };
  middlewareOnRequest(body, ctx);
  middlewareOnProvider(body, { ...ctx, provider: { id: provider, model: name } });
  assert.equal(ctx.state.route.targetModel, pair, "routed as the pair");
  assert.equal(body.model, `${name}:high`, "sent to the preset as listed");
});

test("onProvider sends the listed name whenever the route has one: a declaration onto another scored row, a tagged entry, no per-provider route", () => {
  // A preset that lists a name its own declaration makes a scored row (constructed: no shipped declaration does this), under
  // the host catalogue's own provider_names table. The route onRequest chose stands on the preset, so onProvider routes nothing
  // again, and the body still goes as the preset lists the model; the entry's `:auto` tag is left out of the match on both sides.
  const row = "gpt-6.1-sol";
  assert.equal(resolveModel(row).key, row);
  const listed = "acme-house-model";
  assert.equal(resolveModel(listed).source, "unknown");
  const providerNames = { defaults: PROVIDER_NAMES.defaults, rows: { ...PROVIDER_NAMES.rows, acme: { [listed]: { model: row } } } };
  assert.equal(servedModel(listed, ["acme"], MODELS, MODEL_ALIASES, FAMILIES, providerNames), row);
  for (const entry of [listed, `${listed}:auto`, `${listed}:default`, { model: listed, efforts: ["high"] }]) {
    const options = { candidateModels: [{ model: row, efforts: ["high"] }], modelsByProvider: { acme: [entry] }, constraintModel: row, catalog: { providerNames } };
    const body = { model: "agentcompass/auto", profile: PROFILE, messages: [{ role: "user", content: "edit one function" }] };
    const ctx = { protocol: "chat", state: {}, options };
    middlewareOnRequest(body, ctx);
    assert.equal(body.model, `${row}:high`, "onRequest routes the row");
    const before = ctx.state.route;
    const returned = middlewareOnProvider(body, { ...ctx, provider: { id: "acme" } });
    assert.equal(ctx.state.route, before, "no per-provider route");
    assert.equal(body.model, `${listed}:high`, JSON.stringify(entry));
    assert.equal(returned, body);
  }
  // on a preset that does not list a name for the row, the body is left as routed
  const options = { candidateModels: [{ model: row, efforts: ["high"] }], modelsByProvider: { other: [row] }, constraintModel: row, catalog: { providerNames } };
  const body = { model: "agentcompass/auto", profile: PROFILE, messages: [{ role: "user", content: "edit one function" }] };
  const ctx = { protocol: "chat", state: {}, options };
  middlewareOnRequest(body, ctx);
  middlewareOnProvider(body, { ...ctx, provider: { id: "other" } });
  assert.equal(body.model, `${row}:high`);
});

test("every table reads a spelling in one order: the full id, what follows each `/`, the last segment (model_resolution.slash_suffixes)", () => {
  assert.deepEqual(slashSuffixes("a/b/c"), ["a/b/c", "b/c", "c"]);
  // A list id whose model part holds a `/` reads its `<publisher>/<model>` alias as the name read on its preset does.
  const published = Object.keys(MODEL_ALIASES).filter((name) => name.includes("/") && !name.startsWith("/"));
  assert.ok(published.length > 0);
  for (const name of published) {
    for (const preset of ["google-vertex", "acme"]) {
      const listId = `${preset}/${name}`;
      const plain = resolveModel(listId);
      const served = resolveModel(name, MODELS, MODEL_ALIASES, FAMILIES, PROVIDER_NAMES, [preset]);
      assert.deepEqual([plain.key, plain.source], [served.key, served.source], listId);
      assert.equal(rowKey(listId), rowKey(servedModel(name, [preset])), listId);
    }
  }
  // Each table at each suffix, under a constructed table (no shipped declaration is keyed so): a provider's declaration keyed by
  // the `<publisher>/<model>` part, a default keyed by it, a row reached only through it, and an alias keyed by it.
  const models = { ...MODELS, "house-row": { ...MODELS["gpt-6.1-sol"] } };
  const aliases = { ...MODEL_ALIASES, "pub/aliased-name": "house-row" };
  const table = {
    defaults: { ...PROVIDER_NAMES.defaults, "pub/defaulted-name": { model: "house-row" } },
    rows: { ...PROVIDER_NAMES.rows, acme: { "pub/declared-name": { model: "house-row" } } },
  };
  const read = (name, providers = []) => resolveModel(name, models, aliases, FAMILIES, table, providers);
  assert.deepEqual([read("acme/pub/declared-name").key, read("acme/pub/declared-name").source], ["house-row", "provider"]);
  assert.deepEqual([read("gw/pub/defaulted-name").key, read("gw/pub/defaulted-name").source], ["house-row", "default"]);
  assert.deepEqual([read("gw/pub/aliased-name").key, read("gw/pub/aliased-name").source], ["house-row", "alias"]);
  assert.deepEqual([read("gw/sub/house-row").key, read("gw/sub/house-row").source], ["house-row", "alias"]);
  assert.equal(read("pub/declared-name", ["acme"]).key, "house-row");
  // decorated: each vendor tag and a dash effort are stripped before the suffixes are read again
  assert.equal(read("gw/pub/aliased-name-latest").key, "house-row");
  assert.equal(read("acme/pub/declared-name-high").effort, "high");
});

test("a Magpie preset reads the catalogs host_providers.magpie maps it to, only where the Magpie adapter holds a preset id", () => {
  const presets = PROVIDER_NAMES.host_providers.magpie;
  assert.ok(Object.keys(presets).length > 0);
  for (const [preset, { providers }] of Object.entries(presets)) assert.deepEqual(expandHostProviders([preset], "magpie"), providers, preset);
  assert.deepEqual(expandHostProviders(["opencode-zen", "deepseek", "opencode-zen"], "magpie"), ["opencode", "deepseek"]);
  assert.deepEqual(expandHostProviders(["opencode-zen"], "cindy"), ["opencode-zen"], "another host reads no Magpie preset");
  const magpie = providerNamesOf(magpieOptions({}).catalog);
  assert.equal(providerNamesOf({}), PROVIDER_NAMES, "a catalogue the adapter did not mark reads no preset");
  // `opencode-zen/deepseek-v4-flash`: under the adapter OpenCode's own declaration (no row there), as plain text the maker's default.
  const name = "opencode-zen/deepseek-v4-flash";
  const under = resolveListed(name, MODELS, MODEL_ALIASES, FAMILIES, magpie);
  assert.deepEqual([under.key, under.source, under.provider], [null, PROVIDER_NAMES.rows.opencode["deepseek-v4-flash"].status, "opencode"]);
  assert.equal(resolveListed(name).key, PROVIDER_NAMES.defaults["deepseek-v4-flash"].model);
  assert.equal(rowKey(name, MODELS, MODEL_ALIASES, FAMILIES, magpie), "opencode/deepseek-v4-flash");
  // a preset the table does not map is read as written, and a name with no `/` has no preset
  for (const plain of ["deepseek/deepseek-v4-pro", "deepseek-v4-pro", "google-vertex/openai/gpt-oss-120b-maas"]) {
    assert.deepEqual(resolveListed(plain, MODELS, MODEL_ALIASES, FAMILIES, magpie), resolveModel(plain), plain);
  }
  // onProvider reads `ctx.provider.id` the same way: the preset's own spelling is routed as OpenCode's pair and sent as listed
  const pair = "opencode/deepseek-v4-flash";
  const options = { candidateModels: [{ model: pair, efforts: ["high"] }], modelsByProvider: { "opencode-zen": [{ model: "deepseek-v4-flash", efforts: ["high"] }] }, constraintModel: pair };
  assert.equal(servedModel("deepseek-v4-flash-high", expandHostProviders(["opencode-zen"], "magpie")), "opencode/deepseek-v4-flash:high");
  assert.equal(servedModel("deepseek-v4-flash-high", ["opencode-zen"]), "deepseek-v4-flash-high", "outside the adapter the preset is a provider id like any other");
  const body = { model: "agentcompass/auto", profile: PROFILE, messages: [{ role: "user", content: "edit one function" }] };
  const ctx = { protocol: "chat", state: {}, options };
  middlewareOnRequest(body, ctx);
  middlewareOnProvider(body, { ...ctx, provider: { id: "opencode-zen" } });
  assert.equal(ctx.state.route.targetModel, pair, "routed as OpenCode's pair");
  assert.equal(body.model, "deepseek-v4-flash:high", "sent as the preset lists it");
});

test("a row key is never read again as a name; a pair with no row is looked up as that pair, never as the bare name's row", () => {
  // each undated row of a moved name is a row id and a declared name: its windows are its own, never the snapshot's
  const moved = Object.keys(PROVIDER_NAMES.defaults).filter((k) => MODELS[k]);
  assert.ok(moved.length > 0);
  for (const key of moved) {
    const snapshot = PROVIDER_NAMES.defaults[key].model;
    const spec = { windows: { own: { hours: 168, models: [key] }, snapshot: { hours: 168, models: [snapshot] }, any: { hours: 168 } } };
    assert.deepEqual(applicableWindows(spec, key, { windows: [] }, null, key).map(([wid]) => wid), ["own", "any"], key);
  }
  const fleet = { models: MODELS, aliases: MODEL_ALIASES, families: FAMILIES, providerNames: PROVIDER_NAMES };
  assert.deepEqual(lookupNames("opencode/deepseek-v4-flash-high", fleet), ["opencode/deepseek-v4-flash", "opencode/deepseek-v4-flash-high"]);
  assert.ok(!lookupNames("opencode/deepseek-v4-flash", fleet).includes("deepseek-v4-flash"));
  assert.equal(rowKey("OpenCode/DeepSeek-V4-Flash-high"), "opencode/deepseek-v4-flash", "the spelling its provider declares");
});

test("a bare name names the model on every account; a prefix is obeyed; a prefix that names nothing is dropped and the rest read again", () => {
  const fleet = { models: MODELS, aliases: MODEL_ALIASES, families: FAMILIES, providerNames: PROVIDER_NAMES };
  const B = (id, account, provider, model, extra = {}) => ({ id, account, provider, model, effort: "high", ...extra });
  const named = (pin, pool) => pinMatchingBundles(pin, pool, fleet).map((b) => b.id).sort();
  const both = (pool, fn) => [pool, [...pool].reverse()].forEach(fn);
  // one row on two accounts under two spellings
  const oneRow = [B("a", "acct-a", "codex", "gpt-6.1-sol"), B("b", "acct-b", "pi", "openai/gpt-6.1-sol")];
  both(oneRow, (pool) => {
    assert.deepEqual(named("gpt-6.1-sol", pool), ["a", "b"], "bare: every bundle of the row");
    assert.deepEqual(named("openai/gpt-6.1-sol", pool), ["b"], "prefixed: the typed spelling only");
    assert.deepEqual(named("codex/gpt-6.1-sol", pool), ["a"], "prefixed by a provider id: that provider's bundle of the row");
    assert.deepEqual(named("acct-b/gpt-6.1-sol", pool), ["b"], "prefixed by an account id");
    assert.deepEqual(named("vendorx/gpt-6.1-sol", pool), ["a", "b"], "a prefix that names nothing is dropped");
    assert.deepEqual(named("vendorx/codex/gpt-6.1-sol", pool), ["a"], "each level decided again: the next prefix is obeyed");
    assert.deepEqual(named("vendorx/vendory/gpt-6.1-sol", pool), ["a", "b"]);
    assert.equal(effectivePin("vendorx/codex/gpt-6.1-sol:high", pool, fleet), "codex/gpt-6.1-sol:high", "the pin as read");
    assert.equal(effectivePin("acct-b/gpt-6.1-sol", pool, fleet), "acct-b/gpt-6.1-sol");
  });
  // two unmeasured names under two vendors
  const unmeasured = [B("va", "g", "vendor-a", "vendor-a/novel-unmeasured"), B("vb", "g", "vendor-b", "vendor-b/novel-unmeasured")];
  both(unmeasured, (pool) => {
    assert.deepEqual(named("vendor-a/novel-unmeasured", pool), ["va"]);
    assert.deepEqual(named("Vendor-A/Novel-Unmeasured:high", pool), ["va"]);
    assert.deepEqual(named("novel-unmeasured", pool), ["va", "vb"]);
  });
  // a prefix that names a bundle keeps the crossings of rounds 1 to 3 closed: a no-row pair and the scored name, a repository id
  // and the moved bare name
  const pairs = [B("oc", "g", "opencode", "opencode/deepseek-v4-flash"), B("ds", "g", "deepseek", "deepseek/deepseek-v4-flash"),
    B("repo", "g", "codex", "deepseek-ai/DeepSeek-V4-Pro"), B("bare", "g", "claude", "deepseek-v4-pro")];
  both(pairs, (pool) => {
    assert.deepEqual(named("opencode/deepseek-v4-flash", pool), ["oc"]);
    assert.deepEqual(named("deepseek-v4-flash", pool), ["ds"]);
    assert.deepEqual(named("deepseek-ai/DeepSeek-V4-Pro", pool), ["repo"]);
    assert.deepEqual(named("deepseek-v4-pro", pool), ["bare"]);
  });
  // with nothing named `opencode` (or `deepseek-ai`) in the pool the prefix is dropped: the bare name's own bundles
  assert.deepEqual(named("opencode/deepseek-v4-flash", [pairs[1]]), ["ds"], "nothing is `opencode`: bare deepseek-v4-flash");
  assert.deepEqual(named("deepseek-ai/DeepSeek-V4-Pro", [pairs[3]]), ["bare"], "nothing is `deepseek-ai`: bare DeepSeek-V4-Pro");
  // a prefix that names a bundle of another row is obeyed: nothing of the row is named, nothing substituted
  assert.deepEqual(named("claude/deepseek-v4-flash", pairs), [], "`claude` names a bundle: obeyed, and none of its bundles is the row");
  // Antigravity's two launch providers are one prefix (`account_fleet._same_provider`)
  const agy = [B("ag", "acct-g", "antigravity-resilient", "gpt-6.1-sol"), B("cx", "acct-c", "codex", "gpt-6.1-sol")];
  assert.deepEqual(named("antigravity/gpt-6.1-sol", agy), ["ag"]);
  // an auto-bundle id names that id only
  const auto = [B("auto:acct-a:codex:gpt-6.1-sol", "acct-a", "codex", "gpt-6.1-sol"), B("x", "acct-b", "pi", "gpt-6.1-sol")];
  assert.deepEqual(named("auto:acct-a:codex:gpt-6.1-sol", auto), ["auto:acct-a:codex:gpt-6.1-sol"]);
  assert.deepEqual(named("auto:acct-a:codex:gpt-6.1-sol:high", auto), []);
  assert.equal(pinNamesBundle("auto:acct-a:codex:gpt-6.1-sol:high", auto[0], fleet), false, "an auto id is never read as a spelling");
  // a Magpie preset id typed as a prefix names the rows listed on that preset, kept beside the catalogs it serves
  const presets = [B("oz", "gateway", "gateway", "opencode/deepseek-v4-flash", { launch_model: "deepseek-v4-flash", presets: ["opencode-zen"], served: ["opencode"] }),
    B("ds2", "gateway", "gateway", "deepseek/deepseek-v4-flash")];
  both(presets, (pool) => {
    assert.deepEqual(named("opencode-zen/deepseek-v4-flash", pool), ["oz"]);
    assert.deepEqual(named("opencode/deepseek-v4-flash", pool), ["oz"], "the catalog the preset serves");
    assert.deepEqual(named("deepseek-v4-flash", pool), ["ds2", "oz"], "bare: each as it reads the name");
  });
  // a malformed name matches nothing here and is refused where the caller hands it over
  for (const bad of ["/gpt-6.1-sol", "openai/", "a//b", ":high", "  ", "auto:acct-a", "auto::codex:x", "openai/:high", 5]) {
    assert.ok(modelPinProblem(bad), JSON.stringify(bad));
    assert.throws(() => checkModelPin(bad), { code: "invalid_model_pin" });
    assert.deepEqual(named(bad, oneRow), []);
    const refused = selectBestRoute(PROFILE, { candidateModels: oneRow, constraintModel: bad });
    assert.deepEqual([refused.ok, refused.error], [false, "invalid_model_pin"], JSON.stringify(bad));
  }
  for (const good of ["gpt-6.1-sol", "openai/gpt-6.1-sol:high", "google-vertex/openai/gpt-oss-120b-maas", "auto:a:codex:gpt-6.1-sol@high#2"]) {
    assert.equal(modelPinProblem(good), null, good);
  }
  // the filters apply to the named bundles only: an unchecked or unavailable bundle a prefix names is refused, never replaced;
  // a bare name launches the best of the rest
  for (const flag of [{ disabled: true }, "unavailable"]) {
    const pool = [B("a", "acct-a", "codex", "gpt-6.1-sol"), B("b", "acct-b", "pi", "openai/gpt-6.1-sol", flag === "unavailable" ? {} : flag)];
    both(pool, (ordered) => {
      const run = (pin) => rankCandidates(PROFILE, { candidateModels: ordered, constraintModel: pin, ...(flag === "unavailable" ? { unavailable: ["b"] } : {}) });
      assert.equal(run("openai/gpt-6.1-sol").selected, null, `prefixed, ${JSON.stringify(flag)}`);
      assert.equal(run("gpt-6.1-sol").selected?.id, "a", `bare, ${JSON.stringify(flag)}`);
    });
  }
});

test("onProvider matches a named model over the whole pool: another preset's prefix is not rewritten on this preset (Magpie sends the body as onRequest left it), a bare name routes here", () => {
  const options = {
    catalog: {},
    candidateModels: [{ model: "acme-a/gpt-6.1-sol", efforts: ["high"] }, { model: "acme-b/gpt-6.1-sol", efforts: ["high"] }],
    modelsByProvider: { "acme-b": [{ model: "gpt-6.1-sol", efforts: ["high"] }] },
  };
  const tryOn = (pin) => {
    const body = { model: "agentcompass/auto", profile: PROFILE, messages: [{ role: "user", content: "edit one function" }] };
    const ctx = { protocol: "chat", state: {}, options: { ...options, constraintModel: pin, routePerProvider: true } };
    middlewareOnRequest(body, ctx);
    const returned = middlewareOnProvider(body, { ...ctx, provider: { id: "acme-b" } });
    return { returned, body, route: ctx.state.route };
  };
  const other = tryOn("acme-a/gpt-6.1-sol");
  assert.equal(other.returned, undefined, "no route on acme-b for a model named on acme-a");
  assert.notEqual(other.body.model, "gpt-6.1-sol:high");
  const own = tryOn("acme-b/gpt-6.1-sol");
  assert.equal(own.body.model, "gpt-6.1-sol:high");
  const bare = tryOn("gpt-6.1-sol");
  assert.equal(bare.body.model, "gpt-6.1-sol:high", "a bare name: any preset will do");
});

test("a Magpie preset is a prefix of what it lists, by its own id and by the catalog it serves, in both stages", () => {
  const options = {
    catalog: {},
    candidateModels: [{ model: "opencode-zen/deepseek-v4-flash", efforts: ["high"] }, { model: "deepseek/deepseek-v4-flash", efforts: ["high"] }],
    modelsByProvider: { "opencode-zen": [{ model: "deepseek-v4-flash", efforts: ["high"] }] },
  };
  const request = (pin) => {
    const body = { model: "agentcompass/auto", profile: PROFILE, messages: [{ role: "user", content: "edit one function" }] };
    const ctx = { protocol: "chat", state: {}, options: { ...options, constraintModel: pin, routePerProvider: true } };
    middlewareOnRequest(body, ctx);
    return { body, ctx };
  };
  // onRequest: a list id is offered on its preset, so the catalog the preset serves names it
  assert.equal(request("opencode/deepseek-v4-flash").ctx.state.route.targetModel, "opencode-zen/deepseek-v4-flash");
  assert.equal(request("opencode-zen/deepseek-v4-flash").ctx.state.route.targetModel, "opencode-zen/deepseek-v4-flash");
  // onProvider: each name of the preset's list is offered on it, so the preset's own id names it
  const { body, ctx } = request("opencode-zen/deepseek-v4-flash");
  middlewareOnProvider(body, { ...ctx, provider: { id: "opencode-zen" } });
  assert.equal(body.model, "deepseek-v4-flash:high");
});

test("the task reads a named model as the pool reads it: a prefix that names nothing is dropped (task_intake.named_pin)", () => {
  const fleet = { models: MODELS, aliases: MODEL_ALIASES, families: FAMILIES, providerNames: PROVIDER_NAMES };
  const raw = { profile: PROFILE, constraints: { model: "opencode/deepseek-v4-flash" } };
  const read = (pool) => normalizeTask(raw, { models: MODELS, aliases: MODEL_ALIASES, pinPool: pool, fleet });
  const deepseek = [{ id: "ds", account: "g", provider: "deepseek", model: "deepseek/deepseek-v4-flash", effort: "high" }];
  const opencode = [...deepseek, { id: "oc", account: "g", provider: "opencode", model: "opencode/deepseek-v4-flash", effort: "high" }];
  assert.equal(read(deepseek).constraint_model, resolveModel("deepseek-v4-flash").key, "nothing is `opencode`: the bare name's row");
  assert.equal(read(opencode).constraint_model, "opencode/deepseek-v4-flash", "`opencode` names a bundle: kept");
  assert.equal(read(deepseek).constraint_raw_model, "opencode/deepseek-v4-flash", "what the user typed is kept beside it");
  assert.throws(() => normalizeTask({ profile: PROFILE, constraints: { model: "opencode/" } }, { models: MODELS, aliases: MODEL_ALIASES }), { code: "invalid_model_pin" });
  assert.throws(() => normalizeTask({ profile: PROFILE, constraints: { bundle: " " } }, { models: MODELS, aliases: MODEL_ALIASES }), { code: "invalid_model_pin" });
});

test("an exhausted bundle a bare name names is passed over for another of its row; a prefix that names it is refused, never replaced", () => {
  const win = (name, remaining, hours) => ({ name, remaining, used: 100 - remaining, resetHours: hours });
  const quotas = { "claude/a": { kind: "subscription", plan: "max", quota: { windows: [win("5 hours", 90, 3), win("7 days", 0, 100)] } } };
  const pool = [{ model: "claude-sonnet-5-5", efforts: ["high"] }, { model: "anthropic/claude-sonnet-5-5", provider: "openrouter", efforts: ["high"] }];
  for (const ordered of [pool, [...pool].reverse()]) {
    const run = (pin) => selectBestRoute(PROFILE, { now: T0_071, candidateModels: ordered, quotas, constraintModel: pin });
    const bare = run("claude-sonnet-5-5");
    assert.equal(bare.ok, true);
    assert.equal(bare.targetModel, "anthropic/claude-sonnet-5-5", "the bundle that can run");
    const prefixed = run("claude/claude-sonnet-5-5");
    assert.equal(prefixed.ok, false);
    assert.match(prefixed.refusal, /^pin_unavailable: /);
    assert.match(prefixed.warnings.join(" "), /exhausted|below launch floor/, "the named bundle's own reason");
  }
});

test("a host catalogue brings its own provider_names table; with its own models and none, no shipped declaration is read", () => {
  assert.equal(providerNamesOf(undefined), PROVIDER_NAMES);
  assert.equal(providerNamesOf({ aliases: {} }), PROVIDER_NAMES);
  assert.equal(providerNamesOf({ models: { m: {} } }), NO_PROVIDER_NAMES);
  const own = { defaults: {}, rows: { acme: { "custom-m": { model: null, status: "retired" } } } };
  assert.equal(providerNamesOf({ models: { m: {} }, providerNames: own }), own);
  const models = { "custom-m": { display_name: "Custom M" } };
  // a shipped declaration names rows this catalogue does not have: a score keyed by it lands on no row and is ignored
  const [moved] = Object.keys(PROVIDER_NAMES.defaults);
  assert.equal(resolveModelKey(moved, models, {}, PROVIDER_NAMES), moved);
  assert.deepEqual([...scoreLayer({ [moved]: { coding: { level: 2, as_of: "2026-11-19" } } }, models, {}, PROVIDER_NAMES).keys()], [moved]);
  const scores = { [moved]: { coding: 2 }, "custom-m": { coding: 3 } };
  assert.doesNotThrow(() => rankCandidates(PROFILE, { candidateModels: ["custom-m"], catalog: { models }, userScores: scores }));
  // the catalogue's own table is the one read: a pair it declares retired is that provider's own model ...
  const ranked = rankCandidates(PROFILE, { candidateModels: ["acme/custom-m"], catalog: { models, providerNames: own } });
  assert.ok(ranked.allCandidates.length > 0);
  for (const c of ranked.allCandidates) assert.equal(c.canonicalModel, "acme/custom-m");
  // ... and with its own models and no table, no declaration is read: the same pair is the catalogue's row by its name
  for (const c of rankCandidates(PROFILE, { candidateModels: ["acme/custom-m"], catalog: { models } }).allCandidates) assert.equal(c.canonicalModel, "custom-m");
  const [provider, name] = Object.entries(PROVIDER_NAMES.rows).flatMap(([p, n]) => Object.keys(n).filter((k) => n[k].model == null).map((k) => [p, k]))[0];
  const status = PROVIDER_NAMES.rows[provider][name].status;
  const warned = (catalog) => selectBestRoute(PROFILE, { candidateModels: [`${provider}/${name}`], catalog }).warnings.some((w) => w.includes(`(${status})`));
  assert.equal(warned(undefined), true, "the shipped table declares the pair");
  assert.equal(warned({ models }), false, "not read under a catalogue with its own models and no table");
});

test("a user score lands where its key's maker default says, the row's own id wins for its row, and the order of keys never matters", () => {
  const entry = (level) => ({ level, as_of: "2026-11-19" });
  for (const [, name] of DECLARED.filter(([p]) => !p)) {
    const row = PROVIDER_NAMES.defaults[name].model;
    assert.equal(resolveModelKey(name, FIVE_AXIS_MODELS_TABLE), row, name);
    // a provider's declaration is never read for a score: a provider-qualified key reads the default of its name
    for (const provider of Object.keys(PROVIDER_NAMES.rows)) assert.equal(resolveModelKey(`${provider}/${name}`, FIVE_AXIS_MODELS_TABLE), row, `${provider}/${name}`);
    // the row's own id wins where it lands on the row; the undated row of a moved name is reached by its repository id alone
    if (name === row || resolveModelKey(row, FIVE_AXIS_MODELS_TABLE) !== row) continue;
    const layer = { [name]: { coding: entry(1.1), creativity: entry(2.2) }, [row]: { coding: entry(2.9) } };
    const reversed = Object.fromEntries(Object.entries(layer).reverse());
    for (const doc of [layer, reversed]) assert.deepEqual(scoreLayer(doc, FIVE_AXIS_MODELS_TABLE).get(row), { coding: entry(2.9), creativity: entry(2.2) }, name);
  }
});

// ------------------------------------------------------------------------------------------------ round 6 (review R5-F1 to F6)

const R6_FLEET = { models: MODELS, aliases: MODEL_ALIASES, families: FAMILIES, providerNames: PROVIDER_NAMES };
const R6_POOL = [
  { model: "acme-a/gpt-6.1-sol", efforts: ["high"] },
  { model: "acme-b/gpt-6.1-sol", efforts: ["high"] },
  { model: "acme-c/claude-sonnet-5-5", efforts: ["high"] },
];
const r6Messages = (turn) => [{ role: "user", content: "edit one function" }, { role: "assistant", content: "ok" }, { role: "user", content: turn }].slice(0, turn ? 3 : 1);

/** A session held on `acme-b/gpt-6.1-sol` (its first turn named it), and the store it is held in. */
function r6WarmStore() {
  const store = new SessionContinuityStore();
  const ctx = { state: {}, options: { continuityStore: store, affinityMode: "session", candidateModels: R6_POOL, now: T0_071 } };
  middlewareOnRequest({ model: "agentcompass/auto", user: "r6", profile: PROFILE, pinned_model: "acme-b/gpt-6.1-sol", messages: r6Messages("") }, ctx);
  assert.equal(ctx.state.route.targetModel, "acme-b/gpt-6.1-sol", "the first turn runs what it named");
  return store;
}

test("R5-F1: a warm session keeps its hold only on a bundle the pin names in the pool; a malformed pin is refused before any hold, in every entry", async () => {
  // the rule: hold when the request names nothing, or when the held bundle is among those the pin names (`pinMatchingBundles`)
  const cases = [
    ["gpt-6.1-sol", { held: true }],
    ["acme-b/gpt-6.1-sol", { held: true }],
    ["acme-a/gpt-6.1-sol", { held: false, target: "acme-a/gpt-6.1-sol" }],
    ["acme-c/gpt-6.1-sol", { refused: "pin_" }],
    ["/gpt-6.1-sol", { refused: "invalid_model_pin" }],
    [0, { refused: "invalid_model_pin" }],
  ];
  for (const [pin, want] of cases) {
    // Mode A middleware
    const store = r6WarmStore();
    let rejected = null;
    const ctx = { state: {}, reject: (status, message) => { rejected = `${status} ${message}`; }, options: { continuityStore: store, affinityMode: "session", candidateModels: R6_POOL, now: T0_071 + 1000 } };
    middlewareOnRequest({ model: "agentcompass/auto", user: "r6", profile: PROFILE, pinned_model: pin, messages: r6Messages("turn 2") }, ctx);
    if (want.refused) {
      assert.match(String(rejected), new RegExp(`503 agentcompass: ${want.refused}`), `middleware ${JSON.stringify(pin)}`);
    } else {
      assert.equal(Boolean(ctx.state.route.continuation?.held), want.held, `middleware ${JSON.stringify(pin)}`);
      if (want.target) assert.equal(ctx.state.route.targetModel, want.target);
    }
    // hooks.js
    const hStore = r6WarmStore();
    const hctx = { state: {}, options: { continuityStore: hStore, affinityMode: "session", candidateModels: R6_POOL, now: T0_071 + 1000 } };
    await hooksOnRequest({ model: "agentcompass/auto", user: "r6", profile: PROFILE, pinned_model: pin, messages: r6Messages("turn 2") }, hctx);
    if (want.refused) {
      assert.match(String(hctx.state.routeBlocked?.refusal), new RegExp(`^${want.refused}`), `hooks ${JSON.stringify(pin)}`);
    } else {
      assert.equal(Boolean(hctx.state.route.continuation?.held), want.held, `hooks ${JSON.stringify(pin)}`);
      if (want.target) assert.equal(hctx.state.route.targetModel, want.target);
    }
  }
  // Mode B (/v1/systemone): the pins are read before the hold
  const store = new SessionContinuityStore();
  const options = { continuityStore: store, affinityMode: "session", candidateModels: ["acme-a/gpt-6.1-sol", "acme-b/gpt-6.1-sol"], now: T0_071 };
  const ask = (pin, now) => handleSystemOneRequest({ user: "r6b", messages: r6Messages(now ? "turn 2" : ""), state: { profile: PROFILE, pinned_model: pin }, questions: { effort: { type: "scale" } } }, { ...options, now: T0_071 + now });
  assert.equal((await ask("acme-b/gpt-6.1-sol", 0)).agentcompass.targetModel, "acme-b/gpt-6.1-sol");
  assert.equal((await ask("acme-a/gpt-6.1-sol", 1000)).agentcompass.targetModel, "acme-a/gpt-6.1-sol", "a pin that does not name the held bundle routes again");
  const malformed = (await ask("/gpt-6.1-sol", 2000)).agentcompass;
  assert.deepEqual([malformed.blocked, malformed.error], [true, "invalid_model_pin"]);
});

test("R5-F2: a seat's full id or its name as the prefix names that seat; the provider names every seat; none is substituted", () => {
  const win = (name, remaining, resetHours) => ({ name, remaining, used: 100 - remaining, resetHours });
  const seat = (sevenDay) => ({ kind: "subscription", plan: "max", quota: { windows: [win("5 hours", 90, 3), win("7 days", sevenDay, 100)] } });
  const candidateModels = [{ model: "claude-sonnet-5-5", efforts: ["high"] }];
  const run = (pin, quotas) => selectBestRoute(PROFILE, { now: T0_071, candidateModels, quotas, constraintModel: pin });
  const exhausted = { "claude/work": seat(0), "claude/personal": seat(90) };
  for (const pin of ["claude/work/claude-sonnet-5-5", "work/claude-sonnet-5-5", "Claude/Work/claude-sonnet-5-5:high"]) {
    const r = run(pin, exhausted);
    assert.deepEqual([r.ok, r.refusal?.split(":")[0]], [false, "pin_unavailable"], `${pin}: the named seat cannot run, none other stands in`);
  }
  for (const pin of ["claude-sonnet-5-5", "claude/claude-sonnet-5-5"]) {
    const r = run(pin, exhausted);
    assert.equal(r.selectedAccount, "claude/personal", `${pin}: every seat is named, the one that can run serves`);
  }
  // the longest id that matches is the prefix: a seat beats its provider
  const ample = { "claude/work": seat(90), "claude/personal": seat(90) };
  assert.equal(run("claude/work/claude-sonnet-5-5", ample).selectedAccount, "claude/work");
});

// Magpie's onAccount payload (`internal/middleware/account.go` 25-31, 58): `ref` a keyed hash of the login, `provider` the provider's
// id, `name` the provider's name (the same for every seat of it), `kind`, `model`. The quotas key a seat by its login.
const magpieAccount = (ref, name = "Claude") => ({ ref, provider: "claude", name, kind: "claude", model: "claude-sonnet-5-5" });
const REF_A = "0123456789abcdef0123456789abcdef";
const REF_B = "fedcba9876543210fedcba9876543210";

test("R6-F1: onAccount reads no seat from Magpie's account: a seat pin skips no account, and the provider's name is never a seat", () => {
  const win = (name, remaining, resetHours) => ({ name, remaining, used: 100 - remaining, resetHours });
  const seat = (sevenDay, extra = {}) => ({ kind: "subscription", plan: "max", quota: { windows: [win("5 hours", 90, 3), win("7 days", sevenDay, 100)] }, ...extra });
  const candidateModels = [{ model: "claude-sonnet-5-5", efforts: ["high"] }];
  const ample = { "claude/work": seat(90), "claude/personal": seat(90) };
  const decide = (quotas, pin, account) => {
    const decision = selectBestRoute(PROFILE, { now: T0_071, candidateModels, quotas, constraintModel: pin });
    assert.equal("pinnedAccounts" in decision, false, `${pin}: the decision names no seat for onAccount`);
    return middlewareOnAccount(account, { state: { route: decision, agentcompass: decision }, account, options: { quotas, now: T0_071 } });
  };
  for (const pin of ["claude/work/claude-sonnet-5-5", "work/claude-sonnet-5-5", "personal/claude-sonnet-5-5", "claude-sonnet-5-5"]) {
    for (const account of [magpieAccount(REF_A), magpieAccount(REF_B), magpieAccount(REF_A, "claude")]) {
      assert.equal(decide(ample, pin, account), undefined, `${pin} on ${account.ref}: no seat is skipped`);
    }
  }
  // a seat whose key is the provider's name: Magpie's name is not that seat, so that seat being out (disabled) skips no other seat
  const named = { "claude/claude": seat(90, { disabled: true }), "claude/work": seat(90) };
  for (const name of ["claude", "Claude"]) {
    assert.equal(decide(named, "claude/claude-sonnet-5-5", magpieAccount(REF_A, name)), undefined, `name ${name}`);
    assert.equal(decide(named, "claude-sonnet-5-5", magpieAccount(REF_B, name)), undefined, `name ${name}, bare pin`);
  }
});

test("R6-F2: a warm session keeps its hold under a pin only when the held route is named and can run: warm and cold answer the same", async () => {
  const win = (name, remaining, resetHours) => ({ name, remaining, used: 100 - remaining, resetHours });
  const seat = (sevenDay, extra = {}) => ({ kind: "subscription", plan: "max", quota: { windows: [win("5 hours", 90, 3), win("7 days", sevenDay, 100)] }, ...extra });
  const candidateModels = [{ model: "claude-sonnet-5-5", efforts: ["high"] }];
  const warm = async (quotas, pin) => {
    const base = { affinityMode: "session", candidateModels, quotas, now: T0_071 };
    const out = {};
    // middleware
    const store = new SessionContinuityStore();
    middlewareOnRequest({ model: "agentcompass/auto", user: "f2", profile: PROFILE, messages: r6Messages("") }, { state: {}, options: { ...base, continuityStore: store } });
    let rejected = null;
    const ctx = { state: {}, reject: (status, message) => { rejected = `${status} ${message}`; }, options: { ...base, continuityStore: store, now: T0_071 + 1000 } };
    middlewareOnRequest({ model: "agentcompass/auto", user: "f2", profile: PROFILE, pinned_model: pin, messages: r6Messages("turn 2") }, ctx);
    out.middleware = rejected ? rejected.split(": ")[1] : ctx.state.route.continuation?.held ? "held" : "routed";
    // hooks
    const hStore = new SessionContinuityStore();
    await hooksOnRequest({ model: "agentcompass/auto", user: "f2", profile: PROFILE, messages: r6Messages("") }, { state: {}, options: { ...base, continuityStore: hStore } });
    const hctx = { state: {}, options: { ...base, continuityStore: hStore, now: T0_071 + 1000 } };
    await hooksOnRequest({ model: "agentcompass/auto", user: "f2", profile: PROFILE, pinned_model: pin, messages: r6Messages("turn 2") }, hctx);
    out.hooks = hctx.state.routeBlocked ? hctx.state.routeBlocked.refusal.split(":")[0] : hctx.state.route.continuation?.held ? "held" : "routed";
    // Mode B
    const bStore = new SessionContinuityStore();
    const ask = (state, now, messages) => handleSystemOneRequest({ user: "f2b", messages, state: { profile: PROFILE, ...state }, questions: { effort: { type: "scale" } } }, { ...base, continuityStore: bStore, now: T0_071 + now });
    await ask({}, 0, r6Messages(""));
    const b = (await ask({ pinned_model: pin }, 1000, r6Messages("turn 2"))).agentcompass;
    out.modeB = b.blocked ? b.error : "served";
    // cold
    const cold = selectBestRoute(PROFILE, { candidateModels, quotas, now: T0_071, constraintModel: pin });
    out.cold = cold.ok ? "served" : cold.refusal.split(":")[0];
    return out;
  };
  const refusedEverywhere = { middleware: "pin_unavailable", hooks: "pin_unavailable", modeB: "pin_unavailable", cold: "pin_unavailable" };
  for (const quotas of [{ "claude/work": seat(90), "claude/personal": seat(0) }, { "claude/work": seat(90), "claude/personal": seat(90, { disabled: true }) }]) {
    assert.deepEqual(await warm(quotas, "claude/personal/claude-sonnet-5-5"), refusedEverywhere, "a named seat that cannot run is refused warm as cold");
    assert.deepEqual(await warm(quotas, "personal/claude-sonnet-5-5"), refusedEverywhere);
    const kept = await warm(quotas, "claude/work/claude-sonnet-5-5");
    assert.deepEqual([kept.middleware, kept.hooks, kept.cold], ["held", "held", "served"], "a named seat that can run keeps the hold");
  }
  // an effort pin on a held row: kept where the cold request serves it, refused with the same code where it refuses it. A family row
  // on a gateway with no effort table runs at any effort a pin names; on `claude` its effort table offers none of `high`, `low`.
  const onFamily = (row, pin) => {
    const family = [row, { model: "acme-a/gpt-6.1-sol", efforts: ["high"] }];
    const store = new SessionContinuityStore();
    const options = { continuityStore: store, affinityMode: "session", candidateModels: family, now: T0_071 };
    middlewareOnRequest({ model: "agentcompass/auto", user: "fam", profile: PROFILE, pinned_model: row, messages: r6Messages("") }, { state: {}, options });
    let rejected = null;
    const ctx = { state: {}, reject: (status, message) => { rejected = `${status} ${message}`; }, options: { ...options, now: T0_071 + 1000 } };
    middlewareOnRequest({ model: "agentcompass/auto", user: "fam", profile: PROFILE, pinned_model: pin, messages: r6Messages("turn 2") }, ctx);
    const cold = selectBestRoute(PROFILE, { candidateModels: family, now: T0_071, constraintModel: pin });
    return [rejected ? rejected.split(": ")[1] : ctx.state.route.continuation?.held ? "held" : "routed", cold.ok ? "served" : cold.refusal.split(":")[0]];
  };
  const seen = new Set();
  for (const [row, pin] of [["acme-b/claude-opus-9", "acme-b/claude-opus-9:high"], ["acme-b/claude-opus-9", "acme-b/claude-opus-9:low"], ["claude/claude-opus-9", "claude/claude-opus-9:high"], ["claude/claude-opus-9", "claude/claude-opus-9:low"]]) {
    const [warmAnswer, coldAnswer] = onFamily(row, pin);
    seen.add(coldAnswer === "served" ? "served" : "refused");
    // served cold: served warm, held where the pin names the held effort (`high`, the nominal effort of a row with none), else routed
    if (coldAnswer === "served") assert.equal(warmAnswer, pin.endsWith(":high") ? "held" : "routed", `${pin}: served warm as cold`);
    else assert.equal(warmAnswer, coldAnswer, `${pin}: refused warm as cold`);
  }
  assert.deepEqual([...seen].sort(), ["refused", "served"], "both branches are reached");
});

test("R7-F1: Mode B records and answers a held turn as onRequest does: the route as the candidates name it, kept by a pin naming it", async () => {
  const turns = (n) => Array.from({ length: 2 * n - 1 }, (_, i) => (i % 2 === 0 ? { role: "user", content: i === 0 ? "edit one function" : `turn ${i / 2 + 1}` } : { role: "assistant", content: "ok" }));
  for (const third of [{ pinned_model: "acme-b/gpt-6.1-sol" }, { pinned_effort: "high" }, { pinned_bundle: "acme-b/gpt-6.1-sol:high" }, {}]) {
    const store = new SessionContinuityStore();
    const options = { continuityStore: store, affinityMode: "session", candidateModels: R6_POOL, decisionProviderDetails: true };
    const ask = (state, n) => handleSystemOneRequest({ user: "r7", messages: turns(n), state: { profile: PROFILE, ...state }, questions: { effort: { type: "scale" } } }, { ...options, now: T0_071 + n * 1000 });
    const first = (await ask({ pinned_model: "acme-b/gpt-6.1-sol" }, 1)).agentcompass;
    assert.equal(first.targetModel, "acme-b/gpt-6.1-sol");
    const second = (await ask({}, 2)).agentcompass;
    assert.deepEqual([second.continuation.held, second.targetModel], [true, "acme-b/gpt-6.1-sol"], "held on the route as the candidates name it");
    const kept = store.get(second.continuation.sessionKey, T0_071 + 2000);
    assert.deepEqual([kept.lastHeld, kept.target, kept.turn], [true, "acme-b/gpt-6.1-sol", 2], "the held turn is recorded as routed");
    // the same held turn through onRequest answers the same route
    const mStore = new SessionContinuityStore();
    const mOptions = { continuityStore: mStore, affinityMode: "session", candidateModels: R6_POOL };
    middlewareOnRequest({ model: "agentcompass/auto", user: "r7m", profile: PROFILE, pinned_model: "acme-b/gpt-6.1-sol", messages: turns(1) }, { state: {}, options: { ...mOptions, now: T0_071 + 1000 } });
    const mctx = { state: {}, options: { ...mOptions, now: T0_071 + 2000 } };
    middlewareOnRequest({ model: "agentcompass/auto", user: "r7m", profile: PROFILE, messages: turns(2) }, mctx);
    assert.deepEqual([mctx.state.route.continuation?.held, mctx.state.route.targetModel], [true, second.targetModel]);
    const after = (await ask(third, 3)).agentcompass;
    assert.deepEqual([after.continuation?.held, after.targetModel], [true, "acme-b/gpt-6.1-sol"], `turn 3 ${JSON.stringify(third)}: a pin naming the held route keeps it`);
  }
  // the held effort gone from the pool: Mode B routes again with the session's own profile, as onRequest does (no classifier asked)
  const store = new SessionContinuityStore();
  const base = { continuityStore: store, affinityMode: "session", decisionProviderDetails: true };
  const ask = (state, n, candidateModels) => handleSystemOneRequest({ user: "r7g", messages: turns(n), state, questions: { effort: { type: "scale" } } }, { ...base, candidateModels, now: T0_071 + n * 1000 });
  await ask({ profile: PROFILE, pinned_model: "acme-b/gpt-6.1-sol" }, 1, R6_POOL);
  const gone = (await ask({}, 2, [{ model: "acme-b/gpt-6.1-sol", efforts: ["xhigh"] }])).agentcompass;
  assert.deepEqual([gone.continuation?.why, gone.targetModel, gone.targetEffort], ["effort_gone", "acme-b/gpt-6.1-sol", "xhigh"]);
});

test("R6-F4: an unchecked effort applies to the preset it was written on, not to the presets serving the same catalog", () => {
  for (const [a, b] of [["qwen", "qwen-cn"], ["qwen-cn", "qwencloud"], ["zai", "zhipu"], ["zhipu", "zai"], ["moonshot", "moonshot-cn"]]) {
    const pair = magpieOptions({ candidateModels: [{ model: `${a}/gpt-6.1-sol`, efforts: ["high"] }, { model: `${b}/gpt-6.1-sol`, effort: "high", disabled: true }] });
    assert.equal(selectBestRoute(PROFILE, pair).targetModel, `${a}/gpt-6.1-sol`, `unchecked on ${b}, offered on ${a}`);
    const own = magpieOptions({ candidateModels: [{ model: `${a}/gpt-6.1-sol`, efforts: ["high"] }, { model: `${a}/gpt-6.1-sol`, effort: "high", disabled: true }] });
    assert.equal(selectBestRoute(PROFILE, own).ok, false, `unchecked on ${a} itself`);
  }
});

test("R6-F5: the prefix is the longest leading part that names a bundle with the rest, then the shorter ones, then the drop", () => {
  const win = (name, remaining, resetHours) => ({ name, remaining, used: 100 - remaining, resetHours });
  const seat = { kind: "subscription", plan: "max", quota: { windows: [win("5 hours", 90, 3), win("7 days", 90, 100)] } };
  const candidateModels = [{ model: "work/custom-m", presets: ["claude"], provider: "gateway", efforts: ["high"] }, { model: "claude-sonnet-5-5", efforts: ["high"] }];
  const run = (pin) => selectBestRoute(PROFILE, { now: T0_071, candidateModels, quotas: { "claude/work": seat }, constraintModel: pin });
  assert.equal(run("claude/work/custom-m").targetModel, "work/custom-m", "the seat claude/work names no custom-m: the preset claude does");
  assert.equal(run("claude/work/claude-sonnet-5-5").selectedAccount, "claude/work", "the seat names its own row");
  assert.match(String(run("claude/work/gpt-6.1-sol").refusal), /^pin_not_in_pool/, "named by a prefix with no such row: refused, not dropped");
});

test("R6-F6: the engine's strip around `:effort`, and a list or object pin quoted as Python's repr", () => {
  // `\ufeff` is not space to Python: `\ufeff:medium` is a model `\ufeff` at medium, which replaces an earlier effort
  assert.equal(pinsFixEffort({ constraintModel: "\ufeff:medium" }), true);
  assert.deepEqual(mergePinOptions({ constraintEffort: "high" }, { constraintModel: "\ufeff:medium" }), { constraintModel: "\ufeff:medium" });
  assert.deepEqual(mergePinOptions({ constraintEffort: "high" }, { constraintModel: "gpt-6.1-sol:\x1cmedium\x85" }), { constraintModel: "gpt-6.1-sol:\x1cmedium\x85" });
  const circular = [1];
  circular.push(circular);
  const shown = [
    [["gpt-6.1-sol"], "['gpt-6.1-sol']"],
    [{ model: "gpt-6.1-sol" }, "{'model': 'gpt-6.1-sol'}"],
    [[1, true, null, "a'b", { k: [] }], `[1, True, None, "a'b", {'k': []}]`],
    [circular, "[1, [...]]"],
  ];
  for (const [value, repr] of shown) assert.equal(modelPinProblem(value), `invalid_model_pin: model ${repr} must be a non-empty model name.`);
});

test("R5-F3: an unchecked row listed on a preset turns its effort off on that preset only; a bare unchecked row on every row of the account", () => {
  const route = (candidateModels, options = {}) => selectBestRoute(PROFILE, { candidateModels, ...options });
  const onOther = route([{ model: "openrouter/gpt-6.1-sol", efforts: ["high"] }, { model: "acme-disabled/gpt-6.1-sol", disabled: true, efforts: ["high"] }]);
  assert.equal(onOther.targetModel, "openrouter/gpt-6.1-sol", "the unchecked row is on another preset");
  const bare = route([{ model: "openrouter/gpt-6.1-sol", efforts: ["high"] }, { model: "gpt-6.1-sol", effort: "high", disabled: true }]);
  assert.equal(bare.ok, false, "a bare unchecked row turns the effort off across the account");
  const sameName = route([{ model: "acme-a/gpt-6.1-sol", efforts: ["high"] }, { model: "acme-a/gpt-6.1-sol", effort: "high", disabled: true }]);
  assert.equal(sameName.ok, false, "on its own preset");
  // under the Magpie adapter the preset of a list id is its `presets`
  const magpie = magpieOptions({ candidateModels: [{ model: "acme-a/gpt-6.1-sol", efforts: ["high"] }, { model: "acme-b/gpt-6.1-sol", effort: "high", disabled: true }] });
  assert.equal(route(magpie.candidateModels, magpie).targetModel, "acme-a/gpt-6.1-sol");
});

test("R5-F4: one boundary for 'is a pin given' and one for its problem; never a throw, the engine's strip, a falsy non-string refused", () => {
  for (const absent of [undefined, null, ""]) assert.equal(pinGiven(absent), false);
  for (const given of [0, false, NaN, " ", [], {}]) assert.equal(pinGiven(given), true, String(given));
  const circular = {};
  circular.self = circular;
  for (const odd of [10n, circular, Object.create(null), Symbol("x"), () => 1]) {
    assert.match(modelPinProblem(odd), /^invalid_model_pin: model .* must be a non-empty model name\.$/);
    const refused = selectBestRoute(PROFILE, { candidateModels: ["gpt-6.1-sol"], constraintModel: odd });
    assert.deepEqual([refused.ok, refused.error], [false, "invalid_model_pin"]);
  }
  // Python's strip: `\x1c`..`\x1f` and `\x85` are space, `﻿` is not
  for (const space of ["\x1c", "\x1f", "\x85", " ", "　"]) {
    assert.equal(pyStrip(`${space}gpt-6.1-sol${space}`), "gpt-6.1-sol");
    assert.ok(modelPinProblem(space));
  }
  assert.equal(pyStrip("﻿gpt"), "﻿gpt");
  assert.equal(modelPinProblem("﻿"), null);
  // a falsy non-string is a pin, refused at every entry
  for (const pin of [0, false, NaN]) {
    const refused = selectBestRoute(PROFILE, { candidateModels: ["gpt-6.1-sol"], constraintModel: pin });
    assert.deepEqual([refused.ok, refused.error], [false, "invalid_model_pin"], `selectBestRoute ${String(pin)}`);
    let rejected = null;
    middlewareOnRequest(
      { model: "agentcompass/auto", profile: PROFILE, pinned_model: pin, messages: r6Messages("") },
      { state: {}, reject: (status, message) => { rejected = `${status} ${message}`; }, options: { candidateModels: ["gpt-6.1-sol"] } },
    );
    assert.match(String(rejected), /503 agentcompass: invalid_model_pin/, `middleware ${String(pin)}`);
  }
  // a malformed bundle pin is refused as malformed, not as missing
  for (const field of ["pinnedBundle", "constraintBundle"]) {
    const refused = selectBestRoute(PROFILE, { candidateModels: ["gpt-6.1-sol"], [field]: "openai/" });
    assert.deepEqual([refused.ok, refused.error], [false, "invalid_model_pin"], field);
  }
});

test("R5-F5: onProvider judges a prefix over every other preset's rows, from candidateModels and from modelsByProvider", () => {
  // no candidateModels: every model is routed, and onRequest's pool is the requested name alone
  const options = { catalog: {}, routeAllModels: true, routePerProvider: true, modelsByProvider: { "acme-a": [{ model: "gpt-6.1-sol", efforts: ["high"] }], "acme-b": [{ model: "gpt-6.1-sol", efforts: ["high"] }] } };
  const tryOn = (pin, preset) => {
    const body = { model: "gpt-6.1-sol", profile: PROFILE, pinned_model: pin, messages: r6Messages("") };
    const ctx = { protocol: "chat", state: {}, options };
    middlewareOnRequest(body, ctx);
    const returned = middlewareOnProvider(body, { ...ctx, provider: { id: preset } });
    return { returned, body };
  };
  assert.equal(tryOn("acme-a/gpt-6.1-sol", "acme-b").returned, undefined, "named on acme-a: acme-b's list does not rewrite it");
  assert.equal(tryOn("acme-a/gpt-6.1-sol", "acme-a").body.model, "gpt-6.1-sol:high");
  assert.equal(tryOn("gpt-6.1-sol", "acme-b").body.model, "gpt-6.1-sol:high", "a bare name: any preset");
  // candidateOffers reads the other presets' rows with the pool, so a route named elsewhere is not offered here
  const here = [{ model: "gpt-6.1-sol", efforts: ["high"], presets: ["acme-b"], served: ["acme-b"] }];
  const there = [{ model: "gpt-6.1-sol", efforts: ["high"], presets: ["acme-a"], served: ["acme-a"] }];
  assert.equal(candidateOffers(here, "acme-a/gpt-6.1-sol", "high", {}, undefined, there), false);
  assert.equal(candidateOffers(here, "gpt-6.1-sol", "high", {}, undefined, there), true);
  // in onProvider: the route onRequest chose on acme-a is not offered by acme-b's list, so acme-b routes its own row
  const both = { catalog: {}, candidateModels: [{ model: "acme-a/gpt-6.1-sol", efforts: ["high"] }], modelsByProvider: options.modelsByProvider };
  const chosen = { ok: true, targetModel: "acme-a/gpt-6.1-sol", targetEffort: "high", profile: PROFILE, hasExplicitCandidates: true, canRewriteModel: true, pins: {} };
  const state = { agentcompass: { ...chosen }, route: { ...chosen } };
  const body = { model: "acme-a/gpt-6.1-sol", messages: r6Messages("") };
  middlewareOnProvider(body, { protocol: "chat", state, options: both, provider: { id: "acme-b" } });
  assert.equal(state.route.targetModel, "gpt-6.1-sol", "acme-b's own row, not the route chosen on acme-a");
});

test("R5-F6: the exported pinNamesBundle obeys the prefix over its pool (account_fleet.pin_names_bundle); identity alone is pinMatchesIdentity", () => {
  const codex = { id: "cx", account: "acct-c", provider: "codex", model: "gpt-6.1-sol", effort: "high" };
  const pi = { id: "pi", account: "acct-p", provider: "pi", model: "openai/gpt-6.1-sol", effort: "high" };
  assert.equal(pinMatchesIdentity("openai/gpt-6.1-sol", codex, R6_FLEET), true, "the same row, no prefix test");
  assert.equal(pinNamesBundle("openai/gpt-6.1-sol", codex, R6_FLEET, [codex, pi]), false, "the prefix names pi's spelling only");
  assert.equal(pinNamesBundle("openai/gpt-6.1-sol", pi, R6_FLEET, [codex, pi]), true);
  assert.equal(pinNamesBundle("openai/gpt-6.1-sol", codex, R6_FLEET), true, "alone in its pool, the unknown prefix is dropped");
});
