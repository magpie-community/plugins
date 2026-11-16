#!/usr/bin/env bun
// Tern agent plugin — start-up sync for omp's config folder.
//
// magpie loads this file as the plugin's Bun main (package.json "main"). It
// never picks the model and never writes models.yml: tern.agent.js's connect()
// owns models.yml, and magpie's own CLI owns modelRoles.default. This file
// only fixes up the two things omp cannot do for itself:
//
//   1. `config.yaml` -> `config.yml`
//      omp 18.x reads config.yml. A user coming from an older omp may still
//      have config.yaml; if magpie wrote a fresh config.yml next to it, omp
//      would read the new file and silently lose plan/theme/modelRole settings.
//      The old file is backed up to config.yaml.magpie-backup, then renamed.
//
//   2. `enabledModels` merge
//      When (and only when) the user already has a non-empty enabledModels
//      list, append `magpie/**` so the magpie models appear in omp's model
//      picker. An absent or empty list means "no filter" to omp, so creating
//      one would wrongly hide every non-magpie model. The edit is textual and
//      minimal: existing entries, quoting and comments stay untouched.
//
// The sync also runs once when magpie loads the module (a command-line plugin
// host can be short-lived), then 500 ms after the host starts and every 10 s.
// Timers are unref'd so they never keep a one-shot host alive.
// TERN_SYNC_DISABLE=1 turns all of it off (used by the tests). Errors are
// logged, never thrown: a bad config must not break the plugin host.

import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TAG = "[tern-sync]";
const MAGPIE_GLOB = "magpie/**";
const SYNC_INTERVAL_MS = 10_000;
const FIRST_SYNC_DELAY_MS = 500;

function log(message) {
  console.log(`${TAG} ${message}`);
}

function error(message, err) {
  console.error(`${TAG} ${message}: ${err instanceof Error ? err.stack || err.message : String(err)}`);
}

// omp resolves ~ with os.homedir(): USERPROFILE on Windows, HOME elsewhere.
// Prefer the same variable so the plugin writes exactly where omp reads.
function ompAgentDir() {
  const home =
    process.platform === "win32"
      ? process.env.USERPROFILE || homedir()
      : process.env.HOME || homedir();
  return join(home, ".omp", "agent");
}

// ---------------------------------------------------------------- migrate ---

