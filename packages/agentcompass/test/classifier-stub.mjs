/**
 * The answers a classifier gives in these tests. Routing starts from a task profile and nothing in `src/` reads a task's
 * text, so a test that sends a text says what the classifier answered for it here (`fixtures/classifier-answers.json`).
 * The answers began as a snapshot of what the deterministic profiler removed from `src/` said for each text, so that the
 * assertions on routing stayed as they were; they are fixtures, and any of them can be edited by hand.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Hex } from "../src/continuity.js";
import { extractRequestFacts } from "../src/profiler-core.js";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "classifier-answers.json");
const answers = JSON.parse(fs.readFileSync(FILE, "utf8"));

const INPUT_FIELDS = ["objective", "work_kind", "difficulty", "needs", "multi_task", "task_count", "expected_hours", "hours", "context", "cwd"];

function keyOf(task) {
  const input = {};
  for (const field of INPUT_FIELDS) {
    if (task?.[field] !== undefined) input[field] = task[field];
  }
  const key = JSON.stringify(input);
  return key.length > 240 ? `${key.slice(0, 120)}#${sha256Hex(key)}` : key;
}

/** The classifier's answer for a task (`{ objective, ... }`) or a text. */
export function classifierAnswer(task) {
  const input = typeof task === "string" ? { objective: task } : task;
  const key = keyOf(input);
  const answer = answers[key];
  if (!answer) throw new Error(`no classifier answer in fixtures/classifier-answers.json for ${key}`);
  return structuredClone(answer);
}

const classifierConfigured = (options) => options?.allowExternalScorer || options?.scorer?.allowExternalScorer;

/** A hook or middleware request sent the way a client does, with the classifier's answer for its text on `ctx`. */
export function answerRequest(body, ctx) {
  if (!body || typeof body !== "object" || Array.isArray(body) || ctx.profile || classifierConfigured(ctx.options)) return;
  const { objective } = extractRequestFacts(body, ctx);
  if (objective) ctx.profile = classifierAnswer(objective);
}

/** A `/v1/systemone` request with the classifier's answer for its text in `state`. */
export function answerSystemOne(body, options) {
  const state = body?.state || {};
  const text = typeof state.message === "string" ? state.message : typeof state.turn === "string" ? state.turn : state.task?.objective;
  if (typeof text !== "string" || state.kinds || state.profile || state.task?.profile || classifierConfigured(options)) return body;
  return { ...body, state: { ...state, profile: classifierAnswer(text) } };
}
