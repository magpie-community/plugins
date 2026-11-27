// Thin wrapper around the installed `gflow` CLI (this repo's Python CLI).
// The plugin never re-implements auth / BatchExecute / Flow API: it shells
// out to `gflow ... --json` and returns small, structured results (file
// paths + asset metadata, never base64 blobs).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const stripAnsi = (s) => String(s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

export const gflowBin = (o = {}) => o.gflowBin || process.env.GFLOW_BIN || "gflow";
export const gflowCwd = (o = {}) => o.cwd || process.env.GFLOW_CWD || process.cwd();

export async function runGflow(args, { timeoutMs = 120_000, options = {} } = {}) {
  try {
    const { stdout, stderr } = await run(gflowBin(options), args, {
      cwd: gflowCwd(options), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    return { code: 0, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) };
  } catch (e) {
    if (e.code === "ENOENT") {
      throw new Error(
        `gflow CLI not found on PATH (tried "${gflowBin(options)}"). Install it first: cd google-flow-cli && pip install -e . — or set GFLOW_BIN / plugin option gflowBin to its path.`);
    }
    const out = stripAnsi(`${e.stdout || ""}\n${e.stderr || ""}`).trim();
    const err = new Error(`gflow ${args.join(" ")} failed (exit ${e.code ?? "?"}): ${out.slice(-800) || e.message}`);
    err.stdout = stripAnsi(e.stdout || ""); err.stderr = stripAnsi(e.stderr || ""); err.exitCode = e.code;
    throw err;
  }
}

// gflow --json prints rich "Saved: ..." lines to stdout before the JSON,
// so take the last {...} / [...] block and parse that.
export function extractJson(text, label) {
  const clean = stripAnsi(text);
  for (const [open, close] of [["{", "}"], ["[", "]"]]) {
    const start = clean.lastIndexOf(`\n${open}`);
    const end = clean.lastIndexOf(close);
    if (start >= 0 && end > start) {
      try { return JSON.parse(clean.slice(start + 1, end + 1)); } catch { /* try the other bracket */ }
    }
  }
  throw new Error(`Could not parse ${label} JSON output from gflow: ${clean.slice(-500)}`);
}

export async function checkAuth(options = {}) {
  const r = await runGflow(["auth", "--status"], { timeoutMs: 60_000, options });
  const text = `${r.stdout}\n${r.stderr}`.trim();
  return { authenticated: /Authenticated/.test(text) && !/Not authenticated/.test(text), raw: text };
}

// _get_client() in gflow/cli/main.py auto-launches an interactive browser
// login when unauthenticated — that must never happen inside an agent
// tool call (it would hang). Pre-check and fail with a manual step instead.
export async function requireAuth(options = {}) {
  let s;
  try { s = await checkAuth(options); }
  catch (e) { throw new Error(`Could not check gflow auth (${e.message}). Run 'gflow auth --status' in a terminal first.`); }
  if (!s.authenticated) {
    throw new Error(`gflow is not authenticated. Run 'gflow auth' in a terminal (interactive Google login), then retry. Status: ${s.raw.slice(0, 300)}`);
  }
  return s;
}

export function check(schema, args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new Error("Expected object arguments");
  const props = schema.properties ?? {};
  for (const k of schema.required ?? []) if (args[k] === undefined || args[k] === null) throw new Error(`Missing required argument: ${k}`);
  for (const [k, v] of Object.entries(args)) {
    if (!Object.hasOwn(props, k)) throw new Error(`Unknown argument: ${k}`);
    if (v === undefined || v === null) continue;
    const s = props[k];
    if (s.type === "integer" && !Number.isInteger(v)) throw new Error(`Invalid integer argument: ${k}`);
    if (s.type === "number" && (typeof v !== "number" || !Number.isFinite(v))) throw new Error(`Invalid number argument: ${k}`);
    if (s.type === "string" && typeof v !== "string") throw new Error(`Invalid string argument: ${k}`);
    if (s.type === "boolean" && typeof v !== "boolean") throw new Error(`Invalid boolean argument: ${k}`);
    if (s.enum && !s.enum.includes(v)) throw new Error(`Unsupported argument value: ${k} (expected one of ${s.enum.join(", ")})`);
    if (s.minimum !== undefined && v < s.minimum) throw new Error(`Invalid argument: ${k} must be >= ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) throw new Error(`Invalid argument: ${k} must be <= ${s.maximum}`);
  }
  return args;
}

export const stripAsset = (a) => ({
  id: a?.id ?? "", name: a?.name ?? "", asset_type: a?.asset_type ?? a?.assetType ?? "",
  prompt: a?.prompt ?? "", model: a?.model ?? "", width: a?.width ?? 0, height: a?.height ?? 0,
  duration_seconds: a?.duration_seconds ?? 0, url: a?.url ?? "",
});
export const absPaths = (files, options = {}) => (files ?? []).map((f) => resolve(gflowCwd(options), f));
export const savedFiles = (files, options = {}) => absPaths(files, options).map((p) => ({ path: p, exists: existsSync(p) }));