function sameBytes(a, b) {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * If config.yaml exists and config.yml does not, back up the old file and
 * rename it, leaving the bytes untouched. An existing backup is never
 * overwritten; if its content differs from the current config.yaml, a
 * timestamped backup is written beside it instead.
 */
function migrateConfigYaml(agentDir) {
  const from = join(agentDir, "config.yaml");
  const to = join(agentDir, "config.yml");
  if (!existsSync(from)) return { migrated: false, reason: "no config.yaml" };
  if (existsSync(to)) return { migrated: false, reason: "config.yml already exists" };

  let backup = `${from}.magpie-backup`;
  if (existsSync(backup) && !sameBytes(from, backup)) {
    backup = `${from}.magpie-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  }
  try {
    if (!existsSync(backup)) copyFileSync(from, backup);
    renameSync(from, to);
    log(`migrated config.yaml -> config.yml (backup: ${backup})`);
    return { migrated: true, backup };
  } catch (err) {
    error("could not migrate config.yaml", err);
    return { migrated: false, reason: String(err) };
  }
}

// ----------------------------------------------------------- enabledModels ---

const KEY_RE = /^(["']?)enabledModels\1[ \t]*:/;

function stripComment(value) {
  // YAML comments start at # only when preceded by whitespace (or at the
  // start of the value). Good enough for one-line list entries.
  let quote = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (quote === '"' && ch === "\\") i++;
      else if (ch === quote) {
        if (quote === "'" && value[i + 1] === "'") i++;
        else quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i);
    }
  }
  return value;
}

function unquote(value) {
  const s = value.trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function isMagpieItem(item) {
  const value = unquote(stripComment(item));
  return value === MAGPIE_GLOB;
}

/**
 * Scan a flow sequence starting at `open` (the "[" index). Returns the
 * matching "]" index, the scalar items, whether the list is empty, whether it
 * already covers magpie, and the insertion point after the last significant
 * character (comments ignored).
 */
function scanFlowList(text, open) {
  let quote = null;
  let comment = false;
  let depth = 0;
  let close = -1;
  let current = "";
  const items = [];
  let lastSignificant = -1;

  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (comment) {
      if (ch === "\n") comment = false;
      continue;
    }
    if (quote) {
      current += ch;
      if (!/\s/.test(ch)) {
        lastSignificant = i;
      }
      if (quote === '"' && ch === "\\") {
        current += text[++i] ?? "";
        lastSignificant = i;
      } else if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") current += text[++i];
        else quote = null;
        lastSignificant = i;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      lastSignificant = i;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      comment = true;
      continue;
    }
    if (ch === "[") {
      depth++;
      if (depth === 1) continue;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (ch === "," && depth === 1) {
      if (current.trim()) items.push(current);
      current = "";
      lastSignificant = i;
      continue;
    }
    if (!/\s/.test(ch)) {
      lastSignificant = i;
    }
    current += ch;
  }

  if (current.trim()) items.push(current);
  return {
    close,
    items,
    empty: items.length === 0,
    hasMagpie: items.some(isMagpieItem),
    insertAt: lastSignificant + 1,
  };
}

/**
 * Absolute offsets (in `text`) at which each line from
 * `text.split(/\r?\n/)` starts. `scanFlowList` searches the whole file, so
 * every match it makes must be a file offset, never a column in a line.
 */
function lineStartOffsets(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/**
 * File offset of the first `[` on line `index`, or -1 when the line has none
 * or the computed offset does not really point at `[`. `from` skips the key
 * itself so a bracket earlier in the line cannot be mistaken for the list.
 */
function flowOpenOffset(text, lines, starts, index, from = 0) {
  const column = lines[index].indexOf("[", from);
  if (column < 0) return -1;
  const offset = starts[index] + column;
  return text[offset] === "[" ? offset : -1;
}

function flowInsertion(text, info) {
  const before = text.slice(0, info.insertAt);
  const last = before.length ? before[before.length - 1] : "";
  if (last === "[") return ` ${MAGPIE_GLOB}`;
  if (last === ",") return ` ${MAGPIE_GLOB}`;
  return `, ${MAGPIE_GLOB}`;
}

/**
 * Merge `magpie/**` into an existing non-empty enabledModels list.
 * Returns { changed, reason }. Comments, quoting and unrelated lines are
 * preserved; the file is only written when something actually changed.
 */
function mergeEnabledModels(configPath) {
  if (!existsSync(configPath)) return { changed: false, reason: "config.yml missing" };

  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err) {
    error(`could not read ${configPath}`, err);
    return { changed: false, reason: "read failed" };
  }

  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  if (bom) text = text.slice(1);

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);

  let keyLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (KEY_RE.test(lines[i])) {
      keyLine = i;
      break;
    }
  }
  if (keyLine === -1) return { changed: false, reason: "no enabledModels" };

  const keyMatch = lines[keyLine].match(KEY_RE);
  const afterColon = lines[keyLine].slice(keyMatch[0].length);
  const inlineValue = stripComment(afterColon).trim();
  const starts = lineStartOffsets(text);

  // ---- flow list ----
  let flow = null;
  if (inlineValue.startsWith("[")) {
    // scanFlowList walks the whole file, so translate the line-local column
    // into an offset in `text`; a raw column would start scanning in the
    // lines above and treat their text as the first list item (P1/P2).
    const open = flowOpenOffset(text, lines, starts, keyLine, keyMatch[0].length);
    if (open < 0) return { changed: false, reason: "could not locate flow list" };
    flow = scanFlowList(text, open);
  } else if (inlineValue === "") {
    // A flow list may start on the next non-blank, non-comment line.
    for (let i = keyLine + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t || t.startsWith("#")) continue;
      if (t.startsWith("[")) {
        const open = flowOpenOffset(text, lines, starts, i);
        if (open < 0) return { changed: false, reason: "could not locate flow list" };
        flow = scanFlowList(text, open);
      }
      break;
    }
  }

  if (flow) {
    if (flow.close < 0) return { changed: false, reason: "unterminated flow list" };
    if (flow.empty) return { changed: false, reason: "empty flow list" };
    if (flow.hasMagpie) return { changed: false, reason: "already lists magpie" };
    const updated = text.slice(0, flow.insertAt) + flowInsertion(text, flow) + text.slice(flow.insertAt);
    return writeIfChanged(configPath, bom + updated, "flow list", bom + text);
  }

  // ---- block list ----
  if (inlineValue !== "") return { changed: false, reason: `unrecognised enabledModels value: ${inlineValue.slice(0, 40)}` };

  const itemRe = /^([ \t]*)-[ \t]+(.*)$/;
  let lastItem = -1;
  let lastIndent = "";
  let hasMagpie = false;
  for (let i = keyLine + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) {
      // Blank lines and comments may sit inside or after the block; remember
      // nothing, keep scanning until a real non-item line shows up.
      continue;
    }
    const m = line.match(itemRe);
    if (!m) break;
    // A block scalar item (`- |`, `- >-`) continues on the following lines;
    // inserting after its first line would corrupt it. Leave such a file to
    // the user rather than guess.
    if (/^[|>]/.test(m[2].trim())) {
      return { changed: false, reason: "block scalar enabledModels item" };
    }
    lastItem = i;
    lastIndent = m[1];
    if (isMagpieItem(m[2])) hasMagpie = true;
  }

  if (lastItem === -1) return { changed: false, reason: "empty block list" };
  if (hasMagpie) return { changed: false, reason: "already lists magpie" };

  const itemLine = `${lastIndent}- ${MAGPIE_GLOB}`;
  const updatedLines = [...lines];
  updatedLines.splice(lastItem + 1, 0, itemLine);
  return writeIfChanged(configPath, bom + updatedLines.join(eol), "block list", bom + text);
}

function writeIfChanged(configPath, next, kind, original) {
  try {
    const before = readFileSync(configPath, "utf8");
    if (before !== original) {
      // Someone (the user's editor, magpie itself) wrote the file between our
      // read and this write. Leave it alone; the next heartbeat re-reads it.
      return { changed: false, reason: "file changed while syncing" };
    }
    if (before === next) return { changed: false, reason: "already up to date" };
    writeFileSync(configPath, next, "utf8");
    log(`enabledModels: added ${MAGPIE_GLOB} (${kind})`);
    return { changed: true, kind };
  } catch (err) {
    error(`could not write ${configPath}`, err);
    return { changed: false, reason: "write failed" };
  }
}

// ---------------------------------------------------------------- runner ---

function syncOnce() {
  const agentDir = ompAgentDir();
  if (!existsSync(agentDir)) return { migrated: false, merged: false, reason: "omp agent dir missing" };

  const migration = migrateConfigYaml(agentDir);
  const configPath = join(agentDir, "config.yml");
  const merge = mergeEnabledModels(configPath);
  return { migrated: migration.migrated, merged: merge.changed, migration, merge };
}

function start() {
  if (process.env.TERN_SYNC_DISABLE === "1") return;
  const first = setTimeout(() => {
    try {
      syncOnce();
    } catch (err) {
      error("initial sync failed", err);
    }
  }, FIRST_SYNC_DELAY_MS);
  if (typeof first.unref === "function") first.unref();

  const timer = setInterval(() => {
    try {
      syncOnce();
    } catch (err) {
      error("sync failed", err);
    }
  }, SYNC_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

// magpie's plugin host loads package.json "main" as an OpenCode plugin
// module (that is how a package gets a Bun process beside its moejs agent
// module). It calls every exported function as a plugin, so keep exactly one:
// this no-op. It also gives the first sync a deterministic run on hosts that
// are too short-lived for the 500 ms timer.
export default async function ternSyncPlugin() {
  if (process.env.TERN_SYNC_DISABLE === "1") return {};
  try {
    syncOnce();
  } catch (err) {
    error("initial sync failed", err);
  }
  return {};
}

// Non-function export: magpie's host calls every exported function as a
// plugin, and an object is ignored. The unit tests use these with explicit
// paths, so they never touch the real ~/.omp.
export const _internal = { mergeEnabledModels, migrateConfigYaml, syncOnce };

start();
